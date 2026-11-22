# ADR-0009: Infrastructure as code with Terraform

**Status:** Proposed

## Context

The AWS footprint (VPC, ALB, ECS, ECR, RDS, DynamoDB, EventBridge, Lambda, IAM, CloudWatch) is
large and security sensitive. Manual console setup is not reviewable or repeatable.

## Decision

- **Terraform** with modules: `network`, `ecs-service`, `data`, `eventing`, `frontend`,
  `observability`. Environments (`dev`, `prod`) are separate root configurations with
  remote state (S3 + DynamoDB lock).
- Each service gets its IAM role from the `ecs-service` module, with policies built from
  explicit resource ARNs.
- `terraform fmt`, `validate` and a security scan run in CI.

## Alternatives considered

| Option         | Why not                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| AWS CDK        | Good fit with TypeScript, but heavier abstractions and CloudFormation limits |
| CloudFormation | Verbose; weaker module reuse                                                 |
| Console        | Not reproducible or reviewable                                               |

## Consequences

- (+) Reviewable, repeatable environments; security rules visible in code.
- (-) Terraform state must be protected; secrets must never be written into state in clear text
  (use Secrets Manager references and managed rotation).
- (-) Docker is not available on the current development machine, so images and the local
  compose stack cannot be run here until Docker is installed.
