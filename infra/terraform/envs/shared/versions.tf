terraform {
  required_version = "~> 1.15"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }

  # See ../staging/versions.tf for the full remote-state bootstrap notes. Same
  # bucket, different key.
  #
  # backend "s3" {
  #   key = "shared/terraform.tfstate"
  # }
}
