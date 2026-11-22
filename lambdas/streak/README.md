# Streak Lambda

Turns `ActivityCompleted` into `StreakUpdated`, keeping each person's streak per habit in DynamoDB.

- Design, rules and retry safety: [docs/architecture/10-lambdas.md](../../docs/architecture/10-lambdas.md)
- Decisions: [ADR-0014](../../docs/adr/0014-outbox-relay-and-idempotent-consumers.md),
  [ADR-0015](../../docs/adr/0015-deterministic-ids-for-derived-events.md)

## Layout

```text
src/
  domain/        the streak rules, a pure function of stored state and an activity date
  application/   UpdateStreak, the StreakStore port. No AWS imports
  adapters/      DynamoDbStreakStore (conditional writes)
  handler.ts     Lambda entry point and composition root
test/
  unit/          rules, use case (redelivery, conflicts, crash recovery), DynamoDB conditions, handler
```

## Configuration (environment variables of the function)

| Variable             | Notes                                                       |
| -------------------- | ----------------------------------------------------------- |
| `STREAK_TABLE_NAME`  | DynamoDB table with string keys `pk` and `sk`               |
| `EVENT_BUS_NAME`     | EventBridge bus for `StreakUpdated`                         |
| `AWS_REGION`         | Set by Lambda                                               |
| `LOG_PSEUDONYM_SALT` | Required in production (user ids in logs are pseudonymised) |

Credentials come from the function's execution role. Handler: `dist/handler.handler`.
Packaging (bundling, layers) and the Terraform for the function, table and alarms come in steps 9 and 11.

## Not verified

Never run against real DynamoDB or EventBridge (needs LocalStack or an AWS account, step 9).
