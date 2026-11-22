# Challenge Service

Team challenges, participation, scoring, leaderboards and badges. Part of the TeamPulse platform.

- Architecture, diagrams and rules: [docs/architecture/13-challenge-service.md](../../docs/architecture/13-challenge-service.md)
- API: [docs/api/challenge.md](../../docs/api/challenge.md)
- Decision: [ADR-0018](../../docs/adr/0018-challenge-scoring-in-the-service.md)

## Layout

```text
src/
  domain/          Challenge (lifecycle, visibility), progress statistics, ranking. No framework imports
  application/     use cases, ports, event reactions. No framework or driver imports
  adapters/
    http/          routes (zod contracts), app assembly
    events/        maps events from other services to use cases
    persistence/   PostgreSQL repositories, migrations, migrate command
    scheduler.ts   the calendar tick: start drafts, complete finished challenges
  config/          validated environment, fail-fast, production guard rails
  cli/             OpenAPI export
  main.ts          composition root: server + outbox relay + event consumer + scheduler
test/
  unit/            domain, use cases, scoring, lifecycle and handlers against in-memory fakes, config, OpenAPI drift
  integration/     repository contract (in-memory, PGlite, real pg driver), constraints, HTTP end to end
```

## Run

| Command                                           | What it does                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run build`                                   | Compile (from the repo root, builds dependencies too)              |
| `npm run migrate -w @teampulse/svc-challenge`     | Create the `challenge` schema and apply migrations                 |
| `npm start -w @teampulse/svc-challenge`           | Start the service, the relay, the event consumer and the scheduler |
| `npm run openapi:update` (run inside this folder) | Regenerate `docs/api/challenge.openapi.json` after a build         |

## Configuration

| Variable                 | Default     | Notes                                                                    |
| ------------------------ | ----------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`           | required    | PostgreSQL connection string                                             |
| `DATABASE_SCHEMA`        | `challenge` | Simple lower-case name                                                   |
| `DATABASE_SSL`           | `false`     | Must be `true` in production                                             |
| `IDENTITY_JWKS_URL`      | required    | Public keys that verify access tokens; `https` in production             |
| `EVENT_BUS_NAME`         | none        | Unset: events wait in the outbox. Required in production                 |
| `EVENTS_QUEUE_URL`       | none        | This service's SQS queue. Unset: no consuming. Required in production    |
| `AWS_REGION`             | SDK default | Credentials come from the task role, never from configuration            |
| `CHALLENGE_TICK_SECONDS` | `60`        | How often challenges are started and completed (10 to 3600)              |
| `CHALLENGE_GRACE_DAYS`   | `1`         | Days after the last day during which its activities still count (0 to 7) |

Configuration errors name the variable, never its value.

## Guarantees (all tested)

- An activity scores once per challenge, however often its event is delivered, and a crash while
  scoring leaves nothing half done.
- Points, active days, streak and badges are derived from a ledger of dates, so the order events
  arrive in never changes the result.
- A badge is awarded once per person and rule, and announced once.
- A challenge you may not see gives the same 404 as one that does not exist; a draft is invisible to
  the team.
- Only managers of a team (and administrators) create, start and cancel its challenges.
- Two instances completing the same challenge publish `ChallengeCompleted` once.
- A deleted person's participation, points and badges are erased; leaving a team removes the person
  from its unfinished challenges.

## Not built yet

- Editing a challenge after creation, and leaving a challenge on your own.
- Never run against real SQS or a PostgreSQL server (needs LocalStack or an AWS account, step 9).
