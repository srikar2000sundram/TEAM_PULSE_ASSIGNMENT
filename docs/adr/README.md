# Architecture Decision Records

An ADR captures one significant decision, the alternatives considered, and the consequences.
They are immutable once accepted: to change a decision, add a new ADR that supersedes the old one.

| #                                                     | Title                                         | Status   |
| ----------------------------------------------------- | --------------------------------------------- | -------- |
| [0001](0001-monorepo-and-typescript.md)               | Monorepo with npm workspaces and TypeScript   | Proposed |
| [0002](0002-hexagonal-architecture-and-solid.md)      | Hexagonal architecture and SOLID              | Proposed |
| [0003](0003-database-per-service.md)                  | Database per service                          | Proposed |
| [0004](0004-event-driven-integration.md)              | Event-driven integration with outbox          | Proposed |
| [0005](0005-privacy-by-design.md)                     | Privacy by design: aggregates and K-anonymity | Proposed |
| [0006](0006-authentication-and-authorization.md)      | Authentication and authorization              | Proposed |
| [0007](0007-frontend-static-spa.md)                   | Frontend as a static SPA                      | Proposed |
| [0008](0008-web-components-and-design-tokens.md)      | Web components and design tokens              | Proposed |
| [0009](0009-infrastructure-as-code.md)                | Infrastructure as code with Terraform         | Proposed |
| [0010](0010-refresh-token-rotation.md)                | Refresh token rotation with reuse detection   | Proposed |
| [0011](0011-test-against-real-postgres.md)            | Test persistence against real PostgreSQL      | Proposed |
| [0012](0012-visibility-enforced-in-the-query.md)      | Habit visibility enforced in the query        | Proposed |
| [0013](0013-shared-persistence-packages.md)           | Shared db, outbox and testing packages        | Proposed |
| [0014](0014-outbox-relay-and-idempotent-consumers.md) | Outbox relay and idempotent consumers         | Proposed |
| [0015](0015-deterministic-ids-for-derived-events.md)  | Deterministic ids for derived events          | Proposed |
| [0016](0016-reminders-by-claimed-ticks.md)            | Habit reminders by claimed ticks              | Proposed |
| [0017](0017-insight-aggregates-in-the-service.md)     | Insight aggregates as pseudonymous sets       | Proposed |
| [0018](0018-challenge-scoring-in-the-service.md)      | Challenge scoring and badges in the service   | Proposed |
| [0019](0019-local-aws-with-localstack.md)             | Local AWS with LocalStack, Docker or Podman   | Proposed |
| [0020](0020-github-actions-ci.md)                     | GitHub Actions for continuous integration     | Proposed |
| [0021](0021-log-based-metrics-and-hardening.md)       | Metrics from log lines; step 12 hardening     | Proposed |
| [0022](0022-terraform-structure.md)                   | Terraform layout, one origin, proxy count     | Proposed |
| [0023](0023-timing-recommendations.md)                | Timing recommendations from a histogram       | Proposed |

Statuses: **Proposed** (awaiting your review), **Accepted**, **Superseded**.

Template: copy any record and keep the sections Context, Decision, Alternatives, Consequences.
