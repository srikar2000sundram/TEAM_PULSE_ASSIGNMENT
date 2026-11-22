# ADR-0017: Insight aggregates in the service, as pseudonymous sets

**Status:** Proposed

## Context

Managers must see how their team is doing without seeing any person
([ADR-0005](0005-privacy-by-design.md)). That needs counts per team, day and activity type, and
every count has to say **how many different people** are behind it, because a count backed by two
people identifies them. "Different people" cannot be added up from smaller counts: the same person
is in Monday's cell and Tuesday's, and a week's cohort is not the sum of its days.

The first plan (roadmap step 6) was an analytics Lambda that writes aggregates to DynamoDB and an
Insight Service that reads them. Designing the data showed that this split buys nothing and costs
something:

- the Lambda and the service would have to agree on a storage layout that only they use;
- both would need the same pseudonymisation key and the same erasure logic;
- the service already needs its own event queue and consumer for `UserDeleted`.

## Decision

1. **The Insight Service consumes `ActivityCompleted` itself and writes the aggregates.** There is no
   analytics Lambda. The service owns its tables and everything that touches them.
2. **A cell keeps a counter and a set of pseudonyms.** One DynamoDB item per scope (a team, or the
   whole organisation), day and activity type holds `completions` and `people`, a string set of
   12-hex-character HMAC tokens. Adding to a set is idempotent, and the size of the set is the
   number of different people, for one cell or, by union, for any range of cells.
3. **Pseudonyms are keyed and scoped.** `HMAC-SHA-256(key, scope + user id)`. The same person has an
   unrelated token in each team, so cells cannot be joined to follow someone, and without the key a
   user id cannot be tested against the stored tokens.
4. **Counting once per event** uses one `TransactWriteItems` call that also creates a marker item for
   the event id with `attribute_not_exists`. A redelivery fails that condition and changes nothing.
5. **Two tables, two permission sets.** The _aggregates_ table (cells and markers) holds no user id and
   is all that manager and administrator requests read. The _personal_ table (per user, day and type)
   backs "my activity" and the erasure of a deleted person.
6. **Erasure takes a person back out.** On `UserDeleted` the service reads the person's personal days
   (which list the scopes each was counted in), and for each day, in one transaction, deletes the
   personal item, subtracts the count and removes the person's token from every cell.
7. **Counters expire** a fixed number of days after the activity day (default 400), through the
   database's time-to-live, so nothing is kept for ever.

## Alternatives considered

- **Per-day cohort counts only.** Simple, but a week's "number of people" could only be approximated
  by adding days, which over-counts, and a manager could be shown a cohort that is really smaller
  than K.
- **HyperLogLog or another sketch.** Compact and mergeable, but approximate. A privacy threshold
  needs an exact answer to "are there at least K people", and a sketch cannot be erased from.
- **Counting in the Lambda tier.** See above: an extra hop and a storage contract with no benefit.
- **No pseudonyms, a count of events only.** Cannot tell one active person from a crowd.

## Consequences

- (+) Exact cohort sizes over any period, which is what K-anonymity needs.
- (+) A deleted person's activity really leaves the aggregates, not only the personal table.
- (+) One service owns the whole flow; the only shared contract is the event.
- (-) A cell is limited by DynamoDB's 400 KB item size: about 20,000 people in one cell. One team is
  far below that, and the organisation scope is a limit to revisit for a very large company (shard
  the organisation cell by hash of the token).
- (-) Pseudonymous is not anonymous. The tokens are personal data while the key exists, so the key is
  a production secret, counters expire, and erasure removes them.
- (-) An activity that arrives after the person's `UserDeleted` would count them again. Events from a
  deleted account should stop, but the platform does not enforce an ordering.
- (-) A report for `[1..7]` and one for `[1..8]` can be subtracted to reveal day 8. Hiding small
  days helps, but the total difference is visible; fixed reporting periods would close it. See
  the Insight architecture document.
