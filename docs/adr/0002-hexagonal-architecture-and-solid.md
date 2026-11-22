# ADR-0002: Hexagonal architecture and SOLID

**Status:** Proposed

## Context

Six services will evolve independently. Business rules (streaks, visibility, badge rules) must be
testable without databases or HTTP, and infrastructure (PostgreSQL, EventBridge) must be
replaceable without touching those rules.

## Decision

Every service uses **ports and adapters** with the dependency rule "source code dependencies
point inward". Layers: `domain` (pure), `application` (use cases + ports), `adapters`
(HTTP, persistence, messaging), and a single **composition root** (`main.ts`) that wires
concrete classes by hand (no DI container).

SOLID is applied concretely, see [engineering guidelines](../engineering/guidelines.md).

## Alternatives considered

| Option                      | Why not                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| Layered MVC with ORM models | Domain rules leak into persistence classes; slow, DB-bound tests |
| NestJS with decorators/DI   | Productive, but couples the core to a framework                  |
| Transaction scripts         | Fine for tiny services, becomes tangled with streak/badge rules  |

## Consequences

- (+) Unit tests run in milliseconds against fakes; adapters get focused integration tests.
- (+) Swapping Fastify, PostgreSQL client or EventBridge touches only adapters.
- (-) More files and interfaces than a quick script; we accept this for the larger services and
  keep very small services (such as Notification) lean rather than over-abstracted.
