# PostgreSQL (one database, one schema per service) and the DynamoDB tables.

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${local.name}-postgres16"
  family = "postgres16"

  # Refuse any connection that is not encrypted.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Log slow statements (over one second) so the database alarms have something to point at.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "random_password" "database" {
  length  = 32
  special = false # keeps the password safe to place in a connection URL without escaping
}

resource "aws_db_instance" "main" {
  identifier = "${local.name}-db"

  engine         = "postgres"
  engine_version = "16"
  instance_class = local.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "teampulse"
  username = "teampulse_admin"
  password = random_password.database.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.data.id]
  parameter_group_name   = aws_db_parameter_group.postgres.name
  publicly_accessible    = false
  multi_az               = local.is_prod

  backup_retention_period    = local.is_prod ? 7 : 1
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  deletion_protection        = local.is_prod
  skip_final_snapshot        = !local.is_prod
  final_snapshot_identifier  = local.is_prod ? "${local.name}-final" : null

  enabled_cloudwatch_logs_exports = ["postgresql"]
  apply_immediately               = !local.is_prod
}

# --- DynamoDB ------------------------------------------------------------------------------------

resource "aws_dynamodb_table" "streaks" {
  name         = local.tables.streaks
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = local.is_prod
  }
  server_side_encryption {
    enabled = true
  }
}

resource "aws_dynamodb_table" "insight" {
  for_each     = { aggregates = local.tables.aggregates, personal = local.tables.personal }
  name         = each.value
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  # Counters delete themselves after the retention period (docs/architecture/12-insight-service.md).
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = local.is_prod
  }
  server_side_encryption {
    enabled = true
  }
}
