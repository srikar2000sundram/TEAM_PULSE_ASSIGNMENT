# ADR-0004: Event-driven integration with outbox

**Status:** Proposed

## Context

An activity completion triggers streaks, badges, leaderboard changes, analytics and
notifications. Doing this synchronously would slow the API and make it fail whenever any
downstream part is down.

## Decision

- Event Tracking writes the activity and an **outbox row in one transaction**; a relay publishes
  to a custom **EventBridge bus** and marks the row sent (at-least-once delivery).
- **EventBridge rules** route events to **Lambda** (streak, badge) and to **SQS queues** (one per
  consuming ECS service, each with a dead letter queue).
- ECS services consume from SQS, not directly from EventBridge, so they control concurrency and
  survive restarts. Queue depth is an alarm signal required by the case study.
- All consumers are **idempotent** using an event-id table in DynamoDB.
- Events use a shared envelope with `schemaVersion` ([event flow](../architecture/03-event-flow.md)).

## Alternatives considered

| Option                      | Why not                                                         |
| --------------------------- | --------------------------------------------------------------- |
| Synchronous service calls   | Tight coupling, cascading failures, slow writes                 |
| Publish directly after save | Dual-write problem: event can be lost on crash                  |
| EventBridge to HTTP targets | Needs public or API destination endpoints; weaker back-pressure |
| Kafka                       | Powerful, but heavy operational cost for this workload          |

## Consequences

- (+) The write path stays fast and available; consumers scale and fail independently.
- (-) Eventual consistency and duplicate delivery must be handled in every consumer.
- (-) More moving parts to observe; mitigated by correlation ids and the alarms in doc 05.
