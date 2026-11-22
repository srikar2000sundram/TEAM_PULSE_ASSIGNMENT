# Event Tracking Service

Records that someone completed a habit on a day, idempotently, and publishes `ActivityCompleted`.
Part of the TeamPulse platform.

- Architecture, diagrams and rules: [docs/architecture/09-event-tracking.md](../../docs/architecture/09-event-tracking.md)
- API: [docs/api/event-tracking.md](../../docs/api/event-tracking.md)
- Decision: [ADR-0014](../../docs/adr/0014-outbox-relay-and-idempotent-consumers.md)

## Layout

```text
src/
  domain/          Activity, the date window. No framework imports
  application/     use cases, ports, event reactions. No framework or driver imports
  adapters/
    http/          routes (zod contracts), app assembly
    events/        maps Habit and Identity events to use cases
    persistence/   PostgreSQL repositories, migrations, migrate command
  config/          validated environment, fail-fast, production guard rails
  cli/             OpenAPI export
  main.ts          composition root: server + outbox relay + event consumer
test/
  unit/            domain, use cases and event handlers against in-memory fakes, config, OpenAPI drift
  integration/     repository contract (PGlite and real pg driver), constraints, HTTP end to end
```

## Run

| Command                                            | What it does                                                    |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `npm run build`                                    | Compile (from the repo root, builds dependencies too)           |
| `npm run migrate -w @teampulse/svc-event-tracking` | Create the `event_tracking` schema and apply migrations         |
| `npm start -w @teampulse/svc-event-tracking`       | Start the service, the outbox relay and the event consumer      |
| `npm run openapi:update` (run inside this folder)  | Regenerate `docs/api/event-tracking.openapi.json` after a build |

## Configuration

| Variable                  | Default          | Notes                                                                    |
| ------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`            | required         | PostgreSQL connection string                                             |
| `DATABASE_SCHEMA`         | `event_tracking` | Simple lower-case name                                                   |
| `DATABASE_SSL`            | `false`          | Must be `true` in production                                             |
| `IDENTITY_JWKS_URL`       | required         | Public keys that verify access tokens; `https` in production             |
| `BACKFILL_DAYS`           | `7`              | How many days back an activity can be recorded (0 to 30)                 |
| `EVENT_BUS_NAME`          | none             | EventBridge bus. Unset: the relay does not start. Required in production |
| `EVENTS_QUEUE_URL`        | none             | This service's SQS queue. Unset: no consuming. Required in production    |
| `AWS_REGION`              | SDK default      | Credentials come from the task role, never from configuration            |
| `OUTBOX_POLL_INTERVAL_MS` | `1000`           | Relay polling interval when the outbox is empty                          |
| `OUTBOX_RETENTION_DAYS`   | `14`             | Published outbox rows older than this are deleted                        |

Configuration errors name the variable, never its value.

## Guarantees (all tested)

- Recording the same habit and day twice stores one activity and publishes one event, also for
  simultaneous requests.
- A habit that is not yours looks exactly like one that does not exist.
- Out-of-order and duplicate Habit events leave the local habit copy correct.
- The response and the logs never contain user ids, team ids or tokens.

## Not built yet

- Undoing a recorded activity (needs an `ActivityRetracted` event).
- Consuming `StreakUpdated` (arrives with the streak Lambda, step 6).
- Testing the AWS glue (`@teampulse/outbox/aws`, `@teampulse/inbox/aws`) against real AWS or LocalStack (step 9).
