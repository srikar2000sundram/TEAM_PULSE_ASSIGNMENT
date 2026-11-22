# 08. Habit Service

Habits, who may see them, and reminders. This service holds personal wellness data, so its main job
besides CRUD is to make sure a habit is never shown to someone who should not see it.

- Code: [`services/habit`](../../services/habit/README.md)
- API reference: [docs/api/habit.md](../api/habit.md) and the generated
  [`habit.openapi.json`](../api/habit.openapi.json)
- Decision: [ADR-0012](../adr/0012-visibility-enforced-in-the-query.md)

## Layers

```mermaid
flowchart LR
    subgraph inbound["Inbound adapter"]
        routes["HTTP routes<br/>defineRoute + zod contracts"]
    end

    subgraph core["Application core: no framework imports"]
        uc["Use cases<br/>CreateHabit, UpdateHabit, ArchiveHabit, ListHabits, ..."]
        react["Reactions<br/>EraseUserHabits, WithdrawHabitsFromTeam"]
        dom["Domain<br/>Habit, Sharing, Viewer, isVisibleTo"]
        ports["Ports<br/>HabitRepository, UnitOfWork, Outbox"]
    end

    subgraph outbound["Outbound adapters"]
        pg["PostgreSQL repository<br/>visibility in the WHERE clause"]
        ob["PostgresOutbox<br/>@teampulse/outbox"]
    end

    jwks["Identity JWKS<br/>verifies access tokens"]

    routes --> uc
    uc --> dom
    uc --> ports
    react --> ports
    pg -. "implements" .-> ports
    ob -. "implements" .-> ports
    routes -. "token check" .-> jwks
```

## Who sees which habit

One rule, `Habit.isVisibleTo`, written once in the domain and repeated as SQL in the repository.

```mermaid
flowchart TD
    q["Viewer asks for a habit"] --> o{"Viewer owns it?"}
    o -- yes --> see["Visible, archived or not"]
    o -- no --> a{"Archived?"}
    a -- yes --> hide["Hidden: 404"]
    a -- no --> s{"Shared with a team?"}
    s -- "private" --> hide
    s -- "team" --> m{"Viewer belongs to that team?<br/>from the access token"}
    m -- no --> hide
    m -- yes --> see2["Visible, read-only"]
    note["Roles do not appear anywhere in this chain.<br/>Admins and the team's manager follow the same path."] -.-> q
```

| Situation                                         | Result                            |
| ------------------------------------------------- | --------------------------------- |
| Owner reads, edits or archives their habit        | Allowed                           |
| Teammate reads a shared, active habit             | Allowed, `isOwner: false`         |
| Teammate edits or archives it                     | 403 `habit.not_owner`             |
| Anyone reads a private habit that is not theirs   | 404, identical to a missing habit |
| Manager of the team, not a member, reads anything | 404                               |
| Admin reads someone else's habit                  | 404                               |
| Teammate reads an archived shared habit           | 404                               |

Because the rule lives in the query, a hidden habit is never loaded into memory, and a new endpoint
cannot forget the check.

## Sharing lifecycle

```mermaid
stateDiagram-v2
    [*] --> Private: created (default)
    [*] --> Shared: created with a team the owner belongs to
    Private --> Shared: owner shares with one of their teams
    Shared --> Private: owner makes it private
    Shared --> Private: owner leaves the team (TeamMembershipChanged)
    Shared --> Shared: owner moves it to another of their teams
    Private --> Archived: owner archives
    Shared --> Archived: owner archives, teammates stop seeing it
    Archived --> [*]: read-only, never listed to others
    Private --> [*]: UserDeleted erases everything
    Shared --> [*]: UserDeleted erases everything
```

## Creating a habit

```mermaid
sequenceDiagram
    autonumber
    actor U as Browser
    participant R as HTTP routes
    participant C as CreateHabit
    participant DB as PostgreSQL

    U->>R: POST /habits with bearer token
    R->>R: verify RS256 token against Identity JWKS
    R->>R: validate body (strict schema, owner never accepted)
    R->>C: execute (owner and teams come from the token)
    C->>C: team habit? caller must belong to that team
    C->>DB: BEGIN
    C->>DB: count active habits of the owner (limit 50)
    C->>DB: INSERT habit
    C->>DB: INSERT outbox row HabitCreated (ids, type and reminder, no title)
    C->>DB: COMMIT
    R-->>U: 201 habit
    Note over DB: the relay (roadmap step 5) later publishes the outbox row to EventBridge
```

## Events

| Event           | Written when                                                                        | Payload                                              |
| --------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `HabitCreated`  | A habit is created                                                                  | habit id, owner, visibility, activity type, reminder |
| `HabitUpdated`  | Visibility, activity type or reminder changed, or a habit was withdrawn from a team | the same shape, as it is now. No reminder means none |
| `HabitArchived` | A habit is archived (once; archiving again is silent)                               | habit id, owner                                      |

Titles and descriptions are never in an event ([ADR-0005](../adr/0005-privacy-by-design.md)), so a
rename publishes nothing. The Notification Service replaces its reminder schedule from each
`HabitCreated` or `HabitUpdated`, and cancels it on `HabitArchived`.

### Events the service reacts to

| Event                               | Reaction                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `UserDeleted`                       | Delete every habit the user owned (right to erasure). Idempotent                     |
| `TeamMembershipChanged` (`removed`) | Make that person's habits shared with that team private, publish updates. Idempotent |

Both are wired to the service queue by the shared consumer
([09](09-event-tracking.md), [ADR-0014](../adr/0014-outbox-relay-and-idempotent-consumers.md)) and are tested
end to end through it, including redelivery.

## Data model

All tables live in the `habit` schema.

```mermaid
erDiagram
    habits {
        uuid id PK
        uuid owner_user_id "plain id, no foreign key: Identity owns users"
        text title "CHECK 1 to 80 characters"
        text description "CHECK at most 500, nullable"
        text activity_type "CHECK in the contract list"
        text visibility "CHECK private or team"
        uuid team_id "null exactly when private"
        jsonb reminder "days, time, IANA zone; nullable"
        timestamptz archived_at "null while active"
        timestamptz created_at
        timestamptz updated_at
    }
    outbox {
        uuid id PK
        text event_type
        jsonb payload
        timestamptz published_at "null until relayed"
    }
```

The database repeats the invariants as constraints, so a bug in application code cannot store a
half-shared habit (`(visibility = 'team') = (team_id IS NOT NULL)`), an empty title or an unknown
activity type. Two partial-order indexes serve the two lists: `(owner_user_id, created_at DESC, id
DESC)` for "mine" and a partial index on active team habits for the team feed. A unit test fails if
the activity type list in the migration differs from the contracts, so adding a type forces a new
migration.

## Rules worth knowing

- **Limits:** 80 characters for a title, 500 for a description, 50 active habits per user (soft: two
  simultaneous creations could both pass the check). Archiving frees a slot.
- **Reminders** carry an IANA time zone, because "07:30" means nothing to a scheduler without one.
  Days are stored in calendar order, so equal reminders compare equal.
- **Archived habits are read-only** (`409 habit.archived`) and are never listed to anyone but the
  owner.
- **Team membership comes from the token**, so it can be up to 15 minutes stale. Disabled or deleted
  users keep working until their token expires (a known limit shared with all non-Identity services).
