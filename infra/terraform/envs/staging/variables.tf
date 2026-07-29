# No variable in this root holds a credential. HCLOUD_TOKEN and
# CLOUDFLARE_API_TOKEN are consumed directly by the providers from the
# environment; see providers.tf.

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the pull.fm zone and the R2 buckets. Set via TF_VAR_cloudflare_account_id or terraform.tfvars."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for pull.fm. Found on the zone overview page; a public identifier, not a credential."
}

variable "location" {
  type        = string
  description = "Hetzner location. EU only, deliberately: see docs/PLAN.md on GDPR."
  default     = "fsn1"
}

variable "network_ip_range" {
  type        = string
  description = "Private network CIDR for staging. Kept disjoint from prod so the two can be peered later without renumbering."
  default     = "10.20.0.0/16"
}

variable "subnet_ip_range" {
  type        = string
  description = "Node subnet CIDR."
  default     = "10.20.1.0/24"
}

variable "app_node_count" {
  type        = number
  description = "Number of BFF nodes. ONE pre-launch. Raising it requires enable_cache_node and enable_load_balancer, enforced as a plan-time error in the compute module rather than as advice here."
  default     = 1
}

variable "enable_cache_node" {
  type        = bool
  description = "Provision a separate node for the shared Redis instances. FALSE pre-launch: Redis runs on the single application node. MANDATORY before app_node_count goes above one, because the MusicBrainz token bucket lives in Redis and the 1 req/s ceiling is global to the service."
  default     = false
}

variable "enable_load_balancer" {
  type        = bool
  description = "Provision the Hetzner load balancer. FALSE pre-launch: the proxied Cloudflare records point straight at the application node, and nginx runs without PROXY protocol. Turning it on is a two-sided change; see infra/staging/README.md."
  default     = false
}

variable "app_server_type" {
  type        = string
  description = "BFF node server type. This node now also runs the two Redis instances, so 4 GB rather than 8: a 768 MB BFF, 384 MB of capped Redis, nginx, and one 384 MB job container at a time still leaves half the machine free. CAX preferred; the cpx_1_ types are the in-stock fallback."
  default     = "cax11"
}

variable "cache_server_type" {
  type        = string
  description = "Server type for the separate Redis node, used only when enable_cache_node is true. Redis holds 384 MB across two capped instances, not a database page cache."
  default     = "cax11"
}

variable "enable_cache_backups" {
  type        = bool
  description = "Hetzner automatic backups on the Redis node. False: a snapshot of a cache is a snapshot of nothing."
  default     = false
}

variable "enable_app_backups" {
  type        = bool
  description = "Hetzner automatic backups on the BFF nodes."
  default     = false
}

variable "ssh_public_keys" {
  type        = map(string)
  description = "Operator name to OpenSSH public key. Public keys only."
  default     = {}
}

variable "tailscale_auth_key" {
  type        = string
  description = "Optional single-use ephemeral Tailscale auth key for first boot. See the warning in modules/compute/variables.tf before using it."
  sensitive   = true
  default     = null
}

variable "enable_proxy_protocol" {
  type        = bool
  description = "PROXY protocol on the LB services. The origin must parse it before this is true."
  default     = true
}

variable "restrict_egress" {
  type        = bool
  description = "Apply the outbound firewall allowlist."
  default     = true
}

variable "api_hostname" {
  type        = string
  description = "Public hostname for the API."
  default     = "api-staging.pull.fm"
}

variable "app_hostname" {
  type        = string
  description = "Public hostname for the web client."
  default     = "app-staging.pull.fm"
}

# ---------------------------------------------------------------------------
# THIS NOW NAMES THE US BUCKET. IT WAS NOT A VARIABLE EDIT, AND THE PREVIOUS
# COMMENT HERE WAS THE RECIPE FOR THE CHANGE THAT REPLACED IT.
# ---------------------------------------------------------------------------
#
# The backup tooling (infra/lib/backup-common.sh) reads and writes
# `pull-fm-backups-staging-us`, which was created BY HAND in the DEFAULT
# jurisdiction with an ENAM location hint, because R2 has no `us` jurisdiction to
# pin to and jurisdiction is fixed at creation. Terraform managed the EU bucket
# `pull-fm-backups-staging` until 2026-07-29, so for a while the tooling and
# Terraform were pointed at two different buckets. They are now pointed at one.
#
# WHY EDITING THIS DEFAULT ON ITS OWN WOULD HAVE BEEN DESTRUCTIVE, kept because
# it is the reason the change looks the way it does. `bucket_name` is ForceNew on
# `cloudflare_r2_bucket`, and `modules/backup-storage` marks that resource
# `prevent_destroy = true` with the note that "if this is destroyed the service is
# gone". So editing this line does not rename anything. It plans a DESTROY AND
# CREATE of the bucket holding every database backup, `prevent_destroy` fails the
# plan, and the create half would have failed anyway because the US bucket
# already existed outside this state.
#
# WHAT WAS ACTUALLY DONE, on 2026-07-29, after a verified pre-apply snapshot from
# infra/lib/tfstate-snapshot.sh:
#
#   terraform state rm module.backup_storage.cloudflare_r2_bucket.backups
#
# plus an `import` block for the existing US bucket and an explicit
# `jurisdiction = "default"` on the module call in main.tf, because the module
# defaults to `eu` and a default that disagrees with the imported object is a
# plan that proposes replacing a backup bucket. `state rm` forgets the EU bucket
# without touching it; it was deleted separately and deliberately.
#
# NOTE WHAT THE `-us` SUFFIX DOES AND DOES NOT MEAN. It distinguishes this bucket
# from the retired EU one. It is not a residency claim: R2's only jurisdictions
# are `eu` and `fedramp`, so `default` means Cloudflare may store these objects
# anywhere, and the ENAM location hint is a preference rather than a guarantee.
# legal/privacy-policy.md states it that way on purpose and declines the stronger
# claim. The control that actually does the work is that the objects are
# encrypted before upload under a key that has never been at Cloudflare.
variable "backup_bucket_name" {
  type        = string
  description = "R2 bucket for pgBackRest. The US bucket, in the DEFAULT jurisdiction; main.tf passes jurisdiction explicitly to match. See the block above before changing it: bucket_name is ForceNew and the resource carries prevent_destroy, so this is not a rename knob."
  default     = "pull-fm-backups-staging-us"
}

variable "ssh_allowlist_cidrs" {
  type        = list(string)
  description = "Break-glass SSH source CIDRs. See modules/firewall/variables.tf. Empty in every committed configuration."
  default     = []
}

# --- destroy protection ------------------------------------------------------
#
# docs/PLAN.md section 10c decided that Hetzner's delete_protection replaces
# Terraform's prevent_destroy because it is variable-driven, and that
# "Production sets it true; staging false". Until 2026-07-29 that second half
# was never wired up: the env roots did not pass these variables at all, so the
# module defaults (true) applied and `./infra/staging-env.sh down` failed
# halfway through with "server deletion is protected", leaving the database
# node and the load balancer running while everything around them was gone.
#
# An ephemeral environment that cannot be destroyed is not ephemeral, and a
# half-destroyed one still bills. False here is the decision being implemented,
# not a control being weakened: production is a separate root and keeps true.
variable "cache_delete_protection" {
  type        = bool
  description = "Hetzner-side delete and rebuild protection on the Redis node. FALSE for staging by design: staging is destroyed on purpose after every gate run and holds nothing that is not reproducible."
  default     = false
}

variable "lb_delete_protection" {
  type        = bool
  description = "Hetzner-side delete protection on the load balancer. FALSE for staging by design, for the same reason. Destroying it changes its public IP, which is why prod keeps it on."
  default     = false
}

variable "network_delete_protection" {
  type        = bool
  description = "Hetzner-side delete protection on the private network. FALSE for staging by design: the network is recreated by every 'up' and holds no state. Left true it blocks the final step of a teardown after the servers are already gone, which is the most expensive place to fail."
  default     = false
}
