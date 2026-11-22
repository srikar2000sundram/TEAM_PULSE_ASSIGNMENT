# Identity Service

Sign-in, sessions, users, teams and memberships. Issues the access tokens every other TeamPulse
service trusts.

- Architecture, sequence diagrams and security reasoning: [docs/architecture/07-identity-service.md](../../docs/architecture/07-identity-service.md)
- API reference: [docs/api/identity.md](../../docs/api/identity.md)
- Decisions: [ADR-0006](../../docs/adr/0006-authentication-and-authorization.md), [ADR-0010](../../docs/adr/0010-refresh-token-rotation.md), [ADR-0011](../../docs/adr/0011-test-against-real-postgres.md)

## Layout

```text
src/
  domain/           User, RefreshToken, Email, password policy. Pure TypeScript, no I/O
  application/      Use cases and the ports they need (UnitOfWork, PasswordHasher, ...)
  adapters/
    http/           Fastify routes, DTO mappers, app assembly
    persistence/    pg database, repositories, migrations and their runner
    security/       Argon2id hasher, RS256 key ring and token issuer, opaque tokens
  config/           Typed, validated configuration with production guard rails
  cli/              bootstrap-admin, generate-jwt-key, export-openapi
  main.ts           Composition root: the only file that knows every concrete class
test/
  unit/             Domain and use cases against in-memory fakes (milliseconds)
  integration/      Real PostgreSQL (PGlite), real Argon2, real RS256, full HTTP stack
  support/          In-memory adapters, harness, shared repository contract suite
```

Dependencies point inward. ESLint fails the build if `domain/` or `application/` import Fastify,
`pg`, the AWS SDK or `adapters/`, or if this service imports another service.

## Run it locally

You need Node 22+ and a PostgreSQL database.

```bash
npm install && npm run build

# 1. a signing key. It prints a private and a public key to the terminal only;
#    copy the PRIVATE key block (BEGIN/END PRIVATE KEY) into private.pem
node services/identity/dist/cli/generate-jwt-key.js

# 2. configuration (see the table below)
export DATABASE_URL=postgres://identity:secret@localhost:5432/teampulse
export JWT_PRIVATE_KEY_PEM="$(cat private.pem)"
export COOKIE_SECURE=false          # local http only
export CORS_ORIGINS=http://localhost:5173

# 3. schema, first administrator, server
npm run migrate -w @teampulse/svc-identity
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-long-passphrase-7' \
  npm run bootstrap-admin -w @teampulse/svc-identity
npm start -w @teampulse/svc-identity
```

No Docker is needed to run the **tests**: they use PGlite, real PostgreSQL compiled to WebAssembly.

## Configuration

Read once at start-up; a missing or invalid value stops the process and names the variable, never
its value.

| Variable                                          | Default                                | Notes                                              |
| ------------------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `DATABASE_URL`                                    | required                               |                                                    |
| `DATABASE_SCHEMA`                                 | `identity`                             | Each service owns its own schema                   |
| `DATABASE_SSL`                                    | `false`                                | Must be `true` in production (RDS requires TLS)    |
| `DATABASE_POOL_MAX`                               | `10`                                   |                                                    |
| `JWT_PRIVATE_KEY_PEM`                             | required                               | RSA, at least 2048 bits. `\n` escapes are accepted |
| `JWT_PREVIOUS_PUBLIC_KEYS_PEM`                    | none                                   | JSON array of retired public keys, for rotation    |
| `JWT_ISSUER` / `JWT_AUDIENCE`                     | `teampulse-identity` / `teampulse-api` | Must match on every verifying service              |
| `ACCESS_TOKEN_TTL_SECONDS`                        | `900`                                  | 60 to 3600                                         |
| `REFRESH_TOKEN_TTL_SECONDS`                       | `604800`                               | 7 days                                             |
| `REFRESH_FAMILY_MAX_AGE_SECONDS`                  | `2592000`                              | 30 day cap per login                               |
| `REFRESH_REUSE_GRACE_SECONDS`                     | `10`                                   | Benign multi-tab race window                       |
| `LOCKOUT_MAX_FAILED_ATTEMPTS` / `LOCKOUT_MINUTES` | `5` / `15`                             |                                                    |
| `COOKIE_SECURE`                                   | `true`                                 | Must be `true` in production                       |
| `CORS_ORIGINS`                                    | none                                   | Comma separated; `https://` only in production     |
| `TRUST_PROXY`                                     | `false`                                | `true` behind the ALB                              |
| `LOG_LEVEL` / `PORT`                              | `info` / `3000`                        |                                                    |
| `LOG_PSEUDONYM_SALT`                              | none                                   | At least 16 characters; **required in production** |

In production the process refuses to start with insecure cookies, a database connection without
TLS, no allowed web origin, a non-HTTPS origin, or no log salt.

## Operations

| Task                        | Command                             | Notes                                                                              |
| --------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Apply migrations            | `npm run migrate`                   | One-off task before each deploy, not at start-up. Locks, checksums, all-or-nothing |
| Create the first admin      | `npm run bootstrap-admin`           | Refuses once an admin exists                                                       |
| New signing key             | `node dist/cli/generate-jwt-key.js` | See the rotation procedure in the architecture doc                                 |
| Refresh the API description | `npm run openapi:update`            | A test fails if the committed file is stale                                        |

### Signals to alarm on

Structured log lines carry an `event` field for CloudWatch metric filters:

| `event`                                                                              | Meaning                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `auth.login.failed` (`reason`: `bad_password`, `unknown_user`, `locked`, `disabled`) | Brute force or credential stuffing when it spikes          |
| `auth.refresh.reuse_detected`                                                        | A refresh token was replayed: a stolen cookie. Investigate |
| `auth.password_change.failed`                                                        | Someone with a session is guessing the current password    |
| `user.created`, `user.updated`, `user.deleted`, `team.*`                             | Audit trail; carry `actorUserId` (pseudonymised)           |

## Testing

```bash
npm test                     # everything
npx vitest run services/identity/test/unit          # milliseconds, no I/O
npx vitest run services/identity/test/integration   # real PostgreSQL via PGlite
```

What the tests prove, beyond the happy path:

- Wrong password, unknown email, locked and disabled accounts are indistinguishable, in both the
  response and the work done.
- A replayed refresh token revokes the whole session; two tabs refreshing together do not.
- A demoted or disabled administrator stops working immediately, even with a valid token.
- Passwords, hashes, tokens, emails and raw user ids appear in no response and no log line.
- The same repository contract suite passes on the in-memory fakes and on real PostgreSQL.
- The schema rejects invalid data on its own (defence in depth) and migrations are tamper-evident.
