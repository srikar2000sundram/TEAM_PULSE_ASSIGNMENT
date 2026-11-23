# The web application firewall in front of CloudFront. It is what turns the services' per-task rate
# limits into a global one (docs/architecture/16, "Not done" list), and it adds AWS's maintained
# rule sets. CloudFront web ACLs must live in us-east-1.

resource "aws_wafv2_web_acl" "main" {
  provider    = aws.us_east_1
  name        = local.name
  description = "TeamPulse ${var.environment}: managed rules and a per-address rate limit"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # One address cannot send more than this many API requests in five minutes, whatever the number of tasks.
  rule {
    name     = "api-rate-per-address"
    priority = 10
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.waf_requests_per_five_minutes
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "api-rate-per-address"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-common"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 30
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}
