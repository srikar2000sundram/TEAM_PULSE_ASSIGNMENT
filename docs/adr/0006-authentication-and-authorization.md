# ADR-0006: Authentication and authorization

**Status:** Proposed

## Context

The case study requires an Identity Service for login and role-based access. Every other service
must verify callers without making Identity a bottleneck.

## Decision

- Identity Service issues **JWT access tokens signed with RS256** (15 minute lifetime) and a
  rotating **refresh token** stored in an httpOnly, Secure, SameSite cookie.
- Other services verify tokens locally using Identity's **JWKS endpoint** (cached).
- Passwords hashed with **Argon2id**; login is rate limited.
- Authorization has three layers: **authenticated, role allowed, resource in scope**
  ([doc 06](../architecture/06-security-and-privacy.md)). Checks live in use cases, so they hold
  regardless of which adapter calls them.
- Roles: `employee`, `manager`, `admin`. Team scope comes from two claims: `teams` (memberships)
  and `managedTeams` (teams a manager manages), each limited to 20 so tokens stay small. The limit
  is enforced when memberships are created.
- **Administrative actions re-check the database** (user exists, active, role still admin) instead of
  trusting the token's role, so a demoted or disabled administrator stops working immediately.
- Sessions use rotating refresh tokens with theft detection: see [ADR-0010](0010-refresh-token-rotation.md).
- Details, diagrams and the threat reasoning: [Identity Service](../architecture/07-identity-service.md).

## Alternatives considered

| Option                        | Why not                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Amazon Cognito                | Valid and less code, but the case study asks for an Identity Service; can replace the login adapter later behind the same port |
| Opaque tokens + introspection | Every request calls Identity; adds latency and a failure point                                                                 |
| Session cookies               | Awkward for several backend services behind one ALB                                                                            |

## Consequences

- (+) Fast, stateless verification; Identity can scale and fail independently of read traffic.
- (-) Role or team changes take up to 15 minutes to reach other services through existing tokens
  (a refresh issues a fresh token with current claims). Administrative actions inside Identity
  re-check the database. Revocation uses refresh token rotation; an access-token deny-list is not
  built and can be added if 15 minutes proves too long.
- (-) Key rotation must be handled via `kid` and overlapping JWKS keys.
