# 05. AWS Deployment and Security (Session 3)

All infrastructure is defined as code with Terraform ([ADR-0009](../adr/0009-infrastructure-as-code.md)).

## Network topology

```mermaid
flowchart TB
    user(["Users"]) --> cf["CloudFront + ACM certificate"]
    cf --> s3[("S3 frontend bucket<br/>private, origin access control")]
    user --> alb

    subgraph vpc["VPC 10.0.0.0/16, two Availability Zones"]
        subgraph public["Public subnets 10.0.0.0/24, 10.0.1.0/24"]
            alb["Application Load Balancer<br/>HTTPS 443 only"]
            nat["NAT gateway"]
        end

        subgraph private_app["Private app subnets 10.0.10.0/24, 10.0.11.0/24"]
            ecs["ECS Fargate services<br/>6 microservices"]
            lam["Lambda functions<br/>in VPC"]
        end

        subgraph private_data["Private data subnets 10.0.20.0/24, 10.0.21.0/24"]
            rds[("RDS PostgreSQL<br/>Multi-AZ")]
        end

        vpce["VPC endpoints<br/>S3, DynamoDB, ECR, Secrets Manager,<br/>CloudWatch Logs, EventBridge, SQS"]
    end

    alb --> ecs
    ecs --> rds
    lam --> rds
    ecs --> vpce
    lam --> vpce
    ecs --> nat
    vpce --> ddb[("DynamoDB")]
    vpce --> eb{{"EventBridge"}}
    vpce --> sm["Secrets Manager"]
    vpce --> ecr["ECR"]
```

The data subnets have **no route to the internet**. Services reach AWS APIs through VPC
endpoints, which keeps traffic off the public internet and reduces NAT cost.

## Layered network controls

```mermaid
flowchart LR
    internet(["Internet"]) -->|"443"| sgAlb["SG alb<br/>in: 443 from internet"]
    sgAlb -->|"service ports"| sgApp["SG app<br/>in: only from SG alb"]
    sgApp -->|"5432"| sgDb["SG data<br/>in: only from SG app and SG lambda"]
    sgLam["SG lambda"] -->|"5432"| sgDb
```

| Control         | Rule                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| Security groups | Reference other security groups, never CIDR ranges, between tiers           |
| Network ACLs    | Data subnets allow 5432 only from app subnets; deny everything else inbound |
| TLS             | HTTPS at CloudFront and ALB (TLS 1.2 minimum); RDS `rds.force_ssl = 1`      |
| Encryption      | KMS at rest for RDS, DynamoDB, S3, SQS and logs                             |
| Public exposure | Only CloudFront and the ALB are internet reachable                          |

## Compute and delivery

```mermaid
flowchart LR
    dev["Developer pushes"] --> ci["CI: lint, typecheck, test, scan"]
    ci --> build["Build Docker images"]
    build --> ecr[("ECR private registry<br/>immutable tags = git SHA")]
    ecr --> deploy["Deploy: new ECS task definition"]
    deploy --> ecs["ECS service<br/>rolling update + circuit breaker"]
    ci --> fe["Build SvelteKit static site"]
    fe --> s3[("S3")]
    s3 --> inv["CloudFront invalidation"]
```

| Concern     | Decision                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| Compute     | ECS on Fargate, one service per microservice, no servers to patch         |
| Scaling     | Target tracking on CPU 60 percent, plus request count per target for HTTP |
| Deployments | Rolling update, minimum healthy 100 percent, deployment circuit breaker   |
| Images      | Multi-stage, non-root user, read-only root filesystem, scanned on push    |
| Health      | `/healthz` (liveness) and `/readyz` (readiness, checks dependencies)      |

## IAM: least privilege per service

```mermaid
flowchart TB
    subgraph roles["One task role per service"]
        rid["identity-task-role"]
        rhb["habit-task-role"]
        rch["challenge-task-role"]
        ret["event-tracking-task-role"]
        rin["insight-task-role"]
        rnt["notification-task-role"]
    end

    rid --> s1["Secrets: identity DB credentials, JWT signing key"]
    rhb --> s2["Secrets: habit DB credentials"]
    rch --> s3["Secrets: challenge DB credentials<br/>SQS: receive from challenge queue"]
    ret --> s4["Secrets: eventtracking DB credentials<br/>EventBridge: PutEvents on teampulse-bus<br/>SQS: receive from eventtracking queue"]
    rin --> s5["DynamoDB: analytics tables only<br/>SQS: receive from insight queue"]
    rnt --> s6["Secrets: notification DB credentials<br/>SQS: receive from notification queue<br/>SES: SendEmail"]
```

Separate **execution role** (pull image, write logs, read secrets at start) from **task role**
(what the application code may do). Policies name exact resource ARNs; no wildcard resources.

## Secrets and configuration

| Kind                 | Where it lives                           | How the app gets it                               |
| -------------------- | ---------------------------------------- | ------------------------------------------------- |
| Database credentials | Secrets Manager, auto-rotated            | ECS injects as environment variable at start      |
| JWT signing key      | Secrets Manager                          | Identity Service only; others use the public JWKS |
| Non-secret settings  | Task definition environment variables    | Parsed and validated by `config/`                 |
| Local development    | `.env` (git-ignored) from `.env.example` | Same parser as production                         |

Rule: **no secret in source control, container images or logs.** The config loader fails fast at
startup when a required value is missing or invalid.

## Observability

```mermaid
flowchart LR
    ecs["ECS services<br/>structured JSON logs"] --> cwl["CloudWatch Logs"]
    lam["Lambda"] --> cwl
    ecs --> cwm["CloudWatch metrics"]
    alb["ALB"] --> cwm
    sqs["SQS"] --> cwm
    cwm --> dash["Dashboards"]
    cwm --> alarm["Alarms"]
    cwl --> filt["Metric filters<br/>auth failures"]
    filt --> alarm
    alarm --> sns["SNS topic"] --> oncall["On-call email or chat"]
```

| Signal from the case study | Alarm                                                        |
| -------------------------- | ------------------------------------------------------------ |
| Latency                    | ALB target response time p95 above 800 ms for 5 minutes      |
| API failures               | ALB 5xx rate above 2 percent for 5 minutes                   |
| Authentication issues      | Metric filter on `auth.login.failed` above 20 per 5 minutes  |
| Queue depth                | DLQ visible messages above 0; main queue age above 5 minutes |
| Service restarts           | ECS running task count below desired, or task stopped events |
| Lambda errors              | Errors above 0 for 5 minutes; throttles above 0              |

Every log line is JSON with `service`, `level`, `correlationId`, `userId` (hashed) and never
contains habit titles or other wellness content.

## Cost and complexity notes

The case study asks for private networking, Multi-AZ and per-service roles. That is the right
shape for production but it is expensive for a learning project. The Terraform in step 11 will
have an `environment` variable: `dev` uses a single NAT gateway, single-AZ RDS and smaller tasks.
