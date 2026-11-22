# 01. System Context and Containers

This document follows the C4 model: **Level 1** (system context) and **Level 2** (containers).
Source requirements: `Case Study 2 - TeamPulse.pdf`.

## Goal

Help employees build healthy habits and compete in team challenges **without exposing personal
data broadly across the organization**. Privacy is the central architectural constraint, not a
feature added later (see [ADR-0005](../adr/0005-privacy-by-design.md)).

## Level 1: System context

```mermaid
flowchart TB
    employee(["Employee<br/>tracks habits, joins challenges"])
    manager(["Manager<br/>views aggregated team trends only"])
    admin(["Administrator<br/>manages users, teams, challenges, config"])

    tp["TeamPulse<br/>Internal wellness and consistency platform"]

    idp[("Corporate identity<br/>optional future SSO")]
    mail["Email / push provider<br/>delivers reminders"]

    employee -->|"HTTPS"| tp
    manager -->|"HTTPS"| tp
    admin -->|"HTTPS"| tp
    tp -.->|"future: OIDC federation"| idp
    tp -->|"sends notifications"| mail
```

| Actor         | Can do                                                         | Must never see                  |
| ------------- | -------------------------------------------------------------- | ------------------------------- |
| Employee      | Own habits, team-shared habits, challenges, own analytics      | Another person's private habits |
| Manager       | Aggregated team trends, challenge management for their teams   | Any individual's wellness data  |
| Administrator | Users, roles, teams, challenge catalog, platform configuration | Individual wellness data        |

## Level 2: Containers

```mermaid
flowchart TB
    subgraph clients["Clients"]
        browser["Browser<br/>SvelteKit SPA, Svelte 5 runes"]
    end

    subgraph edge["Edge"]
        cf["CloudFront CDN"]
        s3[("S3 bucket<br/>static frontend")]
    end

    subgraph pub["Public subnets"]
        alb["Application Load Balancer<br/>HTTPS / TLS"]
    end

    subgraph app["Private app subnets: ECS Fargate"]
        idsvc["Identity Service"]
        habit["Habit Service"]
        chal["Challenge Service"]
        evt["Event Tracking Service"]
        insight["Insight Service"]
        notif["Notification Service"]
    end

    subgraph async["Event-driven layer"]
        bus{{"EventBridge bus<br/>teampulse-bus"}}
        sqs[["SQS queues + DLQs"]]
        lam["Lambda functions<br/>streak, badge, analytics"]
    end

    subgraph data["Private data subnets"]
        rds[("RDS PostgreSQL<br/>schema per service")]
        ddb[("DynamoDB<br/>streaks and analytics")]
    end

    sm["Secrets Manager"]
    cw["CloudWatch<br/>logs, metrics, alarms"]

    browser --> cf
    cf --> s3
    browser -->|"API calls"| alb
    alb --> idsvc & habit & chal & evt & insight & notif

    idsvc & habit & chal & evt & notif --> rds
    evt -->|"publishes events"| bus
    bus --> lam
    bus --> sqs
    lam --> ddb
    lam -->|"emits derived events"| bus
    sqs --> chal & notif & insight & evt
    insight --> ddb

    app -. "reads secrets" .-> sm
    app -. "logs, metrics" .-> cw
    lam -. "logs, metrics" .-> cw
```

## Container responsibilities

| Container         | Technology                | Responsibility                                               |
| ----------------- | ------------------------- | ------------------------------------------------------------ |
| Web app           | SvelteKit, Svelte 5, TS   | Role-based UI, reactive filters, reusable UI components      |
| Identity Service  | Node, Fastify, PostgreSQL | Login, JWT issuing, roles, teams and memberships             |
| Habit Service     | Node, Fastify, PostgreSQL | Private and team-shared habit definitions                    |
| Challenge Service | Node, Fastify, PostgreSQL | Challenges, participation, leaderboards, badge rules         |
| Event Tracking    | Node, Fastify, PostgreSQL | Records activity completions, publishes events, streak reads |
| Insight Service   | Node, Fastify, DynamoDB   | Aggregated team analytics and self-only individual analytics |
| Notification      | Node, Fastify, PostgreSQL | Reminders, challenge updates, milestone messages             |
| Lambdas           | Node, TypeScript          | Streaks, badge evaluation, analytics aggregation             |

## Key architectural rules

1. **Database per service.** No service reads another service's tables. Cross-service data
   moves through APIs or events ([ADR-0003](../adr/0003-database-per-service.md)).
2. **Asynchronous by default** for anything derived from an activity completion
   ([ADR-0004](../adr/0004-event-driven-integration.md)).
3. **Aggregate before exposing.** Manager-facing endpoints return only aggregates that meet a
   minimum cohort size ([ADR-0005](../adr/0005-privacy-by-design.md)).
4. **Stateless services.** Any state lives in RDS, DynamoDB or the event bus, so ECS can scale
   tasks freely.
