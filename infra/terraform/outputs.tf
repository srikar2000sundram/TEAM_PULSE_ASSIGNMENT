output "public_url" {
  description = "The address of the platform. Open it in a browser once the web app is uploaded."
  value       = local.public_origin
}

output "web_bucket" {
  description = "Upload the built web app here: aws s3 sync apps/web/build s3://<this> --delete"
  value       = aws_s3_bucket.web.bucket
}

output "cloudfront_distribution_id" {
  description = "Needed to invalidate the cache after a web release."
  value       = aws_cloudfront_distribution.web.id
}

output "ecr_repository_url" {
  description = "Push the backend image here, tagged with var.image_tag."
  value       = aws_ecr_repository.backend.repository_url
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition" {
  description = "Run once after the first apply, and after releases that add migrations."
  value       = aws_ecs_task_definition.migrate.family
}

output "app_subnet_ids" {
  description = "Subnets and security group for running the migrate task by hand."
  value       = aws_subnet.app[*].id
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "bootstrap_admin_secret_arn" {
  description = "Where the first administrator's generated password is stored. Read it once, sign in, change it."
  value       = aws_secretsmanager_secret.admin.arn
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.main.dashboard_name
}
