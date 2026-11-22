# ADR-0005: Privacy by design: aggregates and K-anonymity

**Status:** Proposed

## Context

The business goal forbids exposing personal wellness data broadly, and the end-to-end flow says
managers see "only aggregated trends". Aggregation alone is not enough: in a team of two, an
"average" reveals each person.

## Decision

1. Manager and admin analytics endpoints read only **aggregate tables** that contain no user ids.
2. Aggregates are **suppressed when the cohort is smaller than K** (`MIN_COHORT_SIZE`,
   default 5, configurable per environment).
3. Private habits are filtered **in the data access query**, not after loading.
4. Events and logs carry identifiers and counts, never habit titles or free text.
5. Administrators manage users and configuration but have **no access** to individual wellness data.

## Alternatives considered

| Option                             | Why not                                               |
| ---------------------------------- | ----------------------------------------------------- |
| Role checks only                   | A manager endpoint bug would leak raw data            |
| Differential privacy (added noise) | Stronger guarantee, but complex and out of scope here |

## Consequences

- (+) The privacy promise is enforced by data shape, not only by code paths.
- (+) Easy to explain and to test: "an aggregate with 4 participants returns suppressed".
- (-) Small teams get less insight; the UI explains this instead of showing empty charts.
- (-) K is a policy value; HR/legal should confirm it before production use. **Open question.**
