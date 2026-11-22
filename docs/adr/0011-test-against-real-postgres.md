# ADR-0011: Test persistence against real PostgreSQL, without Docker

**Status:** Proposed

## Context

The services' correctness depends on PostgreSQL behaviour: unique constraints, `ON CONFLICT`,
`SELECT ... FOR UPDATE`, keyset pagination on `(created_at, id)`, `CHECK` constraints, cascades,
transaction semantics. In-memory fakes cannot prove any of that, and mocked SQL proves even less.
Docker is not available on the current development machine, and many CI runners and laptops are in
the same position.

## Decision

Three layers of tests, each answering a different question:

| Layer                         | Runs against                                                                                 | Proves                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Unit (use cases, domain)      | In-memory fakes                                                                              | Business rules, in milliseconds                                              |
| **Repository contract suite** | The fakes **and** real PostgreSQL (PGlite)                                                   | The fakes behave like the database, so unit tests can be trusted             |
| Driver and HTTP integration   | PGlite served over the PostgreSQL **wire protocol** to the real `pg` driver and `PgDatabase` | The production code path: pool, session settings, transactions, error shapes |

- **PGlite** is PostgreSQL compiled to WebAssembly (`@electric-sql/pglite`). It runs in-process, so
  no server, container or port is needed. `@electric-sql/pglite-socket` exposes the wire protocol,
  letting the production `PgDatabase` connect exactly as it would to RDS.
- **One contract suite, two implementations.** The same behavioural tests run against the in-memory
  repositories and the SQL repositories. When they disagree, the contract test fails (it has already
  caught adapter drift in error messages and a driver difference in row counts).
- **Schema constraints are tested directly**, so the database remains a second line of defence.
- Docker-based tests (Testcontainers) can be added later in CI for the few behaviours PGlite cannot
  model.

## Alternatives considered

| Option                          | Why not                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Mock the database client        | Tests the mocks, not the SQL; passes while queries are wrong                             |
| Testcontainers / docker-compose | Closest to production, but needs Docker, is slow to start, and unavailable here          |
| SQLite as a stand-in            | Different SQL dialect and semantics (no `FOR UPDATE`, different `ON CONFLICT` and types) |
| `pg-mem`                        | Emulates Postgres in JavaScript; incomplete and diverges on locking and constraints      |

## Consequences

- (+) Fast (seconds), hermetic, runs anywhere Node runs, still exercises a real Postgres engine.
- (+) The whole identity suite (more than 340 tests) needs no external services.
- (-) PGlite is a single embedded session: it cannot test true multi-connection concurrency or lock
  contention, so the lockout's race safety rests on `FOR UPDATE` semantics that are standard
  PostgreSQL but not stress-tested here. A concurrency test belongs in the Docker-based CI job.
- (-) PGlite ignores some server behaviour (for example connection startup parameters), which is
  why per-session settings are applied with `SET` on connect, a choice that also suits RDS Proxy.
- (-) WebAssembly start-up takes seconds, so integration files share one instance and reset state
  between tests, and the Vitest timeouts are generous.
