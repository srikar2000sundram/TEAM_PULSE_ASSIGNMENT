# Habit Service

Habits, private versus team visibility, and reminders. Part of the TeamPulse platform.

- Architecture, diagrams and rules: [docs/architecture/08-habit-service.md](../../docs/architecture/08-habit-service.md)
- API: [docs/api/habit.md](../../docs/api/habit.md)
- Decisions: [ADR-0012](../../docs/adr/0012-visibility-enforced-in-the-query.md),
  [ADR-0013](../../docs/adr/0013-shared-persistence-packages.md)

## Layout

```text
src/
  domain/          Habit, Sharing, Viewer, the visibility rule. No framework imports
  application/     use cases, ports, event reactions. No framework or driver imports
  adapters/
    http/          routes (zod contracts), app assembly
    persistence/   PostgreSQL repository, migrations, migrate command
  config/          validated environment, fail-fast, production guard rails
  cli/             OpenAPI export
  main.ts          composition root
test/
  unit/            domain, use cases against in-memory fakes, config, OpenAPI drift
  integration/     repository contract (PGlite and real pg driver), constraints, HTTP end to end
```

## Run

| Command                                          | What it does                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `npm run build`                                  | Compile (from the repo root, builds dependencies too)                           |
| `npm run migrate -w @teampulse/svc-habit`        | Create the `habit` schema and apply migrations                                  |
| `npm start -w @teampulse/svc-habit`              | Start the service                                                               |
| `npm run openapi:update -w @teampulse/svc-habit` | Regenerate `docs/api/habit.openapi.json`, run it from this folder after a build |

## Configuration

| Variable                     | Default           | Notes                                                        |
| ---------------------------- | ----------------- | ------------------------------------------------------------ |
| `DATABASE_URL`               | required          | PostgreSQL connection string                                 |
| `DATABASE_SCHEMA`            | `habit`           | Simple lower-case name                                       |
| `DATABASE_SSL`               | `false`           | Must be `true` in production                                 |
| `IDENTITY_JWKS_URL`          | required          | Public keys that verify access tokens; `https` in production |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Identity defaults | Must match the Identity Service                              |
| `MAX_ACTIVE_HABITS_PER_USER` | `50`              | 1 to 500                                                     |
| `CORS_ORIGINS`               | none              | Required, `https` only, in production                        |
| `LOG_PSEUDONYM_SALT`         | none              | Required in production (user ids in logs are pseudonymised)  |

Configuration errors name the variable, never its value.

## Privacy properties (all tested)

- A private habit is invisible to everyone but its owner, including admins and the team's manager.
- A hidden habit and a missing habit produce the same 404.
- Events carry ids, activity type and reminder only; never a title or description.
- Logs contain neither titles, notes, tokens, nor raw user ids.

## Events

| Direction | Event                                           | What happens                                                  |
| --------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Publishes | `HabitCreated`, `HabitUpdated`, `HabitArchived` | Written to the outbox with the change, relayed to EventBridge |
| Consumes  | `UserDeleted`                                   | Erases the user's habits                                      |
| Consumes  | `TeamMembershipChanged` (removed)               | Makes that person's habits shared with the team private       |

`EVENT_BUS_NAME` and `EVENTS_QUEUE_URL` configure them (required in production; unset locally means
the relay and consumer do not start). The AWS glue is not covered by tests against real AWS.
