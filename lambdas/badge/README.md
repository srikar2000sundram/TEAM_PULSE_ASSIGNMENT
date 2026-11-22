# Badge Lambda

Two small functions in one package, both turning one event into a `MilestoneReached`:

| Function          | Handler                      | Input               | Announces                                                        |
| ----------------- | ---------------------------- | ------------------- | ---------------------------------------------------------------- |
| streak milestones | `dist/handler.handler`       | `StreakUpdated`     | a streak of 7, 14, 30, 60, 100 or 365 days                       |
| total milestones  | `dist/handler.totalsHandler` | `ActivityCompleted` | a total of 10, 25, 50, 100, 250, 500 or 1000 recorded activities |

Both are stateless: they need no database.

- Design and scope: [docs/architecture/10-lambdas.md](../../docs/architecture/10-lambdas.md)
- Decisions: [ADR-0015](../../docs/adr/0015-deterministic-ids-for-derived-events.md) (retry-safe ids),
  [ADR-0018](../../docs/adr/0018-challenge-scoring-in-the-service.md) (why challenge badges are not here)

## Layout

```text
src/
  domain/        which counts are milestones
  application/   AwardMilestones, AwardTotalMilestones, publishOrThrow. No AWS imports
  handler.ts     Lambda entry points and composition root
test/
  unit/          milestone rules, both use cases (retry safety), both handlers
```

## Configuration (environment variables of the function)

| Variable             | Notes                                  |
| -------------------- | -------------------------------------- |
| `EVENT_BUS_NAME`     | EventBridge bus for `MilestoneReached` |
| `AWS_REGION`         | Set by Lambda                          |
| `LOG_PSEUDONYM_SALT` | Required in production                 |

## Not built here, on purpose

- `BadgeAwarded` and `ChallengeProgressUpdated`: the Challenge Service scores challenges and awards
  their badges itself (ADR-0018).
- Never run against real EventBridge (step 9).
