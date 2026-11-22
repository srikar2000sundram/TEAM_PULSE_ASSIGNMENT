# ADR-0010: Refresh token rotation with reuse detection

**Status:** Proposed

## Context

[ADR-0006](0006-authentication-and-authorization.md) chose short-lived access tokens plus a
refresh token. A single-page app cannot keep a secret, so the refresh token is the one long-lived
credential in the browser and the main target of theft (a copied cookie, a leaked backup, malware).
We need sessions that last days without making a stolen token valid for days.

## Decision

- **Opaque, random refresh tokens**: 256 bits from the OS random source. Only a SHA-256 hash is
  stored, so a database leak does not yield usable tokens. (A slow password hash adds nothing for
  uniformly random input.)
- **Rotation**: every refresh exchanges the current token for a new one in the same _family_ (one
  family per login) and marks the old one as rotated.
- **Reuse detection**: presenting an already-rotated token means two parties hold it, so the
  **whole family is revoked** and the user must sign in again.
- **Benign race window (10 s)**: a rotated token replayed within 10 seconds is assumed to be two
  browser tabs refreshing together. The loser gets `409 auth.refresh_race` and the family survives.
- **Absolute session cap (30 days)** per login, however often it is refreshed. Individual tokens
  live 7 days.
- **Row locking** (`SELECT ... FOR UPDATE`) on the token during rotation, so two simultaneous
  refreshes of one token cannot both succeed and fork the family.
- **Cookie scope**: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/identity/auth`, plus a required
  `X-Requested-With: teampulse-web` header and a JSON-only API as CSRF defence in depth.
- Logout revokes the current session's family. Password change and account disabling revoke **all**
  of the user's families.

## Alternatives considered

| Option                          | Why not                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Long-lived access tokens        | A stolen token is valid until expiry and cannot be revoked                                             |
| Refresh tokens without rotation | A copied cookie works for its whole lifetime, undetected                                               |
| Rotation without a grace window | Two tabs on page load race and sign the user out; users would see random logouts                       |
| Refresh token in `localStorage` | Readable by any injected script (XSS); an `HttpOnly` cookie is not                                     |
| JWT refresh tokens              | Cannot be revoked or rotated server-side without storing state anyway                                  |
| Cognito or another hosted IdP   | Valid, and less code; the case study asks for an Identity Service. The login port can be swapped later |

## Consequences

- (+) A stolen refresh token has a short useful life: the next legitimate refresh exposes the theft
  and kills the session. `auth.refresh.reuse_detected` is logged as an alarm signal.
- (+) Revocation works: logout, password change and disabling take effect on the next refresh.
- (-) Identity holds session state, so it needs a database round trip per refresh (not per request:
  access tokens are verified locally by every service).
- (-) Access tokens already issued stay valid until they expire (at most 15 minutes) after a
  revocation. Administrative actions inside Identity re-check the database and stop at once; other
  services accept the token until it expires. A deny-list can be added if that window is too long.
- (-) The 10 second grace window is a deliberate small gap: a thief who replays a token within
  10 seconds of the legitimate client is not detected by that attempt.
- (-) Expired and revoked rows accumulate; a periodic cleanup job is future work (step 12).
