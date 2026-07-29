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
  description = "Private network CIDR for prod. Kept disjoint from staging so the two can be peered later without renumbering."
  default     = "10.30.0.0/16"
}

variable "subnet_ip_range" {
  type        = string
  description = "Node subnet CIDR."
  default     = "10.30.1.0/24"
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
  description = "Hetzner automatic backups on the Redis node. False even in prod: a snapshot of a cache is a snapshot of nothing, and the data that used to justify this line now lives in Neon."
  default     = false
}

variable "enable_app_backups" {
  type        = bool
  description = "Hetzner automatic backups on the BFF nodes. Still false in prod: BFF nodes hold no state and are rebuilt from config management, so a snapshot of one is a snapshot of nothing."
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
  default     = "api.pull.fm"
}

variable "app_hostname" {
  type        = string
  description = "Public hostname for the web client."
  default     = "app.pull.fm"
}

variable "backup_bucket_name" {
  type        = string
  description = "R2 bucket for pgBackRest."
  default     = "pull-fm-backups-prod"
}

# --- destroy protection ------------------------------------------------------
#
# The counterpart to the staging root, which sets both to false because it is
# torn down after every gate run. Production is not ephemeral: these are the
# second lock behind the plan file, enforced by the Hetzner API rather than by
# this repository, so they also catch a console click, a stale state file, or a
# `terraform state rm` followed by an apply.
variable "cache_delete_protection" {
  type        = bool
  description = "Hetzner-side delete and rebuild protection on the Redis node. TRUE for production, but for a much weaker reason than it once had: destroying it now costs a cold cache and a reset rate-limit window, not the only copy of user data."
  default     = true
}

variable "lb_delete_protection" {
  type        = bool
  description = "Hetzner-side delete protection on the load balancer. TRUE for production: destroying it changes the public IP that every DNS record and downstream cache points at."
  default     = true
}

variable "network_delete_protection" {
  type        = bool
  description = "Hetzner-side delete protection on the private network. TRUE for production."
  default     = true
}
