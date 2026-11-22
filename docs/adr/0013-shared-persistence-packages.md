# ADR-0013: Shared `db`, `outbox` and `testing` packages

**Status:** Proposed

## Context

The Identity Service contained its own PostgreSQL pool, migration runner, transient-error
classifier, outbox writer, event factory and PGlite test database. The Habit Service needs every one
of them, and Event Tracking, Challenge and Notification will too. Copying them would give each
service its own slightly different copy of security-relevant code (connection settings, the
migration lock, the outbox table).

## Decision

Extract them into three packages (ADR-0001 already says services share code only through
`packages/*`):

| Package              | Contains                                                                          | Used by               |
| -------------------- | --------------------------------------------------------------------------------- | --------------------- |
| `@teampulse/db`      | `PgDatabase`, `Queryable`, `migrate`, `migrateSchema`, `isTransientDatabaseError` | adapters              |
| `@teampulse/outbox`  | `EventFactory`, `Outbox` port, `PostgresOutbox`, `OUTBOX_DDL` (relay in step 5)   | application, adapters |
| `@teampulse/testing` | `PgliteDatabase`, `startPgWireServer`                                             | tests only            |

- **Each service keeps its own migrations and schema.** The packages hold mechanism, not tables
  (apart from the identical outbox table, which every producer needs).
- **The application layer imports only** the `Outbox` port and `EventFactory` from `outbox`, never
  `pg` itself (ESLint still forbids that).
- **`testing` is a devDependency**, so PGlite never reaches a production image.
- The generic behaviour of `PgDatabase` and the migration runner is now tested once, in
  `packages/db`, through the real driver.

## Consequences

- One place to fix connection handling. Doing the extraction found a real issue: session settings
  were fired from the pool's `connect` event and could overlap the first query, which node-postgres
  deprecates and will reject in version 9. `PgDatabase` now applies them before handing out a client,
  and a regression test watches for the deprecation warning.
- A change to `@teampulse/db` affects every service, so its tests matter more.
