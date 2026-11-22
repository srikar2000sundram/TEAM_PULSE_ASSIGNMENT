# ADR-0019: A local AWS with LocalStack, run by Docker or Podman

**Status:** Proposed

## Context

Most of the platform's behaviour depends on the event bus: a habit only becomes known to Event
Tracking through `HabitCreated`, a point only reaches the leaderboard through `ActivityCompleted`.
Without a local bus, nothing past login could be tried by hand, and the tests that stand in for the
bus cannot show that the real SDK calls, queue URLs and rules work together. Docker is not installed
on the development machine; Podman is.

## Decision

1. **A compose stack** ([`infra/local/compose.yaml`](../../infra/local/compose.yaml)) runs PostgreSQL,
   LocalStack, the services, the Lambdas and the web app. It works with `docker compose` and
   `podman compose`; a small script picks whichever is installed.
2. **LocalStack provides EventBridge, SQS and DynamoDB.** The services use the AWS SDK's standard
   `AWS_ENDPOINT_URL`, so no service contains a line of local-only code.
3. **LocalStack is pinned to 3.8.1.** Current releases refuse to start without an account token.
4. **The bus, queues, rules and tables come from one file** (`tools/local/topology.mjs`). A unit test
   compares its per-service event lists with the handlers each service really registers.
5. **Lambdas run in a small runner** that reads each function's queue and calls its handler with an
   EventBridge-shaped message. LocalStack's own Lambda support needs the container engine's socket,
   which differs between Docker and Podman, and would test LocalStack more than our code.
6. **One backend image** for all services (the command chooses), built from one Dockerfile with
   separate `backend` and `web` targets.
7. **Secrets are generated per computer** (`make-env`) and kept in a git-ignored file.

## Alternatives considered

- **DynamoDB Local plus ElasticMQ plus our own EventBridge imitation.** No account token, but we would
  write and maintain a fake of an AWS service. Rejected for as long as a pinned LocalStack works.
- **A database-backed queue for development only.** Adds a second code path in every service that
  production never runs.
- **LocalStack Lambda.** See decision 5.
- **A Dockerfile per service now.** Six near-identical builds of a 1 GB dependency tree on a small
  machine; deferred to the pipeline (step 10).

## Consequences

- (+) The whole flow runs locally and an end-to-end script proves it, including real queues, rules,
  DynamoDB transactions and both Lambdas.
- (+) Docker and Podman users follow the same commands.
- (-) LocalStack 3.8.1 gets no fixes. If it breaks, the fallback is the first alternative above.
- (-) The Lambda runner is not Lambda: timeouts, memory limits and cold starts are untested until AWS.
- (-) The backend image is large and contains sources.
