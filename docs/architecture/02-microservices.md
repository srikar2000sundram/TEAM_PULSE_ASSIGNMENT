# 02. Microservices Design (Session 1)

## Service map

```mermaid
flowchart LR
    fe["Web app"]

    subgraph sync["Synchronous REST via ALB"]
        id["Identity"]
        hb["Habit"]
        ch["Challenge"]
        et["Event Tracking"]
        in["Insight"]
        nt["Notification"]
    end

    fe --> id & hb & ch & et & in & nt

    hb -. "validates team membership<br/>(JWT claims, no call)" .- id
    ch -. "validates team membership<br/>(JWT claims, no call)" .- id
```

Services trust **signed JWT claims** (user id, roles, team ids) so the hot path does not call
Identity on every request ([ADR-0006](../adr/0006-authentication-and-authorization.md)).

## Bounded contexts and data ownership

```mermaid
erDiagram
    IDENTITY_USER ||--o{ IDENTITY_MEMBERSHIP : "belongs to"
    IDENTITY_TEAM ||--o{ IDENTITY_MEMBERSHIP : "has"
    IDENTITY_USER {
        uuid id PK
        string email UK
        string password_hash
        string role "employee, manager, admin"
        timestamptz created_at
    }
    IDENTITY_TEAM {
        uuid id PK
        string name
        uuid manager_user_id
    }
    IDENTITY_MEMBERSHIP {
        uuid user_id PK
        uuid team_id PK
    }

    HABIT ||--o{ HABIT_SCHEDULE : "repeats on"
    HABIT {
        uuid id PK
        uuid owner_user_id
        uuid team_id "null when private"
        string title
        string visibility "private, team"
        string activity_type
        boolean archived
    }
    HABIT_SCHEDULE {
        uuid habit_id PK
        string days_of_week
        time remind_at
    }

    CHALLENGE ||--o{ PARTICIPATION : "has"
    CHALLENGE ||--o{ BADGE_RULE : "defines"
    CHALLENGE {
        uuid id PK
        string name
        string activity_type
        date starts_on
        date ends_on
        string status "draft, active, completed, cancelled"
        uuid created_by_user_id
    }
    PARTICIPATION {
        uuid challenge_id PK
        uuid user_id PK
        uuid team_id
        int points
    }
    BADGE_RULE {
        uuid id PK
        uuid challenge_id
        string kind "streak, total, milestone"
        int threshold
    }

    ACTIVITY_EVENT ||--o| OUTBOX_MESSAGE : "emits"
    ACTIVITY_EVENT {
        uuid id PK
        uuid user_id
        uuid habit_id
        string activity_type
        timestamptz occurred_at
        string idempotency_key UK
    }
    OUTBOX_MESSAGE {
        uuid id PK
        uuid activity_event_id
        string event_type
        jsonb payload
        timestamptz published_at "null until sent"
    }
    STREAK_READ_MODEL {
        uuid user_id PK
        uuid habit_id PK
        int current_streak
        int longest_streak
    }
```

> Foreign keys across services (for example `owner_user_id`) are **plain identifiers with no
> database constraint**. Each service owns its schema and may only enforce integrity inside it.

The Identity Service is described in detail in [07 Identity Service](07-identity-service.md) , the
Habit Service in [08 Habit Service](08-habit-service.md) Event Tracking with the event plumbing in
[09 Event Tracking](09-event-tracking.md), the Lambdas in [10](10-lambdas.md), Notification in
[11](11-notification-service.md), Insight in [12](12-insight-service.md) and Challenge in
[13](13-challenge-service.md).

## Service catalogue

| Service        | Owns                                                               | Store                | Publishes                                                                           | Consumes                                                                                                                                    |
| -------------- | ------------------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity       | Users, roles, teams, memberships                                   | RDS `identity`       | `UserRegistered`, `TeamMembershipChanged`                                           | none                                                                                                                                        |
| Habit          | Habits, reminders, visibility                                      | RDS `habit`          | `HabitCreated`, `HabitUpdated`, `HabitArchived`                                     | `UserDeleted`, `TeamMembershipChanged`                                                                                                      |
| Challenge      | Challenges, participation, scoring ledger, leaderboard, badges     | RDS `challenge`      | `ChallengeJoined`, `ChallengeCompleted`, `ChallengeProgressUpdated`, `BadgeAwarded` | `ActivityCompleted`, `TeamMembershipChanged`, `UserDeleted`                                                                                 |
| Event Tracking | Activity log, outbox, streak read model                            | RDS `eventtracking`  | `ActivityCompleted`                                                                 | `StreakUpdated`, `HabitCreated`, `HabitUpdated`, `HabitArchived`, `UserDeleted`                                                             |
| Insight        | Aggregated analytics: team cells (pseudonymous), personal counters | DynamoDB, two tables | none                                                                                | `ActivityCompleted`, `UserDeleted`                                                                                                          |
| Notification   | Preferences, notification log                                      | RDS `notification`   | none                                                                                | `MilestoneReached`, `BadgeAwarded`, `ChallengeJoined`, `ChallengeCompleted`, `HabitCreated`, `HabitUpdated`, `HabitArchived`, `UserDeleted` |

## Internal architecture of every service

All services use the same **hexagonal (ports and adapters)** layout so engineers can move
between them without relearning structure ([ADR-0002](../adr/0002-hexagonal-architecture-and-solid.md)).

```mermaid
flowchart LR
    subgraph inbound["Inbound adapters"]
        http["HTTP routes<br/>Fastify"]
        queue["SQS consumer"]
    end

    subgraph core["Application core: no framework imports"]
        uc["Use cases<br/>application layer"]
        dom["Domain<br/>entities, value objects, policies"]
        ports["Ports<br/>interfaces"]
    end

    subgraph outbound["Outbound adapters"]
        repo["PostgreSQL repository"]
        pub["EventBridge publisher"]
        clock["System clock"]
    end

    http --> uc
    queue --> uc
    uc --> dom
    uc --> ports
    repo -. "implements" .-> ports
    pub -. "implements" .-> ports
    clock -. "implements" .-> ports
```

Dependencies point **inward only**: adapters know the core, the core never knows adapters.

### Folder layout (each service)

```text
services/<name>/
  src/
    domain/            entities, value objects, domain errors, policies (pure TypeScript)
    application/       use cases and port interfaces
    adapters/
      http/            Fastify routes, request/response schemas, mappers
      persistence/     repositories, migrations
      messaging/       EventBridge publisher, SQS consumers
    config/            typed, validated configuration
    main.ts            composition root: the only place that wires concrete classes
  test/
    unit/              domain and use cases, no I/O
    integration/       adapters against real dependencies
  Dockerfile
  README.md
```

## Challenge lifecycle

```mermaid
stateDiagram-v2
    [*] --> Draft: manager creates
    Draft --> Active: start date reached or manually started
    Draft --> Cancelled: manager cancels
    Active --> Completed: end date reached
    Active --> Cancelled: manager or admin cancels
    Completed --> [*]
    Cancelled --> [*]
```

## Habit visibility rules

```mermaid
flowchart TD
    req["Request to read a habit"] --> own{"Requester owns<br/>the habit?"}
    own -- yes --> allow["Allow"]
    own -- no --> vis{"Visibility"}
    vis -- private --> deny["Deny: 404, do not reveal existence"]
    vis -- team --> member{"Requester in the<br/>habit's team?"}
    member -- yes --> allow
    member -- no --> deny
```

A denied read returns **404, not 403**, so private habits cannot be discovered by probing.
