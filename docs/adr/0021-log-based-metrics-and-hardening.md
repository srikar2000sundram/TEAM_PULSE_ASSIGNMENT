# ADR-0021: Metrics from log lines, and hardening decisions from the step 12 review

**Status:** Proposed

## Context

The services already write one structured JSON line per request and per notable event. CloudWatch can
count those lines, so the platform can be monitored without a metrics library in every service. Step 12
also reviewed the platform's defences, and the review found concrete defects.

## Decision

1. **Metrics come from log lines** through CloudWatch metric filters, defined as data in
   `infra/observability/monitoring.json` and turned into resources by Terraform. Alarms and the
   dashboard are defined in the same file. AWS's own metrics cover the load balancer, ECS, RDS, SQS,
   Lambda and DynamoDB.
2. **A test evaluates every filter against real log output**, so a renamed log field or event breaks
   the build instead of silently silencing an alarm.
3. **The services trust exactly one proxy** and take the client address that proxy appended. nginx
   (locally) writes it from the connection. A client-supplied `X-Forwarded-For` is never believed.
4. **Every state-changing route has a rate limit**, and the list of public routes is fixed by a test.
5. **The web container sends a Content-Security-Policy** that allows scripts only from the app and the
   one inline script by SHA-256 hash (computed at image build time). **Inline styles are allowed**,
   because the web components inject their CSS as `<style>` elements into shadow roots.
6. **HSTS is set at CloudFront or the ALB**, not in the container.

## Alternatives considered

- **A metrics library (for example OpenTelemetry or CloudWatch embedded metrics) in every service.**
  More precise (custom dimensions, no log parsing), but touches every service and adds a dependency.
  Log-based metrics need no code change. Revisit if a metric needs data the log line lacks.
- **`'unsafe-inline'` for scripts**, or a nonce. Rejected: the hash keeps scripts locked at no cost.
- **A strict `style-src`.** Tried first and rejected after a browser check showed it unstyled the web
  components. Making them use constructable stylesheets would allow it later.
- **Distributed rate limiting** (a shared counter in Redis or DynamoDB). Limits are per task; a WAF rate
  rule gives a global limit without new infrastructure to run.

## Consequences

- (+) Monitoring needs no change to service code, and it is tested against what the code writes.
- (+) A client can no longer choose its own rate-limit bucket; every write route is limited.
- (-) Metric filters are a little less flexible than a metrics library and cost log ingestion.
- (-) Inline styles weaken the CSP slightly (CSS injection, not script execution).
- (-) Limits are per task until a WAF rule is added, so N tasks allow N times a limit.
