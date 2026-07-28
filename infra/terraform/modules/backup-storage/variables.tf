variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns the bucket."
}

variable "bucket_name" {
  type        = string
  description = "R2 bucket name. Must be globally unique within the account."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "R2 bucket names must be lowercase alphanumeric or hyphen, 3 to 63 characters, and may not start or end with a hyphen."
  }
}

variable "jurisdiction" {
  type        = string
  description = "R2 data-residency jurisdiction. 'eu' pins objects to EU infrastructure, which a location hint only requests. Backups contain every user record we hold, so this is a GDPR control, not a latency one."
  default     = "eu"

  validation {
    condition     = contains(["default", "eu", "fedramp"], var.jurisdiction)
    error_message = "jurisdiction must be one of: default, eu, fedramp."
  }
}
