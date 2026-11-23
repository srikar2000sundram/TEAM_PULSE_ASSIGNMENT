# ECR, the ECS cluster, one Fargate service per microservice, and least-privilege IAM for each.
# Two kinds of role per service (docs/architecture/05):
#   execution role = what ECS itself needs to start the task (pull the image, write logs, read the secrets)
#   task role      = what the application code may do while running (its own queue, the bus, its tables)

resource "aws_ecr_repository" "backend" {
  name                 = "${local.name}/backend"
  image_tag_mutability = "IMMUTABLE" # a tag is a git SHA and never changes meaning
  force_delete         = !local.is_prod

  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 30 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = local.is_prod ? "enabled" : "disabled"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.services
  name              = "/teampulse/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/teampulse/${var.environment}/migrate"
  retention_in_days = var.log_retention_days
}

# --- Which secrets each service reads -----------------------------------------------------------

locals {
  # Name of the environment variable -> the secret that fills it.
  service_secrets = {
    for name, svc in local.services : name => merge(
      svc.database ? { DATABASE_URL = "database-url" } : {},
      name == "identity" ? { JWT_PRIVATE_KEY_PEM = "jwt-private" } : {},
      name == "insight" ? { INSIGHT_PSEUDONYM_KEY = "insight-key" } : {},
      { LOG_PSEUDONYM_SALT = "log-salt" },
    )
  }

  common_environment = {
    NODE_ENV   = "production"
    PORT       = "3000"
    LOG_LEVEL  = "info"
    AWS_REGION = var.region
    # CloudFront, then the load balancer: two proxies in front of every service, so the client's
    # address is the third from the right in X-Forwarded-For (see ADR-0022).
    TRUST_PROXY  = "2"
    CORS_ORIGINS = local.public_origin
  }

  service_environment = {
    for name, svc in local.services : name => merge(
      local.common_environment,
      svc.database ? {
        DATABASE_SSL        = "true"
        NODE_EXTRA_CA_CERTS = "/app/certs/rds-global-bundle.pem"
      } : {},
      svc.publishes ? { EVENT_BUS_NAME = aws_cloudwatch_event_bus.main.name } : {},
      svc.queue ? { EVENTS_QUEUE_URL = aws_sqs_queue.main[name].url } : {},
      name == "identity" ? { COOKIE_SECURE = "true" } : { IDENTITY_JWKS_URL = "${local.public_origin}/api/v1/identity/.well-known/jwks.json" },
      name == "insight" ? {
        AGGREGATES_TABLE_NAME = local.tables.aggregates
        PERSONAL_TABLE_NAME   = local.tables.personal
      } : {},
    )
  }
}

# --- Execution roles ----------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each           = merge(local.services, { migrate = {} })
  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  for_each = merge(local.services, { migrate = {} })

  statement {
    sid       = "PullImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.backend.arn]
  }
  statement {
    sid       = "ECRLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action does not support resource-level permissions
  }
  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = each.key == "migrate" ? ["${aws_cloudwatch_log_group.migrate.arn}:*"] : ["${aws_cloudwatch_log_group.service[each.key].arn}:*"]
  }
  statement {
    sid     = "ReadOwnSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = each.key == "migrate" ? [
      aws_secretsmanager_secret.app["database-url"].arn,
      aws_secretsmanager_secret.app["jwt-private"].arn,
      aws_secretsmanager_secret.app["log-salt"].arn,
      aws_secretsmanager_secret.admin.arn,
      ] : [
      for secret in distinct(values(local.service_secrets[each.key])) : aws_secretsmanager_secret.app[secret].arn
    ]
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = merge(local.services, { migrate = {} })
  name     = "start-task"
  role     = aws_iam_role.execution[each.key].id
  policy   = data.aws_iam_policy_document.execution[each.key].json
}

# --- Task roles ---------------------------------------------------------------------------------

resource "aws_iam_role" "task" {
  for_each           = local.services
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  for_each = local.services

  # Every policy needs at least one statement; reading one's own log group is always allowed.
  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.service[each.key].arn}:*"]
  }

  dynamic "statement" {
    for_each = each.value.queue ? [1] : []
    content {
      sid       = "ConsumeOwnQueue"
      actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
      resources = [aws_sqs_queue.main[each.key].arn]
    }
  }

  dynamic "statement" {
    for_each = each.value.publishes ? [1] : []
    content {
      sid       = "PublishToTheBus"
      actions   = ["events:PutEvents"]
      resources = [aws_cloudwatch_event_bus.main.arn]
    }
  }

  dynamic "statement" {
    for_each = each.value.dynamodb ? [1] : []
    content {
      sid = "InsightTables"
      actions = [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
        "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
      ]
      resources = [for table in aws_dynamodb_table.insight : table.arn]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  for_each = local.services
  name     = "application"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.task[each.key].json
}

# --- Task definitions and services ---------------------------------------------------------------

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # Node writes nowhere but /tmp, so the root filesystem can be read-only.
  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = each.key
    image                  = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
    essential              = true
    command                = ["services/${each.key}/dist/main.js"]
    readonlyRootFilesystem = true
    user                   = "node"
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = [for key, value in local.service_environment[each.key] : { name = key, value = value }]
    secrets = [
      for variable, secret in local.service_secrets[each.key] : {
        name      = variable
        valueFrom = aws_secretsmanager_secret.app[secret].arn
      }
    ]
    healthCheck = {
      command     = ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.service[each.key].name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "task"
      }
    }
  }])
}

resource "aws_ecs_service" "service" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = local.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.service[each.key].arn
    container_name   = each.key
    container_port   = 3000
  }

  # Scaling changes the count, so Terraform must not fight it back.
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy.execution, aws_iam_role_policy.task]
}

resource "aws_appautoscaling_target" "service" {
  for_each           = local.services
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.service[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = local.desired_count
  max_capacity       = local.desired_count * 4
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = local.services
  name               = "cpu-60"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# --- One-off task: database migrations and the first administrator ------------------------------
# Run it by hand after the first apply and after each release that adds migrations
# (see the AWS deployment notes). It is a task definition only; nothing runs it automatically.

variable "admin_email" {
  description = "Email address of the first administrator. Empty uses alert_email."
  type        = string
  default     = ""
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["migrate"].arn
  # No task role: migrations only need the database, which is reached with the password.

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = "migrate"
    image                  = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    user                   = "node"
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    entryPoint             = ["sh", "-c"]
    command = [join(" && ", [
      "node services/identity/dist/adapters/persistence/migrate-cli.js",
      "node services/habit/dist/adapters/persistence/migrate-cli.js",
      "node services/event-tracking/dist/adapters/persistence/migrate-cli.js",
      "node services/challenge/dist/adapters/persistence/migrate-cli.js",
      "node services/notification/dist/adapters/persistence/migrate-cli.js",
      "node services/recommendation/dist/adapters/persistence/migrate-cli.js",
      "(node services/identity/dist/cli/bootstrap-admin.js || echo 'bootstrap-admin skipped: an administrator probably exists already')",
    ])]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DATABASE_SSL", value = "true" },
      { name = "NODE_EXTRA_CA_CERTS", value = "/app/certs/rds-global-bundle.pem" },
      { name = "ADMIN_EMAIL", value = var.admin_email != "" ? var.admin_email : var.alert_email },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.app["database-url"].arn },
      { name = "JWT_PRIVATE_KEY_PEM", valueFrom = aws_secretsmanager_secret.app["jwt-private"].arn },
      { name = "LOG_PSEUDONYM_SALT", valueFrom = aws_secretsmanager_secret.app["log-salt"].arn },
      { name = "ADMIN_PASSWORD", valueFrom = aws_secretsmanager_secret.admin.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "task"
      }
    }
  }])
}
