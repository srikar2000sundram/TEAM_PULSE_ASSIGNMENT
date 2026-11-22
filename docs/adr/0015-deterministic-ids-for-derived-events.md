# ADR-0015: Deterministic ids for events derived from other events

**Status:** Proposed

## Context

The streak Lambda turns `ActivityCompleted` into `StreakUpdated`; the badge Lambda turns
`StreakUpdated` into `MilestoneReached`. Both run at least once: the bus can deliver an event twice,
and Lambda retries an invocation that failed. A Lambda has no outbox, so it saves its state and then
publishes, and a crash between the two is possible.

If each run created a new random event id, a retry would publish a _second, different_ event for the
same cause. Consumers that remember event ids could not tell it from a new achievement, and a
person could be congratulated twice for one milestone.

## Decision

The id of a derived event is **a function of the event that caused it**:

```text
StreakUpdated.eventId     = deterministicUuid("StreakUpdated:" + ActivityCompleted.eventId)
MilestoneReached.eventId  = deterministicUuid("MilestoneReached:" + StreakUpdated.eventId + ":" + threshold)
```

`deterministicUuid` (in `@teampulse/kernel`) hashes the seed with SHA-256 and shapes the result as
a version 5 style UUID, so it passes the same validation as any id.

Together with two other rules this makes a retry harmless:

1. **Publish even when the state did not change** for a repeat of an already counted day, so a crash
   after saving but before publishing is repaired by the retry.
2. **Do not publish for a back-dated activity**, which changes nothing; announcing the unchanged
   streak would look like a new achievement.

## Alternatives considered

- **Remember processed event ids** (an inbox table or DynamoDB markers with a TTL). More moving
  parts and a place for state to drift; the derivation needs no storage.
- **Random ids, and dedupe in every consumer by content.** Pushes the problem to every consumer and
  cannot tell "the same milestone again" from "reached it a second time".
- **Exactly-once infrastructure (FIFO queues, transactions across services).** Not available across
  EventBridge and Lambda.

## Consequences

- A repeated cause gives the same event id, so downstream dedupe, tracing and replays line up.
- A genuinely new achievement (a streak that breaks and rebuilds to 7) comes from a new
  `StreakUpdated`, so it gets a new id, as it should.
- `occurredAt` differs between a first run and a retry (it is the processing time), but the id and
  payload are the same. Consumers must not treat `occurredAt` as an identity.
- The seed format is now a contract: changing it would make old and new events look different for
  the same cause, so it changes only with a new `schemaVersion`.
