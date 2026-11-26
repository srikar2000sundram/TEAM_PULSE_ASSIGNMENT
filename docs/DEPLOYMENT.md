# Cloud deployment record (AWS, Mumbai)

This document records how TeamPulse was deployed to AWS and what was checked afterwards. It is the
deployment evidence for the submission (item 7). The infrastructure is also written as Terraform in
[`infra/terraform`](../infra/terraform) (see [17 Terraform](architecture/17-terraform.md)); the
environment described here was built step by step with the AWS Management Console and the AWS CLI,
using the same names, sizes and rules as the Terraform files.

- **Region:** Asia Pacific (Mumbai), `ap-south-1`. CloudFront and the web firewall are global
  services (their API lives in `us-east-1`).
- **Environment name:** `teampulse-dev`. Every resource name starts with this prefix.
- **Lifetime:** a short-lived environment, built for the demonstration and deleted the same day to
  avoid cost.

## 1. Status

| Area                                       | Status                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Network, security groups, database, queues | Built and checked                                                                                    |
| Container image, ECS services, scaling     | Built; all seven services running and healthy behind the load balancer                               |
| Lambda functions, event bus, rules         | Built                                                                                                |
| Monitoring (logs, metrics, alarms)         | Built                                                                                                |
| Website files in the S3 bucket             | Uploaded                                                                                             |
| CloudFront distribution                    | Created after AWS verified the account (distribution `E1TD36Z4TN4RPR`); the site answered over HTTPS |
| **Environment today**                      | **Deleted on 26 November 2026 after the demonstration was recorded** (see section 10)                |

CloudFront was first refused with the message "Your account must be verified before you can add new
CloudFront resources"; a support case was opened and the distribution was created once AWS had
verified the account. The services were then rolled to new task definition revisions that carry the
real CloudFront address, and the flow in section 8 was tested through it. The whole story, with every
other problem met on the way and how it was solved, is in
[TeamPulse-Build-Journey-and-Challenges.pdf](TeamPulse-Build-Journey-and-Challenges.pdf).

## 2. How the assignment's AWS services map to this deployment

| Assignment asks for                                 | What was built                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amazon S3 for the frontend, delivered globally      | Private bucket `teampulse-dev-web-<account>` (versioned, encrypted) holding the compiled web app; CloudFront with origin access control in front of it              |
| HTTPS/TLS                                           | CloudFront redirects HTTP to HTTPS; response-header policy adds HSTS and a Content-Security-Policy computed from the built page; RDS requires TLS (`rds.force_ssl`) |
| Separate VPC segments (public, application, data)   | VPC `10.0.0.0/16`, six subnets in two Availability Zones, three route tables                                                                                        |
| Application Load Balancer in public subnets         | Internet-facing ALB `teampulse-dev`; path rules `/api/v1/<service>/*` to seven target groups; default answer 403                                                    |
| Amazon ECS for the microservices, with auto scaling | Fargate cluster `teampulse-dev`; seven services; 1 to 4 tasks per service at 60% CPU; deployment circuit breaker with rollback                                      |
| Amazon RDS for transactional data                   | PostgreSQL 16 `db.t4g.micro`, in the data subnets, not public, encrypted, one schema per service                                                                    |
| Amazon DynamoDB                                     | Three on-demand tables: streaks and two Insight tables (with time-to-live)                                                                                          |
| EventBridge and Lambda                              | Event bus `teampulse-dev-bus`; nine rules; three Node.js 22 Lambda functions (streak, two badge functions)                                                          |
| Queues with dead-letter handling                    | Six service queues and nine dead-letter queues (SQS), encrypted, five receives before a message is parked                                                           |
| Secrets Manager                                     | Five secrets (database URL, token-signing key, log salt, Insight key, first administrator password); injected into containers at start                              |
| IAM roles with least privilege                      | Per service: an execution role and a task role, and one role per Lambda; every policy names its resources                                                           |
| Security groups and network ACLs                    | Three security groups chained by group; a network ACL around the data subnets                                                                                       |
| CloudWatch for logs, metrics, alerts                | Log group per service; 75 log metric filters; 87 alarms; one dashboard; two SNS topics                                                                              |
| Web application firewall                            | WAF web ACL: rate limit of 2000 requests per 5 minutes per address on `/api/`, plus two AWS managed rule sets                                                       |

## 3. The network

```mermaid
flowchart LR
    user(("Browser")) -->|HTTPS| cf["CloudFront + WAF"]
    cf -->|"files"| s3[("S3 web bucket")]
    cf -->|"/api/* + secret header"| alb["Application Load Balancer<br/>public subnets"]
    alb --> ecs["ECS Fargate: 7 services<br/>private app subnets"]
    ecs --> rds[("RDS PostgreSQL<br/>private data subnets")]
    ecs --> ddb[("DynamoDB")]
    ecs --> bus["EventBridge bus"]
    bus --> sqs["SQS queues"]
    bus --> lam["Lambda: streaks, badges"]
    sqs --> ecs
    lam --> ddb
```

| Tier   | Subnets (two zones)            | Route to the internet             | What lives there                  |
| ------ | ------------------------------ | --------------------------------- | --------------------------------- |
| Public | `10.0.0.0/24`, `10.0.1.0/24`   | Internet gateway                  | Load balancer, NAT gateway        |
| App    | `10.0.10.0/24`, `10.0.11.0/24` | Out only, through the NAT gateway | The seven services (no public IP) |
| Data   | `10.0.20.0/24`, `10.0.21.0/24` | None (only the local route)       | The database                      |

Free gateway endpoints connect the app subnets to S3 and DynamoDB without using the NAT gateway.
The data subnets have a network ACL that allows only PostgreSQL (port 5432) from the two app subnets.

Security groups reference each other, not address ranges:

| Group                | Inbound                                               | Outbound                                   |
| -------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `teampulse-dev-alb`  | HTTP 80 from the CloudFront origin-facing prefix list | TCP 3000 to the app group                  |
| `teampulse-dev-app`  | TCP 3000 from the load balancer group                 | HTTPS 443 anywhere, 5432 to the data group |
| `teampulse-dev-data` | PostgreSQL 5432 from the app group                    | none                                       |

## 4. Compute and the container image

- One backend image serves all seven services (the command picks which one runs). It is built from
  [`infra/docker/Dockerfile`](../infra/docker/Dockerfile), stored in a private ECR repository
  (`teampulse-dev/backend`, immutable tags, scan on push) and tagged with the build date.
- The image contains the AWS RDS certificate bundle, and the build checks its SHA-256, so the
  services can verify the database's TLS certificate.
- Each task is 0.25 vCPU and 512 MB, runs as a non-root user with a read-only root file system and
  a container health check on `/healthz`.
- Secrets are not in the image or in plain settings: the task definition lists Secrets Manager
  secrets, and ECS injects them when a task starts.
- Database tables and the first administrator are created by a one-off migrate task, run on demand
  (not on every start).

## 5. Events

The Identity, Habit, Event Tracking and Challenge services publish events to the bus. Rules route event types
to queues (one per consuming service) and to the three Lambda functions. A message that fails five
times moves to the queue's dead-letter queue; a Lambda rule retries twice within an hour and then
parks the event in its own dead-letter queue. An alarm fires for any message in a dead-letter queue.

## 6. Monitoring

Every service logs one JSON line per request (method, path, status, duration, correlation id) with
pseudonymised identifiers and no names or e-mail addresses. Metric filters turn those lines into
metrics; alarms cover latency, API failures, sign-in problems, dead-letter queues, unhealthy targets,
CPU and memory, Lambda errors, database load and storage, and DynamoDB throttling. They notify two
SNS topics (urgent and ticket). The exact definitions are in
[`infra/observability/monitoring.json`](../infra/observability/monitoring.json).

There is no alarm that counts container restarts directly, because that needs ECS Container
Insights, which is off to save cost. The "no healthy target" alarm and the running-task count on the
dashboard are the closest signals.

## 7. Evidence

Console and application screenshots, in the order a reader would follow the system. The account menu in the AWS header is masked. Files are in [`screenshots/`](screenshots).

### Compute overview

![ECS cluster `teampulse-dev`: seven services, one task each, all Active.](screenshots/01-ecs-services.png)

_ECS cluster `teampulse-dev`: seven services, one task each, all Active._

![After the rollout to task definition revision 3: 7 services active, 7 tasks running, last deployment Completed for each.](screenshots/22-ecs-services-rollout.png)

_After the rollout to task definition revision 3: 7 services active, 7 tasks running, last deployment Completed for each._

### Network

![VPC `teampulse-dev`: 10.0.0.0/16, DNS enabled, not the default VPC.](screenshots/02a-vpc-details.png)

_VPC `teampulse-dev`: 10.0.0.0/16, DNS enabled, not the default VPC._

![Resource map: six subnets in two zones and four route tables.](screenshots/02b-vpc-resource-map-subnets.png)

_Resource map: six subnets in two zones and four route tables._

![Resource map: internet gateway, NAT gateway and the S3 and DynamoDB endpoints.](screenshots/02c-vpc-resource-map-gateways.png)

_Resource map: internet gateway, NAT gateway and the S3 and DynamoDB endpoints._

![The three TeamPulse security groups (alb, app, data).](screenshots/03a-security-groups.png)

_The three TeamPulse security groups (alb, app, data)._

![Descriptions and rule counts: ALB only from CloudFront, tasks only from the ALB, database only from the tasks.](screenshots/03b-security-groups-rules.png)

_Descriptions and rule counts: ALB only from CloudFront, tasks only from the ALB, database only from the tasks._

### Load balancer

![Application Load Balancer, HTTP:80 listener with 8 rules and a default 403 response.](screenshots/04a-load-balancer-listener.png)

_Application Load Balancer, HTTP:80 listener with 8 rules and a default 403 response._

![Load balancer network mapping: one public subnet in each zone.](screenshots/04b-load-balancer-network-mapping.png)

_Load balancer network mapping: one public subnet in each zone._

![Load balancer security tab: its own security group.](screenshots/04d-load-balancer-security.png)

_Load balancer security tab: its own security group._

![Target group `teampulse-dev-identity`: one target, Healthy.](screenshots/05a-target-group-healthy.png)

_Target group `teampulse-dev-identity`: one target, Healthy._

![Target group: targets by availability zone.](screenshots/05b-target-group-distribution.png)

_Target group: targets by availability zone._

![Health-check settings: path `/healthz`, 2 successes to be healthy, 3 failures to be unhealthy.](screenshots/05c-target-group-health-checks.png)

_Health-check settings: path `/healthz`, 2 successes to be healthy, 3 failures to be unhealthy._

### Containers

![Task definition `teampulse-dev-habit:3`: Fargate, 0.25 vCPU, 512 MiB, task role and execution role, image tag.](screenshots/06a-task-definition-overview.png)

_Task definition `teampulse-dev-habit:3`: Fargate, 0.25 vCPU, 512 MiB, task role and execution role, image tag._

![Environment variables; `DATABASE_URL` and the log salt come from Secrets Manager (`valueFrom`), no value shown.](screenshots/06b-task-definition-environment-secrets.png)

_Environment variables; `DATABASE_URL` and the log salt come from Secrets Manager (`valueFrom`), no value shown._

![ECR repository `teampulse-dev/backend` with the tagged image.](screenshots/07a-ecr-repository.png)

_ECR repository `teampulse-dev/backend` with the tagged image._

![Image scan result: 0 critical, 6 high, 7 medium, 4 low.](screenshots/07b-ecr-image-scan.png)

_Image scan result: 0 critical, 6 high, 7 medium, 4 low._

### Data

![RDS `teampulse-dev-db`: available, PostgreSQL, `sslmode=verify-full` in the connect snippet.](screenshots/08a-rds-connect-snippets.png)

_RDS `teampulse-dev-db`: available, PostgreSQL, `sslmode=verify-full` in the connect snippet._

![RDS alarms (OK) and recent events.](screenshots/08b-rds-alarms-events.png)

_RDS alarms (OK) and recent events._

![RDS configuration: PostgreSQL 16, encrypted, gp3 storage, single zone.](screenshots/08c-rds-configuration.png)

_RDS configuration: PostgreSQL 16, encrypted, gp3 storage, single zone._

![RDS connectivity: Publicly accessible = No, data security group.](screenshots/08d-rds-connectivity-not-public.png)

_RDS connectivity: Publicly accessible = No, data security group._

![RDS security group rule: only the application group may connect.](screenshots/08e-rds-security-group-rules.png)

_RDS security group rule: only the application group may connect._

![Three on-demand DynamoDB tables.](screenshots/09-dynamodb-tables.png)

_Three on-demand DynamoDB tables._

### Events

![Fifteen SQS queues: six working queues and nine dead-letter queues, all empty.](screenshots/10-sqs-queues.png)

_Fifteen SQS queues: six working queues and nine dead-letter queues, all empty._

![The custom EventBridge bus `teampulse-dev-bus`.](screenshots/11a-eventbridge-bus.png)

_The custom EventBridge bus `teampulse-dev-bus`._

![Bus details and the first rules.](screenshots/11b-eventbridge-rules-top.png)

_Bus details and the first rules._

![All nine rules, all Enabled.](screenshots/11c-eventbridge-rules-all.png)

_All nine rules, all Enabled._

![The three Lambda functions (Node.js 22).](screenshots/12-lambda-functions.png)

_The three Lambda functions (Node.js 22)._

### Security

![The five secrets (values never opened).](screenshots/13-secrets-manager.png)

_The five secrets (values never opened)._

![IAM roles: service-linked roles and the first TeamPulse roles.](screenshots/14a-iam-roles-top.png)

_IAM roles: service-linked roles and the first TeamPulse roles._

![An execution role and a task role per service, plus the Lambda and CodeBuild roles.](screenshots/14b-iam-roles-teampulse.png)

_An execution role and a task role per service, plus the Lambda and CodeBuild roles._

### Monitoring

![Dashboard `teampulse-dev`: traffic and errors, events, security.](screenshots/15a-cloudwatch-dashboard-top.png)

_Dashboard `teampulse-dev`: traffic and errors, events, security._

![Dashboard: platform row (ECS CPU, Lambda errors, database CPU).](screenshots/15b-cloudwatch-dashboard-platform.png)

_Dashboard: platform row (ECS CPU, Lambda errors, database CPU)._

![Alarms overview (101 in total: 87 defined here plus 14 created by ECS auto scaling).](screenshots/16a-cloudwatch-alarms-top.png)

_Alarms overview (101 in total: 87 defined here plus 14 created by ECS auto scaling)._

![The auto-scaling `AlarmLow` alarms are "In alarm" while the system is idle; this is normal scale-in behaviour, not a fault.](screenshots/16b-cloudwatch-alarms-autoscaling.png)

_The auto-scaling `AlarmLow` alarms are "In alarm" while the system is idle; this is normal scale-in behaviour, not a fault._

![Security, memory and database alarms, all OK.](screenshots/16c-cloudwatch-alarms-security.png)

_Security, memory and database alarms, all OK._

![The two SNS alert topics (page and ticket).](screenshots/21-sns-topics.png)

_The two SNS alert topics (page and ticket)._

### CloudFront, S3 and the firewall

![CloudFront distribution `E1TD36Z4TN4RPR`: domain, description, price class and default root object.](screenshots/19a-cloudfront-general.png)

_CloudFront distribution `E1TD36Z4TN4RPR`: domain, description, price class and default root object._

![CloudFront security tab: the web ACL is attached and enabled.](screenshots/19b-cloudfront-waf-enabled.png)

_CloudFront security tab: the web ACL is attached and enabled._

![Requests evaluated by the web ACL in the last 24 hours.](screenshots/19c-cloudfront-security-trends.png)

_Requests evaluated by the web ACL in the last 24 hours._

![The two origins: the S3 bucket (origin access control) and the load balancer.](screenshots/19d-cloudfront-origins.png)

_The two origins: the S3 bucket (origin access control) and the load balancer._

![Behaviors: `/api/*` to the load balancer (HTTPS only, no caching) and the default to S3.](screenshots/19e-cloudfront-behaviors.png)

_Behaviors: `/api/*` to the load balancer (HTTPS only, no caching) and the default to S3._

![S3 web bucket: Block all public access on, and a policy that lets only the distribution read it.](screenshots/17a-s3-permissions-policy.png)

_S3 web bucket: Block all public access on, and a policy that lets only the distribution read it._

![S3: bucket owner enforced, no ACL access for anyone else.](screenshots/17b-s3-object-ownership-acl.png)

_S3: bucket owner enforced, no ACL access for anyone else._

![S3: versioning enabled.](screenshots/17c-s3-properties-versioning.png)

_S3: versioning enabled._

![The compiled web app in the bucket.](screenshots/17d-s3-objects.png)

_The compiled web app in the bucket._

![WAF web ACL `teampulse-dev`: rate limit and two AWS managed rule sets.](screenshots/18-waf-web-acl.png)

_WAF web ACL `teampulse-dev`: rate limit and two AWS managed rule sets._

![The web ACL's associated resource: the CloudFront distribution.](screenshots/20-waf-associated-resources.png)

_The web ACL's associated resource: the CloudFront distribution._

### The running application (through CloudFront)

![Sign-in page over HTTPS.](screenshots/app-01-login.png)

_Sign-in page over HTTPS._

![Dashboard after sign-in: active days and activities.](screenshots/app-02-dashboard.png)

_Dashboard after sign-in: active days and activities._

![The trend chart as an accessible table, and the privacy note.](screenshots/app-03-dashboard-trend-table.png)

_The trend chart as an accessible table, and the privacy note._

![Habits page: the form to add a habit.](screenshots/app-04-habits.png)

_Habits page: the form to add a habit._

![A new habit typed in.](screenshots/app-05-new-habit-typed.png)

_A new habit typed in._

!["Habit created." and the habit listed under Today.](screenshots/app-06-habit-created.png)

_"Habit created." and the habit listed under Today._

![Recommendation service: best time 09:00, six of the last six completions.](screenshots/app-07-recommendation.png)

_Recommendation service: best time 09:00, six of the last six completions._

![Accepting turns the recommendation into a daily reminder.](screenshots/app-08-recommendation-accepted.png)

_Accepting turns the recommendation into a daily reminder._

![Team challenge with five participants.](screenshots/app-09-challenges.png)

_Team challenge with five participants._

![Personal analytics (visible only to the person).](screenshots/app-10-my-activity.png)

_Personal analytics (visible only to the person)._

![Team page hiding numbers while fewer than five people are behind them.](screenshots/app-11-team-privacy.png)

_Team page hiding numbers while fewer than five people are behind them._

## 8. Verified

- The seven ECS services each reached a steady state with one running task, and all seven target
  groups reported the task healthy.
- The migrate task exited with code 0, created the tables for the six database-backed services and
  the first administrator.
- The container image's certificate bundle matched its pinned checksum during the build.
- Monitoring was created: 75 log metric filters, 87 alarms and one dashboard; two SNS topics exist.
  An e-mail subscription to both topics was confirmed, and a test alarm state change delivered an
  alarm e-mail.
- End to end through CloudFront: the home page and `/api/v1/health` answered 200; a seeded employee
  signed in; habits, challenges and the personal activity report loaded; marking a habit done today
  returned 201; the challenge's progress then showed points; the Recommendation Service returned a
  suggestion (09:00, six of six matching days, high confidence); all nine dead-letter queues held 0
  messages.
- In the browser, through CloudFront: sign-in, dashboard, adding a habit, the recommendation and its
  acceptance, challenges, personal activity and the team page (screenshots above). A manager signed
  in and saw team totals once five people had activity (36 completions from 5 participants).
- A test alarm was forced into the ALARM state and the alarm e-mail arrived.

## 9. Not verified, and known limits

- The Lambda functions' own log output was not inspected separately; their effect (streaks, badges)
  is visible through the challenge points and the dashboard.
- One of the two e-mail alert subscriptions (the "ticket" topic) was never confirmed, so only the
  "page" topic is proven to deliver e-mail.
- The Terraform in `infra/terraform` has not been applied or validated by Terraform itself.
- The load balancer listens on HTTP only; CloudFront connects to it over HTTP inside AWS. A header
  secret and the security group stop other callers.
- No secret rotation; the Lambda log salt is a plain environment variable (a limit of the Lambda
  console). Alarm thresholds are first guesses and untuned.
- The ECR image scan reported findings (6 high, 7 medium, 4 low, 1 undefined) that were not yet
  triaged; they are most likely in the base operating-system image.
- The environment uses a single NAT gateway and a single-zone database, which is acceptable for a
  demonstration and noted as a risk for production.

## 10. Cost and teardown

A running environment costs roughly 0.25 US dollars per hour (NAT gateway, database, load balancer,
seven Fargate tasks, firewall and alarms). After the demonstration was recorded, everything was
deleted on 26 November 2026, in dependency order: services and cluster, load balancer and target
groups, NAT gateway and Elastic IP, database, queues, functions, event bus, tables, buckets, image
repository, secrets, CloudFront distribution and its policies, firewall, IAM roles, logs, alarms,
dashboard, SNS topics and the VPC. A sweep of all 17 AWS regions afterwards found no resources left
(only AWS's own default VPC, which is free). Budget alerts remain at 20 and 100 US dollars.
