# Notification Service

In-app notifications, notification preferences and habit reminders. Part of the TeamPulse platform.

- Architecture, diagrams and rules: [docs/architecture/11-notification-service.md](../../docs/architecture/11-notification-service.md)
- API: [docs/api/notification.md](../../docs/api/notification.md)
- Decision: [ADR-0016](../../docs/adr/0016-reminders-by-claimed-ticks.md)

## Layout

```text
src/
  domain/          Notification, rendered text, reminder schedule and time zone logic. No framework imports
  application/     use cases, ports, event reactions. No framework or driver imports
  adapters/
    http/          routes (zod contracts), app assembly
    events/        maps events from other services to use cases
    persistence/   PostgreSQL repositories, migrations, migrate command
    scheduler.ts   the reminder tick
  config/          validated environment, fail-fast, production guard rails
  cli/             OpenAPI export
  main.ts          composition root: server + event consumer + reminder scheduler
test/
  unit/            domain, use cases and event handlers against in-memory fakes, config, OpenAPI drift
  integration/     repository contract (PGlite and real pg driver), constraints, HTTP end to end
```

## Run

| Command                                           | What it does                                                  |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `npm run build`                                   | Compile (from the repo root, builds dependencies too)         |
| `npm run migrate -w @teampulse/svc-notification`  | Create the `notification` schema and apply migrations         |
| `npm start -w @teampulse/svc-notification`        | Start the service, the event consumer and the reminder ticker |
| `npm run openapi:update` (run inside this folder) | Regenerate `docs/api/notification.openapi.json` after a build |

## Configuration

| Variable                  | Default        | Notes                                                                 |
| ------------------------- | -------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`            | required       | PostgreSQL connection string                                          |
| `DATABASE_SCHEMA`         | `notification` | Simple lower-case name                                                |
| `DATABASE_SSL`            | `false`        | Must be `true` in production                                          |
| `IDENTITY_JWKS_URL`       | required       | Public keys that verify access tokens; `https` in production          |
| `EVENTS_QUEUE_URL`        | none           | This service's SQS queue. Unset: no consuming. Required in production |
| `AWS_REGION`              | SDK default    | Credentials come from the task role, never from configuration         |
| `REMINDER_TICK_SECONDS`   | `30`           | How often due reminders are looked for (5 to 300)                     |
| `REMINDER_WINDOW_MINUTES` | `15`           | How long after its time a reminder may still be sent (1 to 120)       |

This service publishes no events, so it needs no event bus. Configuration errors name the variable,
never its value.

## Guarantees (all tested)

- The same event notifies the same person once, however often it is delivered.
- A person's notifications are never visible to anyone else; someone else's id gives the same 404 as a
  missing one.
- A reminder is sent once per habit and local day, in the right local time including daylight saving.
- Out-of-order and duplicate habit events leave the reminder schedule correct; archiving is permanent.
- Switching a category off stops new notifications of that kind.

## Not built yet

- Email or push delivery (a sender port in front of SES).
- Marking all notifications as read in one call.
- Never run against real SQS (needs LocalStack or an AWS account, step 9).
