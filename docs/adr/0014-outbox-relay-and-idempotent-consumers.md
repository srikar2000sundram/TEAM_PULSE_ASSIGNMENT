# ADR-0014: Outbox relay and idempotent consumers

**Status:** Proposed

## Context

Services publish events (`ActivityCompleted`, `HabitCreated`, `UserDeleted`, ...) and react to each
other's. Publishing straight after a database commit can lose the event (crash between the two
steps), and the bus and the queues deliver at least once, in no guaranteed order. We need a delivery
design that loses nothing, tolerates duplicates and reordering, and stays simple enough to reason
about.

## Decision

**Publishing: a transactional outbox with a polling relay.**

- The event is written to the service's `outbox` table in the same transaction as the change.
- A relay loop inside each publishing service claims unpublished rows with
  `FOR UPDATE SKIP LOCKED`, sends them to EventBridge, and marks them published only after the bus
  accepted that entry. Several instances can run it at once.
- Failures are per event. A rejected event is retried on later cycles; after 10 attempts, or at once
  if the row is not a valid event, it is **parked** (stays in the table, no longer retried) so a
  poison event cannot spin forever. Alarms on parked rows come with the observability step.
- Published rows are purged after a retention period (14 days by default).
- Without `EVENT_BUS_NAME` the relay does not start and events wait safely in the outbox
  (local development). Production configuration requires it.

**Consuming: SQS queues, idempotent handlers, no inbox table.**

- EventBridge rules route events to one queue per consuming service. The consumer validates each
  message as a TeamPulse event, runs the handler inside the event's correlation id, and deletes the
  message only on success.
- A handler that fails, or a message that is not a valid event, is **left on the queue**. SQS's
  visibility timeout and redrive policy provide the retries and the dead-letter queue; the consumer
  has no retry logic of its own.
- **Every handler must be idempotent and order-tolerant.** Handlers are written as upserts keyed by
  ids, with "newest event wins" and "archived is permanent" rules where order matters (see the Habit
  directory in Event Tracking), instead of recording processed event ids.

## Alternatives considered

- **Publish after commit, in the request.** Simple, but an event is lost if the process dies in
  between. The outbox costs one table and a loop.
- **Change data capture (Debezium or DMS).** Removes polling but adds infrastructure that is hard to
  run on the target AWS setup and impossible to test locally.
- **An inbox table of processed event ids (exactly-once effect).** Needed when a handler cannot be
  made idempotent. Today none of ours need it, and the table would be a second place that can drift.
  The first handler that does need it (the streak Lambda, with a DynamoDB conditional write) can use
  an idempotency key at that point.
- **Strict ordering (FIFO queues).** Rejected: it limits throughput and still cannot order events
  from different producers. Designing handlers to tolerate disorder is cheaper and stronger.

## Consequences

- An event can be published twice (crash between publish and mark). Consumers absorb that by design.
- Latency is the polling interval (1 second by default) plus delivery. Acceptable for streaks,
  badges and notifications; not suitable for anything that must be synchronous.
- The relay holds a database transaction open while it calls the bus. Connections drop transactions
  idle for more than 15 seconds, so each publish call is limited to 8 seconds (`publishTimeoutMs`);
  a call that times out counts as failed and is retried. It may still reach the bus afterwards, which
  is one more duplicate for the idempotent consumers to absorb.
- The relay and consumer glue that talks to AWS (`@teampulse/outbox/aws`, `@teampulse/inbox/aws`)
  is thin and is **not** covered by automated tests against real AWS; everything around it is.
