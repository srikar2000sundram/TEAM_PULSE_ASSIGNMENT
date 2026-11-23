# CloudWatch metric filters, alarms and the dashboard, generated from infra/observability/monitoring.json
# (docs/architecture/16). The definitions are data; this file only expands them. Adding an alarm means
# editing that JSON file, and tools/test/monitoring.test.ts checks it against what the code logs.

resource "aws_sns_topic" "page" {
  name = "${local.name}-alerts-page"
}

resource "aws_sns_topic" "ticket" {
  name = "${local.name}-alerts-ticket"
}

# Each address must click the confirmation link AWS emails, or nothing is delivered.
resource "aws_sns_topic_subscription" "page" {
  topic_arn = aws_sns_topic.page.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic_subscription" "ticket" {
  topic_arn = aws_sns_topic.ticket.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  namespace = local.monitoring.namespace

  # What each service logs in its "service" field. The JSON file uses the short name; the logger adds
  # "-service" (and the Lambdas log "streak-lambda" and "badge-lambda"). The dimension of a log metric
  # is that logged value, so alarms must use it too. tools/test/terraform.test.ts pins this naming.
  log_service_name = { for name, _ in local.services : name => "${name}-service" }

  # --- metric filters ---------------------------------------------------------------------------

  filter_targets = flatten([
    for metric in local.monitoring.logMetrics : [
      for target in(
        metric.appliesTo == "services" ? keys(local.services) :
        metric.appliesTo == "lambdas" ? keys(local.lambdas) :
        try(tolist(metric.appliesTo), [])
        ) : {
        key    = "${metric.name}/${target}"
        metric = metric
        group  = contains(keys(local.services), target) ? aws_cloudwatch_log_group.service[target].name : aws_cloudwatch_log_group.lambda[target].name
      }
    ]
  ])

  # --- alarms ------------------------------------------------------------------------------------

  dead_letter_queues = merge(
    { for name, queue in aws_sqs_queue.dlq : name => queue.name },
    { for name, queue in aws_sqs_queue.lambda_dlq : "lambda-${name}" => queue.name },
  )

  expansions = {
    services         = [for name in keys(local.services) : { id = name, value = name }]
    lambdas          = [for name in keys(local.lambdas) : { id = name, value = "${local.name}-${name}" }]
    deadLetterQueues = [for name, queue in local.dead_letter_queues : { id = name, value = queue }]
    tables           = [for name, table in local.tables : { id = name, value = table }]
    none             = [{ id = "all", value = "" }]
  }

  infrastructure_values = {
    "{cluster}"      = aws_ecs_cluster.main.name
    "{loadBalancer}" = aws_lb.main.arn_suffix
    "{database}"     = aws_db_instance.main.identifier
  }

  alarm_instances = flatten([
    for alarm in local.monitoring.alarms : [
      for target in local.expansions[alarm.expand] : {
        key   = "${alarm.id}/${target.id}"
        alarm = alarm
        value = target.value
        # Placeholder replacement, one expansion kind per alarm, so a single pass is enough.
        dimensions = {
          for name, template in alarm.dimensions : name => (
            alarm.type == "aws" ?
            replace(replace(replace(replace(replace(replace(replace(template,
              "{cluster}", local.infrastructure_values["{cluster}"]),
              "{loadBalancer}", local.infrastructure_values["{loadBalancer}"]),
              "{database}", local.infrastructure_values["{database}"]),
              "{service}", target.value),
              "{lambda}", target.value),
              "{queue}", target.value),
            "{table}", target.value) :
            "${replace(template, "{service}", target.value)}-service"
          )
        }
      }
    ]
  ])
}

resource "aws_cloudwatch_log_metric_filter" "main" {
  for_each       = { for target in local.filter_targets : target.key => target }
  name           = "${local.name}-${replace(each.key, "/", "-")}"
  log_group_name = each.value.group
  pattern        = each.value.metric.pattern

  metric_transformation {
    name       = each.value.metric.name
    namespace  = local.namespace
    value      = each.value.metric.value
    unit       = each.value.metric.unit
    dimensions = { Service = "$.service" }
  }
}

resource "aws_cloudwatch_metric_alarm" "main" {
  for_each = { for instance in local.alarm_instances : instance.key => instance }

  alarm_name        = "${local.name}-${replace(each.key, "/", "-")}"
  alarm_description = "${replace(each.value.alarm.title, "{service}", each.value.value)}. First step: ${each.value.alarm.action}"
  alarm_actions     = [each.value.alarm.severity == "page" ? aws_sns_topic.page.arn : aws_sns_topic.ticket.arn]
  ok_actions        = [each.value.alarm.severity == "page" ? aws_sns_topic.page.arn : aws_sns_topic.ticket.arn]

  comparison_operator = each.value.alarm.comparison
  threshold           = each.value.alarm.threshold
  evaluation_periods  = each.value.alarm.evaluationPeriods
  datapoints_to_alarm = each.value.alarm.datapointsToAlarm
  treat_missing_data  = each.value.alarm.treatMissingData

  # A plain metric: custom (from a log filter) or AWS's own.
  metric_name        = each.value.alarm.type == "ratio" ? null : each.value.alarm.metric
  namespace          = each.value.alarm.type == "ratio" ? null : try(each.value.alarm.namespace, local.namespace)
  period             = each.value.alarm.type == "ratio" ? null : each.value.alarm.period
  statistic          = each.value.alarm.type == "ratio" || can(regex("^p[0-9]", try(each.value.alarm.statistic, ""))) ? null : each.value.alarm.statistic
  extended_statistic = each.value.alarm.type != "ratio" && can(regex("^p[0-9]", try(each.value.alarm.statistic, ""))) ? each.value.alarm.statistic : null
  dimensions         = each.value.alarm.type == "ratio" ? null : each.value.dimensions

  # A ratio: 100 * numerator / denominator, both custom metrics with the same dimension.
  dynamic "metric_query" {
    for_each = each.value.alarm.type == "ratio" ? {
      numerator   = try(each.value.alarm.numerator, "")
      denominator = try(each.value.alarm.denominator, "")
    } : {}
    content {
      id = metric_query.key
      metric {
        metric_name = metric_query.value
        namespace   = local.namespace
        period      = each.value.alarm.period
        stat        = "Sum"
        dimensions  = each.value.dimensions
      }
    }
  }

  dynamic "metric_query" {
    for_each = each.value.alarm.type == "ratio" ? [1] : []
    content {
      id          = "ratio"
      expression  = "100 * numerator / denominator"
      label       = "Percent"
      return_data = true
    }
  }

  depends_on = [aws_cloudwatch_log_metric_filter.main]
}

# --- Dashboard ------------------------------------------------------------------------------------

locals {
  # The metric lines of one widget, as lists of strings: namespace, metric name, then dimension pairs.
  dashboard_rows = [
    for row in local.monitoring.dashboard.rows : {
      title = row.title
      widgets = [
        for widget in row.widgets : {
          title     = widget.title
          statistic = widget.statistic
          metrics = (
            widget.per == "service" ? [
              for name in keys(local.services) : (
                try(widget.namespace, "") == "AWS/ECS"
                ? tolist(["AWS/ECS", widget.metric, "ClusterName", aws_ecs_cluster.main.name, "ServiceName", name])
                : tolist([local.namespace, widget.metric, "Service", local.log_service_name[name]])
              )
            ] :
            widget.per == "identity" ? [
              tolist([local.namespace, widget.metric, "Service", local.log_service_name["identity"]])
            ] :
            widget.per == "lambda" ? [
              for name in keys(local.lambdas) : tolist(["AWS/Lambda", widget.metric, "FunctionName", "${local.name}-${name}"])
            ] :
            widget.per == "deadLetterQueue" ? [
              for name, queue in local.dead_letter_queues : tolist(["AWS/SQS", widget.metric, "QueueName", queue])
            ] : [
              tolist(["AWS/RDS", widget.metric, "DBInstanceIdentifier", aws_db_instance.main.identifier])
            ]
          )
        }
      ]
    }
  ]

  dashboard_widgets = flatten([
    for row_index, row in local.dashboard_rows : concat(
      [{
        type       = "text"
        x          = 0
        y          = row_index * 7
        width      = 24
        height     = 1
        properties = { markdown = "## ${row.title}" }
      }],
      [
        for column, widget in row.widgets : {
          type   = "metric"
          x      = column * 8
          y      = row_index * 7 + 1
          width  = 8
          height = 6
          properties = {
            title   = widget.title
            region  = var.region
            view    = "timeSeries"
            stat    = widget.statistic
            period  = 300
            metrics = widget.metrics
          }
        }
      ]
    )
  ])
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.name
  dashboard_body = jsonencode({ widgets = local.dashboard_widgets })
}
