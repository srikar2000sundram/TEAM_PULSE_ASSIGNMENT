# The Application Load Balancer. Only CloudFront can reach it (security group, prefix list), and it
# answers 403 to anything that does not carry CloudFront's secret header, so a request cannot skip
# CloudFront (and its web firewall) by finding the load balancer's address.
#
# Known limit: the leg from CloudFront to the load balancer is plain HTTP inside AWS's network. Closing
# it needs a domain name and an ACM certificate (ADR-0022, "not done").

resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = local.is_prod
  idle_timeout               = 60
}

resource "aws_lb_target_group" "service" {
  for_each             = local.services
  name                 = "${local.name}-${each.key}"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  # Liveness only. Readiness (/readyz) checks the database, and a database blip must not make the
  # load balancer remove every task at once.
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "service" {
  for_each     = local.services
  listener_arn = aws_lb_listener.http.arn
  priority     = each.value.priority

  condition {
    path_pattern {
      values = ["/api/v1/${each.key}/*"]
    }
  }
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_secret.result]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.key].arn
  }
}
