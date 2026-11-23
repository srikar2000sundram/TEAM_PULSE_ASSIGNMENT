variable "region" {
  description = "AWS region for everything except the CloudFront certificate and WAF (those are global)."
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "dev is cheap (one NAT gateway, single-AZ database, small tasks); prod is resilient."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "alert_email" {
  description = "Address that receives alarm notifications. AWS sends a confirmation link you must click."
  type        = string
}

variable "image_tag" {
  description = "Tag of the backend image in ECR, normally the git commit SHA."
  type        = string
}

variable "web_build_dir" {
  description = "Folder holding the built web app (apps/web/build). Its index.html is read to compute the Content-Security-Policy script hash."
  type        = string
  default     = "../../apps/web/build"
}

variable "lambda_build_dir" {
  description = "Folder the bundle script writes the Lambda bundles to (tools/lambda/bundle.mjs)."
  type        = string
  default     = "../../build/lambda"
}

variable "monitoring_file" {
  description = "Monitoring definitions that this configuration turns into CloudWatch resources."
  type        = string
  default     = "../observability/monitoring.json"
}

variable "log_retention_days" {
  description = "How long CloudWatch keeps logs. Longer means more cost and more retained personal data."
  type        = number
  default     = 30
}

variable "waf_requests_per_five_minutes" {
  description = "WAF rate rule: requests one address may make to the API in five minutes before it is blocked."
  type        = number
  default     = 2000
}

variable "db_instance_class" {
  description = "Database size. Empty picks db.t4g.micro for dev and db.t4g.small for prod."
  type        = string
  default     = ""
}

variable "desired_count" {
  description = "Tasks per service. Empty picks 1 for dev and 2 for prod."
  type        = number
  default     = null
}

variable "use_interface_endpoints" {
  description = "Private paths to AWS APIs (cost about 7 USD a month each per zone). Off in dev, where the NAT gateway serves."
  type        = bool
  default     = null
}
