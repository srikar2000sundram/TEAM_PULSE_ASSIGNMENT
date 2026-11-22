# ADR-0018: Challenge scoring and badges live in the Challenge Service

**Status:** Proposed

## Context

The original flow had the badge Lambda turn `StreakUpdated` into `BadgeAwarded` and
`ChallengeProgressUpdated`, and the Challenge Service consume them to update points. For that the
Lambda must know every challenge's rules: which activity type, which dates, who takes part, and
which badges exist. Those rules belong to the Challenge Service, and they change as people create
and cancel challenges and join them.

Replicating the rules into the Lambda would mean either a second copy of the challenge data (a table
the Challenge Service writes and the Lambda reads, breaking database-per-service) or a new event
carrying the rules. Either way the Lambda would score without seeing who has joined, and the result
would arrive at the Challenge Service as a second event hop that can be late or out of order.

## Decision

**The Challenge Service consumes `ActivityCompleted` and scores it itself.** It is the producer of
`ChallengeProgressUpdated` and `BadgeAwarded` (the contract's producer pin changes from
`badge-lambda` to `challenge`). The badge Lambda keeps only the milestones that need no challenge
data: streak milestones and total-activity milestones.

- **One transaction.** Scoring an activity writes the ledger row, the participant's points, the badges
  it earns and the events to publish, together (transactional outbox).
- **A ledger is the source of truth.** One row per qualifying activity, keyed by (challenge, source
  event). That key makes scoring idempotent. Streak, active days and total are derived from the
  ledger's dates, so a reordered or replayed event can never leave a counter wrong.
- **Challenge badges are defined per challenge** by its manager, from three kinds of rule:
  `streak` (longest run of consecutive days), `total` (number of qualifying activities) and
  `milestone` (number of different active days).
- **One point per qualifying activity.** Weighting activities would need rules that nobody has asked
  for; the ledger makes it a small change later.
- **A grace period** (default one day) keeps a challenge open after its last day, because an activity
  carries the person's own calendar date, which can be a day behind UTC.

## Alternatives considered

- **Rules replicated into the Lambda.** Described above: a second copy of the data and an extra hop.
- **A Lambda that calls the Challenge Service.** Couples a function that should be a pure derivation
  to a service's availability, and still needs idempotency on the far side.
- **Counters instead of a ledger.** Cheaper, but cannot be made correct under replay and reordering,
  and cannot support "leave the team and take your points with you".

## Consequences

- (+) Points, leaderboard and badges are consistent with each other and with participation, because
  they change in one transaction.
- (+) Scoring is idempotent and order-tolerant by construction, and testable against a real database.
- (+) The badge Lambda stays stateless.
- (-) The Challenge Service reads every `ActivityCompleted` event, including those that score nowhere.
  The lookup is one indexed query per event.
- (-) `ChallengeProgressUpdated` has no consumer yet. It is published because the contract defines it
  and a live leaderboard in the web app can use it; nothing depends on it.
- (-) Late events after a challenge completes do not score. The grace period narrows the window but
  does not remove it.
