# VPC 10.0.0.0/16 across two Availability Zones, three tiers of subnets (see docs/architecture/05).
#   public  10.0.0.0/24,  10.0.1.0/24   load balancer and NAT gateways
#   app     10.0.10.0/24, 10.0.11.0/24  ECS tasks
#   data    10.0.20.0/24, 10.0.21.0/24  PostgreSQL, no route to the internet at all

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = "10.0.${count.index}.0/24"
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${local.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "app" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = "10.0.${10 + count.index}.0/24"
  tags              = { Name = "${local.name}-app-${local.azs[count.index]}", Tier = "app" }
}

resource "aws_subnet" "data" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = "10.0.${20 + count.index}.0/24"
  tags              = { Name = "${local.name}-data-${local.azs[count.index]}", Tier = "data" }
}

# --- Internet access --------------------------------------------------------------------------

resource "aws_eip" "nat" {
  count  = local.nat_gateway_count
  domain = "vpc"
  tags   = { Name = "${local.name}-nat-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count         = local.nat_gateway_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${local.name}-${count.index}" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-public" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One route table per app subnet so that, in prod, each zone uses its own NAT gateway. In dev there
# is one gateway and both tables point at it.
resource "aws_route_table" "app" {
  count  = 2
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-app-${count.index}" }

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[min(count.index, local.nat_gateway_count - 1)].id
  }
}

resource "aws_route_table_association" "app" {
  count          = 2
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# The data tier has a route table with no routes beyond the VPC itself.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-data" }
}

resource "aws_route_table_association" "data" {
  count          = 2
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# --- Network ACLs: a second wall around the data tier ----------------------------------------

resource "aws_network_acl" "data" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = aws_subnet.data[*].id
  tags       = { Name = "${local.name}-data" }
}

# PostgreSQL from the app subnets only.
resource "aws_network_acl_rule" "data_in_postgres" {
  count          = 2
  network_acl_id = aws_network_acl.data.id
  rule_number    = 100 + count.index
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = aws_subnet.app[count.index].cidr_block
  from_port      = 5432
  to_port        = 5432
}

# Replies to those connections go back out on ephemeral ports, to the app subnets only.
resource "aws_network_acl_rule" "data_out_replies" {
  count          = 2
  network_acl_id = aws_network_acl.data.id
  rule_number    = 100 + count.index
  egress         = true
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = aws_subnet.app[count.index].cidr_block
  from_port      = 1024
  to_port        = 65535
}

# --- Private paths to AWS services -------------------------------------------------------------

# Gateway endpoints are free, and keep S3 and DynamoDB traffic off the NAT gateway.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.app[*].id
  tags              = { Name = "${local.name}-s3" }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.app[*].id
  tags              = { Name = "${local.name}-dynamodb" }
}

# Interface endpoints cost money per zone, so dev relies on the NAT gateway instead.
resource "aws_vpc_endpoint" "interface" {
  for_each            = local.use_interface_endpoints ? toset(["ecr.api", "ecr.dkr", "logs", "secretsmanager", "sqs", "events"]) : toset([])
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.app[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "${local.name}-${each.key}" }
}
