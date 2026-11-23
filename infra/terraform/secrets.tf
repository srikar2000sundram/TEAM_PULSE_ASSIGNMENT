# Secrets. Terraform generates them, stores them in Secrets Manager and never prints them. ECS reads
# them when a task starts and injects them as environment variables.
#
# The generated values also live in the Terraform state file, which is why the state bucket must be
# private and encrypted (docs/guides/05-aws-deployment.md).

resource "tls_private_key" "jwt" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "random_password" "log_salt" {
  length  = 32
  special = false
}

resource "random_password" "insight_key" {
  length  = 48
  special = false
}

locals {
  secrets = {
    database-url = "postgres://${aws_db_instance.main.username}:${random_password.database.result}@${aws_db_instance.main.address}:5432/${aws_db_instance.main.db_name}"
    jwt-private  = tls_private_key.jwt.private_key_pem
    log-salt     = random_password.log_salt.result
    insight-key  = random_password.insight_key.result
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = toset(keys(local.secrets))
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = local.is_prod ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each      = aws_secretsmanager_secret.app
  secret_id     = each.value.id
  secret_string = local.secrets[each.key]
}

# The first administrator's credentials, used once by the bootstrap task and then no longer needed.
resource "random_password" "admin" {
  length           = 20
  special          = true
  override_special = "-_.~"
}

resource "aws_secretsmanager_secret" "admin" {
  name                    = "${local.name}/bootstrap-admin-password"
  recovery_window_in_days = local.is_prod ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "admin" {
  secret_id     = aws_secretsmanager_secret.admin.id
  secret_string = random_password.admin.result
}
