# 19. Network architecture

The network the platform runs in on AWS, exactly as described by the Terraform in
[`infra/terraform`](../../infra/terraform) (`network.tf`, `security_groups.tf`, `alb.tf`, `frontend.tf`,
`waf.tf`). Region `eu-west-1`, two Availability Zones.

## The picture

```mermaid
flowchart TB
    user(["Browser"])

    subgraph edge["AWS edge (global)"]
        waf["WAF<br/>rate limit 2000 per 5 min per address on /api/<br/>AWS common and bad-input rule sets"]
        cf["CloudFront<br/>HTTPS only, security headers, HSTS"]
        s3[("S3 bucket<br/>web app files<br/>private, origin access control")]
    end

    user -->|"HTTPS 443"| waf --> cf
    cf -->|"everything except /api/*"| s3

    subgraph vpc["VPC 10.0.0.0/16, eu-west-1"]
        igw["Internet gateway"]

        subgraph pub["Public subnets: 10.0.0.0/24 (zone a), 10.0.1.0/24 (zone b)"]
            alb["Application Load Balancer<br/>security group: HTTP 80 from CloudFront only<br/>rule needs header X-Origin-Verify"]
            nat["NAT gateway<br/>(outbound only)"]
        end

        subgraph app["App subnets: 10.0.10.0/24 (a), 10.0.11.0/24 (b)"]
            ecs["ECS Fargate tasks, port 3000<br/>identity, habit, event-tracking, challenge,<br/>insight, notification, recommendation<br/>security group: 3000 from the load balancer only"]
        end

        subgraph data["Data subnets: 10.0.20.0/24 (a), 10.0.21.0/24 (b)<br/>no route to the internet, network ACL: 5432 from app subnets only"]
            rds[("RDS PostgreSQL 16<br/>security group: 5432 from the tasks only<br/>encrypted, TLS required")]
        end

        vpce["Gateway endpoints<br/>S3 and DynamoDB"]
    end

    cf -->|"/api/* over HTTP 80<br/>adds X-Origin-Verify"| alb
    igw --- pub
    alb -->|"3000"| ecs
    ecs -->|"5432 TLS"| rds
    ecs -->|"outbound 443"| nat --> igw
    ecs --> vpce

    subgraph managed["AWS managed services (reached over HTTPS)"]
        eb{{"EventBridge bus"}}
        sqs["SQS queues and dead-letter queues"]
        lam["Lambda functions (outside the VPC)<br/>streak, badge-streak, badge-totals"]
        ddb[("DynamoDB<br/>streaks, insight tables")]
        sm["Secrets Manager"]
        cw["CloudWatch logs, alarms, dashboard"]
    end

    ecs -.-> eb -.-> sqs -.-> ecs
    eb -.-> lam -.-> ddb
    ecs -.-> ddb
    ecs -.-> sm
    ecs -.-> cw
    lam -.-> cw
```

## Who may talk to whom

| From          | To              | Port | Allowed by                                                             |
| ------------- | --------------- | ---- | ---------------------------------------------------------------------- |
| Internet      | CloudFront      | 443  | Public. WAF in front. HTTP is redirected to HTTPS                      |
| CloudFront    | S3              | 443  | Origin access control; bucket policy allows only this distribution     |
| CloudFront    | Load balancer   | 80   | Load balancer security group: CloudFront's address list, nothing else  |
| Anyone else   | Load balancer   | any  | Refused. The listener answers 403 without the secret `X-Origin-Verify` |
| Load balancer | Tasks           | 3000 | Task security group accepts only the load balancer's group             |
| Tasks         | RDS             | 5432 | Database group accepts only the task group; the data-tier ACL as well  |
| Tasks         | AWS APIs, JWKS  | 443  | Outbound only, through the NAT gateway (or gateway endpoints)          |
| Internet      | Tasks, database | any  | No route and no rule: neither has a public address                     |
| Database      | Anywhere        | any  | No outbound rule at all                                                |

## Layers of protection

1. **WAF** at the edge: floods and known bad requests never reach the VPC.
2. **CloudFront** is the only public entrance: HTTPS, security headers, one origin for the site and the API.
3. **Security groups** name each tier's only allowed caller (group to group, not address ranges).
4. **Network ACL** on the data subnets: a second lock, PostgreSQL from the app subnets only.
5. **Private routing:** the data subnets have no route to the internet; the app subnets reach out
   only through the NAT gateway.
6. **TLS** from the browser to CloudFront and from the services to the database.

## Known limit

The hop from CloudFront to the load balancer is plain HTTP inside AWS's network, protected by the
address list and the secret header. Encrypting it needs a custom domain and certificate. See
[17 Terraform](17-terraform.md) and [ADR-0022](../adr/0022-terraform-structure.md).
