# The public face: one CloudFront distribution serving the web app from S3 and the API from the load
# balancer, so a browser sees a single HTTPS origin (the SameSite=Strict refresh cookie needs that).
#
#   /api/*  -> load balancer -> the services
#   others  -> private S3 bucket (through origin access control)

locals {
  index_html = file("${var.web_build_dir}/index.html")

  # The SHA-256 hash of every inline script in the built app. Same rule as
  # tools/docker/render-security-headers.mjs, which does it for the nginx image.
  inline_scripts = [
    for match in regexall("(?is)<script\\b([^>]*)>(.*?)</script>", local.index_html) : match[1]
    if !can(regex("(?i)\\bsrc\\s*=", match[0]))
  ]
  script_hashes = distinct([for script in local.inline_scripts : "'sha256-${base64sha256(script)}'"])

  # Keep identical to infra/docker/security-headers.conf.template: tools/test/terraform.test.ts fails
  # if the two drift apart.
  content_security_policy = "default-src 'self'; script-src 'self' ${join(" ", local.script_hashes)}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

  # AWS managed cache and request policies.
  caching_optimized      = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  caching_disabled       = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
}

check "web_app_is_built" {
  assert {
    condition     = length(local.script_hashes) > 0
    error_message = "No inline script found in ${var.web_build_dir}/index.html. Build the web app first (npm run build)."
  }
}

# --- The bucket ---------------------------------------------------------------------------------

resource "aws_s3_bucket" "web" {
  bucket        = "${local.name}-web-${local.account}"
  force_destroy = !local.is_prod
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "web_bucket" {
  statement {
    sid       = "OnlyThisDistributionMayRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
  statement {
    sid       = "RefuseUnencryptedTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.web]
}

# --- Response headers -----------------------------------------------------------------------------

# Everything the web app serves: the same headers the nginx image sends, plus HSTS (which belongs here,
# where TLS ends).
resource "aws_cloudfront_response_headers_policy" "web" {
  name = "${local.name}-web"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}

# The API: the services set their own headers; CloudFront only adds HSTS.
resource "aws_cloudfront_response_headers_policy" "api" {
  name = "${local.name}-api"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
  }
}

# --- The distribution -----------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.name} web app and API"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.main.arn
  http_version        = "http2and3"

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = "api"
    domain_name = aws_lb.main.dns_name

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 30
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_secret.result
    }
  }

  default_cache_behavior {
    target_origin_id           = "web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_disabled
    origin_request_policy_id   = local.all_viewer_except_host
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
  }

  # The app is a single-page app: any path that is not a file is answered by index.html and the router.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # The default *.cloudfront.net certificate. A custom domain with its own ACM certificate (in
  # us-east-1) is the upgrade; the default certificate cannot enforce a minimum TLS version.
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
