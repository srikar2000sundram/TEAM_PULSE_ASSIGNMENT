# 07. Identity Service

Sign-in, sessions, users, teams and memberships. Every other service trusts the access tokens it
issues, so this is the most security-critical service in the platform.

- Code: [`services/identity`](../../services/identity/README.md)
- API reference: [docs/api/identity.md](../api/identity.md) and the generated
  [`identity.openapi.json`](../api/identity.openapi.json)

## Layers

```mermaid
flowchart LR
    subgraph inbound["Inbound adapter"]
        routes["HTTP routes<br/>defineRoute + zod contracts"]
    end

    subgraph core["Application core: no framework imports"]
        uc["Use cases<br/>Login, RefreshSession, CreateUser, ..."]
        dom["Domain<br/>User, RefreshToken, Email, password policy"]
        ports["Ports<br/>UnitOfWork, PasswordHasher, AccessTokenIssuer, ..."]
    end

    subgraph outbound["Outbound adapters"]
        pg["PostgreSQL repositories<br/>pg driver"]
        argon["Argon2id hasher"]
        jwt["RS256 token issuer<br/>KeyRing and JWKS"]
        opaque["Opaque token generator"]
    end

    routes --> uc
    uc --> dom
    uc --> ports
    pg -. "implements" .-> ports
    argon -. "implements" .-> ports
    jwt -. "implements" .-> ports
    opaque -. "implements" .-> ports
```

ESLint fails the build if `domain/` or `application/` import Fastify, `pg`, the AWS SDK or anything
under `adapters/`.

## Login

```mermaid
sequenceDiagram
    autonumber
    actor U as Browser
    participant R as HTTP routes
    participant L as Login use case
    participant DB as PostgreSQL
    participant H as Argon2id

    U->>R: POST /auth/login email + password
    R->>R: rate limit 10 per minute per client
    R->>L: execute
    L->>DB: find user by email, short read
    alt unknown email, locked or disabled
        L->>H: verify against the decoy hash
        L-->>U: 401 invalid_credentials
    else active account
        L->>H: verify password, no transaction held open
        L->>DB: BEGIN, re-read user FOR UPDATE
        alt wrong password
            L->>DB: increment failed attempts, lock at 5, COMMIT
            L-->>U: 401 invalid_credentials
        else correct password
            L->>DB: reset counters, insert refresh token, COMMIT
            L-->>U: 200 access token, Set-Cookie refresh token
        end
    end
```

Design points:

- **Identical failures.** Unknown email, wrong password, locked and disabled accounts return the
  same status, code and message, so responses reveal nothing about which accounts exist.
- **No timing oracle.** When there is no usable account the server still performs one Argon2 verify
  against a decoy hash, so all failures take about the same time.
- **Lockout cannot be bypassed in parallel.** The failure counter is updated under a row lock
  (`SELECT ... FOR UPDATE`) on fresh state, so simultaneous guesses are counted one after another.
- **Hashing happens outside the transaction**, so no connection or lock is held during the
  slow CPU work.

## Account lockout

```mermaid
stateDiagram-v2
    [*] --> Active
    Active --> Active: wrong password, counter below 5
    Active --> Locked: 5th consecutive failure
    Locked --> Active: lockout period ends, 15 minutes
    Active --> Active: correct password, counter reset
    Active --> Disabled: administrator disables
    Disabled --> Active: administrator enables
    Locked --> Locked: attempts while locked are ignored
```

## Refresh tokens: rotation and theft detection

Each login starts a **family** of refresh tokens. Every refresh exchanges the current token for a
new one in the same family.

```mermaid
stateDiagram-v2
    [*] --> Valid: login or rotation issues it
    Valid --> Rotated: exchanged for a successor
    Valid --> Revoked: logout, password change
    Valid --> Expired: past its 7 day lifetime
    Rotated --> Rotated: replayed within 10 seconds, benign race, 409
    Rotated --> FamilyRevoked: replayed after 10 seconds, theft assumed
    FamilyRevoked --> [*]
    Revoked --> [*]
    Expired --> [*]
```

```mermaid
sequenceDiagram
    autonumber
    participant Client as Legitimate client
    participant Thief as Attacker with a copied cookie
    participant S as Identity Service

    Client->>S: refresh with token A
    S-->>Client: new token B, A is marked rotated
    Note over Thief: later, replays the stolen token A
    Thief->>S: refresh with token A
    S->>S: A was already rotated, and not moments ago
    S->>S: revoke the whole family, A and B
    S-->>Thief: 401
    Client->>S: refresh with token B
    S-->>Client: 401, sign in again
```

| Rule                                            | Why                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Secrets are 256-bit random, hashed with SHA-256 | A database leak does not reveal usable tokens; slow hashing adds nothing for random input |
| Rotation locks the row (`FOR UPDATE`)           | Two simultaneous refreshes of one token cannot both succeed and fork the family           |
| 10 second grace for a rotated token             | Two browser tabs refreshing together are a race, not theft: answered 409, family kept     |
| 30 day absolute family age                      | Constant use cannot keep one login alive forever                                          |
| Password change revokes every family            | Signs out whoever else had access                                                         |
| Cookie `Path=/api/v1/identity/auth`             | The browser sends it only to the endpoints that need it                                   |

## Cookie and CSRF defences

The refresh cookie is the only credential the browser stores. It is protected in layers:

```mermaid
flowchart TD
    attack["Cross-site request that tries to use the cookie"] --> a{"SameSite=Strict?"}
    a -- "cookie not sent cross-site" --> blocked1["Blocked"]
    a -- "same site only" --> b{"JSON content type only?<br/>text/plain parser removed"}
    b -- "forms cannot send JSON" --> blocked2["Blocked: 415"]
    b -- "JSON allowed" --> c{"X-Requested-With header present?"}
    c -- "missing: needs a CORS preflight" --> d{"Origin in the CORS allow-list?"}
    d -- "no" --> blocked3["Blocked by CORS"]
    d -- "yes: our own web app" --> ok["Allowed"]
    c -- "present from our app" --> ok
```

The access token never touches storage: the SPA keeps it in memory and refreshes through the cookie
on page load.

## Authorization

```mermaid
flowchart TD
    req["Request"] --> v{"Valid signed token?<br/>RS256, issuer, audience, expiry"}
    v -- no --> e401["401"]
    v -- yes --> r{"Role allowed in the token claim?<br/>cheap check, rejects obvious misuse"}
    r -- no --> e403["403"]
    r -- yes --> d{"Confirmed against the database?<br/>user exists, active, role still matches"}
    d -- no --> e403b["403: stale token after demotion or disabling"]
    d -- yes --> s{"Resource in scope?<br/>for example team roster"}
    s -- no --> e404["404: existence not revealed"]
    s -- yes --> go["Perform the action"]
```

A token can be up to 15 minutes old, so for administrative actions the role is **re-checked against
the database**. An administrator who is demoted or disabled stops working immediately, not 15
minutes later.

## Access token

| Claim          | Meaning                                |
| -------------- | -------------------------------------- |
| `sub`          | User id                                |
| `role`         | `employee`, `manager` or `admin`       |
| `teams`        | Teams the user belongs to (at most 20) |
| `managedTeams` | Teams the user manages (at most 20)    |
| `iss`, `aud`   | Must match on every verifying service  |
| `iat`, `exp`   | 15 minute lifetime                     |
| `jti`          | Unique token id                        |

The 20 team limit is enforced when a membership is created, so a token that other services would
reject can never be issued.

## Signing key rotation

```mermaid
sequenceDiagram
    autonumber
    participant Ops as Operator
    participant ID as Identity Service
    participant API as Other services

    Ops->>Ops: generate a new key pair
    Ops->>ID: deploy: new private key, OLD public key listed as previous
    ID->>ID: sign with the new key, kid changes
    Note over ID: JWKS now publishes both keys
    API->>ID: unknown kid in a token, refetch the JWKS
    ID-->>API: both keys
    Note over Ops: after 15 minutes every old token has expired
    Ops->>ID: deploy again without the old public key
```

No downtime and nobody is signed out.

## Events

Identity writes events to its **outbox table in the same transaction** as the change that caused
them. Relaying them to EventBridge is built in step 5 as a shared component.

| Event                   | Written when                               |
| ----------------------- | ------------------------------------------ |
| `UserRegistered`        | An account is created                      |
| `TeamMembershipChanged` | A member is actually added or removed      |
| `UserDeleted`           | An account is erased; every service reacts |

## Data model

The tables behind this service (all in the `identity` schema):

```mermaid
erDiagram
    users ||--o{ team_members : "joins"
    teams ||--o{ team_members : "has"
    users ||--o{ teams : "manages"
    users ||--o{ refresh_tokens : "owns"

    users {
        uuid id PK
        text email UK "lower case, CHECK enforced"
        text password_hash "Argon2id"
        text role "CHECK in employee, manager, admin"
        text status "CHECK in active, disabled"
        int failed_login_attempts
        timestamptz locked_until
    }
    teams {
        uuid id PK
        text name "unique, case-insensitive"
        uuid manager_user_id FK "ON DELETE RESTRICT"
    }
    team_members {
        uuid team_id PK
        uuid user_id PK
    }
    refresh_tokens {
        uuid id PK
        uuid user_id FK "ON DELETE CASCADE"
        uuid family_id
        text token_hash UK "SHA-256"
        timestamptz revoked_at
        uuid replaced_by_id
    }
    outbox {
        uuid id PK
        text event_type
        jsonb payload
        timestamptz published_at "null until relayed"
    }
```

The database repeats the important invariants as constraints (lower-case email, valid role and
status, unique token hash, restricted manager deletion), so a bug in application code cannot
silently corrupt identity data. Migration tests verify each one.
