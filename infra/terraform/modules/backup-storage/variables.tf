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

# ---------------------------------------------------------------------------
# THIS VARIABLE HAS NO DEFAULT ANY MORE, AND THE MISSING DEFAULT IS THE POINT.
# ---------------------------------------------------------------------------
#
# WHAT WAS WRONG. It defaulted to "eu", described as a GDPR control. That was
# correct for as long as every bucket this module made was EU-pinned, and it went
# wrong silently the moment one was not. The US cutover created
# `pull-fm-backups-staging-us` in the DEFAULT jurisdiction by hand - R2 offers
# only `eu` and `fedramp`, so there is no `us` to pin to - and `envs/staging` was
# still not passing this argument. An inherited `eu` against a default-jurisdiction
# bucket is not a cosmetic mismatch: `jurisdiction` is ForceNew and the bucket
# carries `prevent_destroy`, so it plans a REPLACEMENT of the bucket holding every
# database backup and then fails the plan on the lifecycle lock, naming the lock
# rather than the real problem.
#
# WHY REQUIRED RATHER THAN RE-DEFAULTED TO "default". Flipping the default would
# fix today's two call sites and re-arm exactly the same trap for the third one,
# in the opposite direction: a caller that meant to pin EU would silently get an
# unpinned bucket, and nothing about the omission would show up in review. This
# is the same failure the `network_zone` local in envs/staging/main.tf was written
# to explain - an unset module default that was invisible and correct until it was
# not - and the fix there was to stop letting it be unset.
#
# A jurisdiction is fixed at creation, changes which S3 host answers for the
# bucket, and is the single attribute that decides where every user record we hold
# comes to rest. There is no value for it that is right often enough to be a
# default. Both callers now state it, and a future third one fails at plan time
# with this message rather than inheriting somebody else's residency decision.
variable "jurisdiction" {
  type        = string
  description = "R2 data-residency jurisdiction. REQUIRED, deliberately: see the block above. 'eu' pins objects to EU infrastructure, which a location hint only requests. 'default' pins nothing at all and is NOT a synonym for 'in the United States' - R2 has no US jurisdiction, so a US-resident posture is expressed as 'default' plus an ENAM location hint plus client-side encryption, and legal/privacy-policy.md declines the stronger claim on exactly those grounds."

  validation {
    condition     = contains(["default", "eu", "fedramp"], var.jurisdiction)
    error_message = "jurisdiction must be one of: default, eu, fedramp. It has no default value on purpose; state it at the call site."
  }
}
