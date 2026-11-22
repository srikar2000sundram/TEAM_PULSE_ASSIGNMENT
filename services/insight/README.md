# Insight Service

Privacy-preserving activity analytics: a team's numbers with small groups hidden, the organisation's
numbers for administrators, and each person's own numbers. Part of the TeamPulse platform.

- Architecture, diagrams and rules: [docs/architecture/12-insight-service.md](../../docs/architecture/12-insight-service.md)
- API: [docs/api/insight.md](../../docs/api/insight.md)
- Decisions: [ADR-0005](../../docs/adr/0005-privacy-by-design.md), [ADR-0017](../../docs/adr/0017-insight-aggregates-in-the-service.md)

## Layout

```text
src/
  domain/          scopes, report building with the privacy rules. No framework imports
  application/     use cases, ports (AnalyticsStore, Pseudonymizer). No framework or driver imports
  adapters/
    http/          routes (zod contracts), app assembly
    events/        maps ActivityCompleted and UserDeleted to use cases
    dynamodb-store.ts   the two tables, transactions and queries
    hmac-pseudonymizer.ts
  config/          validated environment, fail-fast, production guard rails
  cli/             OpenAPI export
  main.ts          composition root: server + event consumer
test/
  unit/            report rules, use cases, store contract (in-memory and DynamoDB on a fake), handlers, config, OpenAPI drift
  integration/     HTTP end to end with real tokens
```

## Run

| Command                                           | What it does                                             |
| ------------------------------------------------- | -------------------------------------------------------- |
| `npm run build`                                   | Compile (from the repo root, builds dependencies too)    |
| `npm start -w @teampulse/svc-insight`             | Start the service and the event consumer                 |
| `npm run openapi:update` (run inside this folder) | Regenerate `docs/api/insight.openapi.json` after a build |

## Configuration

| Variable                | Default     | Notes                                                                  |
| ----------------------- | ----------- | ---------------------------------------------------------------------- |
| `AGGREGATES_TABLE_NAME` | required    | DynamoDB table for cells and event markers (no user ids)               |
| `PERSONAL_TABLE_NAME`   | required    | DynamoDB table for personal counters                                   |
| `IDENTITY_JWKS_URL`     | required    | Public keys that verify access tokens; `https` in production           |
| `EVENTS_QUEUE_URL`      | none        | This service's SQS queue. Unset: no consuming. Required in production  |
| `MIN_COHORT_SIZE`       | `5`         | Groups smaller than this are never shown. Between 3 and 100            |
| `RETENTION_DAYS`        | `400`       | Counters are deleted this long after the day they describe             |
| `INSIGHT_PSEUDONYM_KEY` | dev key     | Secret, at least 32 characters. Production refuses the development key |
| `AWS_REGION`            | SDK default | Credentials come from the task role, never from configuration          |

This service publishes no events, so it needs no event bus. Configuration errors name the variable,
never its value.

## Guarantees (all tested)

- A number about a group is shown only when at least K different people stand behind it, and a hidden
  number carries no value and no group size.
- A hidden number cannot be worked out by subtraction from a shown total and its other parts.
- Reports contain no user ids, and the aggregates table never receives one.
- The same event is counted once, however often it is delivered.
- A deleted person's activity is taken out of every team and organisation count.
- A team that is not yours gives the same 404 as one that does not exist.

## Not built yet

- Fixed reporting periods, which would prevent comparing two overlapping reports to learn a hidden day.
- Never run against real DynamoDB (needs LocalStack or an AWS account, step 9) and no Terraform yet (step 11).
