# ADR-0012: Habit visibility is enforced in the query, and roles grant nothing

**Status:** Proposed

## Context

Habits are personal wellness data. The case study lets an employee keep a habit private or share it
with their team, and says managers see only aggregates. A bug that shows one person's private habit
to someone else is the worst failure this service can have. A visibility check written after the
data is loaded (`if (!canSee(habit)) return 404`) is one forgotten call away from a leak, and every
new endpoint is another place to forget it.

## Decision

1. **One definition of visibility**, `Habit.isVisibleTo(viewer)`: the owner always sees a habit;
   everyone else sees it only while it is **active**, **shared with a team**, and they **belong to
   that team** (taken from their access token).
2. **The repository enforces it in SQL.** `findVisible(id, viewer)` and `list(query)` put the rule in
   the `WHERE` clause. A habit the viewer may not see is never loaded, so use cases cannot forget to
   check, and "hidden" is the same outcome as "does not exist" (404, identical body).
3. **Roles grant nothing.** Admins, and managers of the team, follow the same rule as anyone else.
   Managers see a team through aggregates (Insight Service, K-anonymity), never individual habits.
   `managedTeamIds` is deliberately not part of the `Viewer` type, so it cannot be used by mistake.
4. **404 when hidden, 403 when visible but not yours.** A teammate who can already see a shared habit
   learns nothing new from a 403 on edit; a stranger gets 404 and learns nothing.
5. **The rule has a contract test.** The repository contract suite runs one matrix (owner, member,
   other team, archived, private) through the in-memory fake, PGlite and the real `pg` driver and
   compares each result with `isVisibleTo`. A mutation that dropped the archived filter from the SQL
   failed exactly that test.

## Alternatives considered

- **Check after loading.** Simple, but a forgotten check leaks data.
- **PostgreSQL row-level security.** Strong, but it needs per-request session variables, which
  connection poolers (RDS Proxy, PgBouncer) make fragile, and it hides the rule from the code.
- **Managers can see their team's habits.** Contradicts the case study's privacy promise.

## Consequences

- Team membership comes from the token, so someone removed from a team can keep seeing its shared
  habits for up to one token lifetime (15 minutes). Identity's `TeamMembershipChanged` event also
  makes Habit withdraw the leaver's own shared habits, so the reverse direction is immediate.
- Adding a new way to read habits means going through the repository, where the rule already lives.
