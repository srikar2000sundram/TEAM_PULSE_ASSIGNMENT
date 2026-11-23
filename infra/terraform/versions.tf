terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }

  # State holds the generated database password and signing key, so it must live somewhere private,
  # encrypted and locked. Create the bucket once (docs/guides/05-aws-deployment.md), then run
  #   terraform init -backend-config=backend.hcl
  # Left empty on purpose: a local state file is fine for a first look, never for a shared team.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "teampulse"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront web ACLs can only be created in us-east-1, whatever region the platform runs in.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "teampulse"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
