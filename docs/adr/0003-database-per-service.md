# ADR-0003: Database per service

**Status:** Proposed

## Context

The case study uses RDS for transactional data and DynamoDB for event-driven, high-throughput
access and analytics. Sharing tables between services would couple their release cycles and
make the privacy boundary impossible to enforce.

## Decision

- **Each service owns its data store and is its only reader and writer.**
- **RDS PostgreSQL** (one instance, **one schema and one database user per service**) for
  Identity, Habit, Challenge, Event Tracking and Notification.
- **DynamoDB** for streak state (written by the streak Lambda), aggregated analytics (Insight)
  and the idempotency table.
- Cross-service references are plain ids with no foreign keys.
- Each service's database user has privileges on its own schema only.

## Alternatives considered

| Option                       | Why not                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| Shared schema                | Hidden coupling; one bad migration breaks every service          |
| One RDS instance per service | Strongest isolation but about five times the cost for this scale |

## Consequences

- (+) Services deploy and migrate independently; blast radius of a bad query is limited.
- (+) A manager-facing service physically cannot read raw activity tables.
- (-) No cross-service joins: read models are built from events, and data is **eventually
  consistent**. The UI must tolerate a short delay between completing an activity and seeing the
  leaderboard change.
- (-) One shared RDS instance remains a shared failure domain; Multi-AZ mitigates it.
