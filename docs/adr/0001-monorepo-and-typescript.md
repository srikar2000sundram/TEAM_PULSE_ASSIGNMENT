# ADR-0001: Monorepo with npm workspaces and TypeScript

**Status:** Proposed

## Context

The case study does not specify a backend language. We have six services, a SvelteKit app,
Lambda functions, a shared UI library and shared event contracts, all maintained by one team.

## Decision

- One repository, **npm workspaces**: `services/*`, `lambdas/*`, `apps/*`, `packages/*`.
- **TypeScript in strict mode** everywhere, including the frontend (one language end to end).
- Shared code only through explicit packages, documented in [packages/README.md](../../packages/README.md):
  `packages/kernel` (Result, errors, Clock, IdGenerator), `packages/contracts` (event and API
  schemas), `packages/observability` (logging), `packages/config` (validated configuration) and,
  later, `packages/ui` (web components). The backend packages are independent of each other.

## Alternatives considered

| Option                         | Why not                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| One repo per service           | Heavy overhead for one team; contract changes need many coordinated PRs |
| Java/Spring or Go for backends | Good fit, but splits language skills between frontend and backend       |
| pnpm or Nx                     | Better caching, but adds tooling; npm workspaces are enough to start    |

## Consequences

- (+) Atomic changes across a contract and its consumers; one toolchain; shared types.
- (+) `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` catch bugs early.
- (-) Services must not import each other's source; enforced by review and a lint rule (step 2).
- (-) CI must build only affected workspaces as the repo grows.
