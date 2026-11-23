# The three Lambda functions (streak, badge on streak, badge on totals). Two bundles, built by
# tools/lambda/bundle.mjs into build/lambda/<bundle>/index.mjs.
#
# They are NOT in the VPC: the streak function only uses DynamoDB and EventBridge, the badge functions
# only EventBridge, and both are reachable without a VPC. Leaving them out avoids NAT cost and cold
# start delay. (The first design placed them in the VPC to reach PostgreSQL; the code never does.)

data "archive_file" "bundle" {
  for_each    = toset(distinct([for fn in local.lambdas : fn.bundle]))
  type        = "zip"
  source_dir  = "${var.lambda_build_dir}/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.lambdas
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each           = local.lambdas
  name               = "${local.name}-lambda-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda" {
  for_each = local.lambdas

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda[each.key].arn}:*"]
  }
  statement {
    sid       = "PublishDerivedEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.main.arn]
  }

  dynamic "statement" {
    for_each = each.key == "streak" ? [1] : []
    content {
      sid       = "StreakTable"
      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
      resources = [aws_dynamodb_table.streaks.arn]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  for_each = local.lambdas
  name     = "application"
  role     = aws_iam_role.lambda[each.key].id
  policy   = data.aws_iam_policy_document.lambda[each.key].json
}

resource "aws_lambda_function" "fn" {
  for_each         = local.lambdas
  function_name    = "${local.name}-${each.key}"
  role             = aws_iam_role.lambda[each.key].arn
  runtime          = "nodejs22.x"
  handler          = each.value.handler
  filename         = data.archive_file.bundle[each.value.bundle].output_path
  source_code_hash = data.archive_file.bundle[each.value.bundle].output_base64sha256
  timeout          = 30
  memory_size      = 256
  architectures    = ["x86_64"]

  environment {
    variables = merge(
      {
        NODE_ENV           = "production"
        LOG_LEVEL          = "info"
        EVENT_BUS_NAME     = aws_cloudwatch_event_bus.main.name
        LOG_PSEUDONYM_SALT = random_password.log_salt.result
      },
      each.key == "streak" ? { STREAK_TABLE_NAME = aws_dynamodb_table.streaks.name } : {},
    )
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda[each.key].name
  }

  depends_on = [aws_iam_role_policy.lambda]
}
