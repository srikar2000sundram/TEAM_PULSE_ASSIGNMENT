# ADR-0022: Terraform layout, one public origin, and a configurable proxy count

**Status:** Proposed

## Context

Step 11 turns the AWS design (document 05) into Terraform. Writing it exposed three places where the
design and the code disagreed: how browsers reach the API, whether the Lambdas need the VPC, and how
the services learn the client's address behind more than one proxy.

## Decision

1. **One flat Terraform configuration**, split by concern across files, with `dev` and `prod` selected by
   one variable. No modules: there is one deployment of one system, and modules would add indirection
   before there is a second consumer.
2. **CloudFront is the only public entrance**, serving the web app from S3 and forwarding `/api/*` to the
   load balancer. The load balancer accepts only CloudFront's address list and a secret header.
3. **Lambdas run outside the VPC** because they use only DynamoDB and EventBridge.
4. **`TRUST_PROXY` is a count** (`false`, `true` = 1, or 1 to 3). AWS runs it at 2.
5. **Monitoring is read from `monitoring.json`** by Terraform rather than copied into it, so the file the
   tests check is the file that is deployed.
6. **Terraform's facts are checked as text** by `tools/test/terraform.test.ts`: event routing against the
   local topology, log service names, the CSP against the nginx template, production settings against
   the services' real config loaders, and a few security rules.

## Alternatives considered

- **Direct ALB access with its own domain.** Needs a domain and certificate before anything works, and a
  second site breaks `SameSite=Strict`.
- **Modules per layer.** Rejected for now (see 1).
- **Lambdas in the VPC.** Matches the first diagram but adds NAT cost and cold-start time for no benefit.
- **A fixed `hop < 2`.** Would break local runs (one proxy). A count keeps both correct.

## Consequences

- (+) A browser sees one HTTPS origin; the services see the real client for rate limits.
- (+) Alarms and the dashboard cannot drift from the definitions that are tested.
- (-) CloudFront to the load balancer is plain HTTP inside AWS until a domain and certificate exist.
- (-) Never validated against AWS: first `validate` and `plan` may need small fixes.
- (-) A wrong `TRUST_PROXY` count is a silent security or correctness problem, so it must match reality.
