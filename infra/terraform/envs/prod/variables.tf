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
  description = "Number of BFF nodes."
  default     = 2
}

variable "app_server_type" {
  type        = string
  description = "BFF node server type. CAX only."
  default     = "cax21"
}

variable "db_server_type" {
  type        = string
  description = "Postgres node server type. CAX only."
  default     = "cax31"
}

variable "db_data_volume_size" {
  type        = number
  description = "Dedicated Postgres data volume in GB. Non-zero in prod: it decouples the data lifetime from the machine lifetime, which is what turns a bricked DB node from a 30 minute R2 restore into a reattach. Costs about EUR 0.044/GB/mo."
  default     = 100
}

variable "enable_db_backups" {
  type        = bool
  description = "Hetzner automatic backups on the Postgres node."
  default     = true
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
variable "db_delete_protection" {
  type        = bool
  description = "Hetzner-side delete and rebuild protection on the Postgres node. TRUE for production. Turning it off is a deliberate, reviewed act."
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
