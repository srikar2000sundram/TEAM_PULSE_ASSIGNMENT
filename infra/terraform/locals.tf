data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name    = "teampulse-${var.environment}"
  is_prod = var.environment == "prod"
  account = data.aws_caller_identity.current.account_id
  azs     = slice(data.aws_availability_zones.available.names, 0, 2)

  desired_count           = coalesce(var.desired_count, local.is_prod ? 2 : 1)
  db_instance_class       = var.db_instance_class != "" ? var.db_instance_class : (local.is_prod ? "db.t4g.small" : "db.t4g.micro")
  use_interface_endpoints = coalesce(var.use_interface_endpoints, local.is_prod)
  nat_gateway_count       = local.is_prod ? 2 : 1

  monitoring = jsondecode(file(var.monitoring_file))

  # One entry per microservice. `priority` orders the load balancer rules; `queue` is true when the
  # service consumes events; `database` when it uses PostgreSQL; `dynamodb` when it uses the Insight tables.
  services = {
    identity       = { priority = 10, cpu = 256, memory = 512, queue = false, database = true, dynamodb = false, publishes = true }
    habit          = { priority = 20, cpu = 256, memory = 512, queue = true, database = true, dynamodb = false, publishes = true }
    event-tracking = { priority = 30, cpu = 256, memory = 512, queue = true, database = true, dynamodb = false, publishes = true }
    challenge      = { priority = 40, cpu = 256, memory = 512, queue = true, database = true, dynamodb = false, publishes = true }
    insight        = { priority = 50, cpu = 256, memory = 512, queue = true, database = false, dynamodb = true, publishes = false }
    notification   = { priority = 60, cpu = 256, memory = 512, queue = true, database = true, dynamodb = false, publishes = false }
  }

  # Who listens to which events. This mirrors tools/local/topology.mjs, which a unit test checks
  # against the handlers the services register. Terraform cannot import that file, so
  # tools/test/terraform.test.ts checks this table against it too.
  service_events = {
    habit          = ["UserDeleted", "TeamMembershipChanged"]
    event-tracking = ["HabitCreated", "HabitUpdated", "HabitArchived", "UserDeleted"]
    notification   = ["MilestoneReached", "BadgeAwarded", "ChallengeJoined", "ChallengeCompleted", "HabitCreated", "HabitUpdated", "HabitArchived", "UserDeleted"]
    challenge      = ["ActivityCompleted", "TeamMembershipChanged", "UserDeleted"]
    insight        = ["ActivityCompleted", "UserDeleted"]
  }

  lambdas = {
    streak = {
      events  = ["ActivityCompleted"]
      bundle  = "streak"
      handler = "index.handler"
    }
    badge-streak = {
      events  = ["StreakUpdated"]
      bundle  = "badge"
      handler = "index.handler"
    }
    badge-totals = {
      events  = ["ActivityCompleted"]
      bundle  = "badge"
      handler = "index.totalsHandler"
    }
  }

  tables = {
    streaks    = "${local.name}-streaks"
    aggregates = "${local.name}-insight-aggregates"
    personal   = "${local.name}-insight-personal"
  }

  # The public address of the platform. Everything (web app and API) is served from it, so the
  # SameSite=Strict refresh cookie works and no cross-origin requests exist.
  public_origin = "https://${aws_cloudfront_distribution.web.domain_name}"
}
