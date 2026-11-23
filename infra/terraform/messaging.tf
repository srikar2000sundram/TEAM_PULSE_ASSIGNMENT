# The event bus, one queue (with a dead-letter queue) per consuming service, and the rules that route
# events. Mirrors tools/local/setup-aws.mjs, which builds the same thing inside LocalStack.

resource "aws_cloudwatch_event_bus" "main" {
  name = "${local.name}-bus"
}

# --- One queue per consuming service -----------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  for_each                  = local.service_events
  name                      = "${local.name}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days to investigate
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "main" {
  for_each                   = local.service_events
  name                       = "${local.name}-${each.key}"
  visibility_timeout_seconds = 30
  sqs_managed_sse_enabled    = true

  # After five failed deliveries a message moves to the dead-letter queue instead of looping.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_event_rule" "to_queue" {
  for_each       = local.service_events
  name           = "${local.name}-to-${each.key}"
  event_bus_name = aws_cloudwatch_event_bus.main.name
  event_pattern  = jsonencode({ "detail-type" = each.value })
}

resource "aws_cloudwatch_event_target" "to_queue" {
  for_each       = local.service_events
  rule           = aws_cloudwatch_event_rule.to_queue[each.key].name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "queue"
  arn            = aws_sqs_queue.main[each.key].arn
}

# Only this rule may put messages on this queue.
resource "aws_sqs_queue_policy" "from_rule" {
  for_each  = local.service_events
  queue_url = aws_sqs_queue.main[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowRuleToSend"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.main[each.key].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.to_queue[each.key].arn } }
    }]
  })
}

# --- Lambda functions are invoked by their rule directly ----------------------------------------

resource "aws_cloudwatch_event_rule" "to_lambda" {
  for_each       = local.lambdas
  name           = "${local.name}-to-lambda-${each.key}"
  event_bus_name = aws_cloudwatch_event_bus.main.name
  event_pattern  = jsonencode({ "detail-type" = each.value.events })
}

resource "aws_cloudwatch_event_target" "to_lambda" {
  for_each       = local.lambdas
  rule           = aws_cloudwatch_event_rule.to_lambda[each.key].name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "function"
  arn            = aws_lambda_function.fn[each.key].arn

  # A rule retries a failing function for up to 24 hours by default. Two retries, then the dead-letter queue.
  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config {
    arn = aws_sqs_queue.lambda_dlq[each.key].arn
  }
}

resource "aws_sqs_queue" "lambda_dlq" {
  for_each                  = local.lambdas
  name                      = "${local.name}-lambda-${each.key}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue_policy" "lambda_dlq" {
  for_each  = local.lambdas
  queue_url = aws_sqs_queue.lambda_dlq[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowRuleToSend"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.lambda_dlq[each.key].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.to_lambda[each.key].arn } }
    }]
  })
}

resource "aws_lambda_permission" "from_rule" {
  for_each      = local.lambdas
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.to_lambda[each.key].arn
}

# The bus accepts events only from principals in this account. The task roles' IAM policies narrow
# that further to PutEvents on this one bus.
resource "aws_cloudwatch_event_bus_policy" "main" {
  event_bus_name = aws_cloudwatch_event_bus.main.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OnlyThisAccount"
      Effect    = "Allow"
      Principal = { AWS = local.account }
      Action    = "events:PutEvents"
      Resource  = aws_cloudwatch_event_bus.main.arn
    }]
  })
}
