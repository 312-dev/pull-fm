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
  description = "Dedicated Postgres data volume in GB, or 0 for local NVMe only."
  default     = 0
}

variable "enable_db_backups" {
  type        = bool
  description = "Hetzner automatic backups on the Postgres node."
  default     = true
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

variable "backup_bucket_name" {
  type        = string
  description = "R2 bucket for pgBackRest."
  default     = "pull-fm-backups-staging"
}

variable "ssh_allowlist_cidrs" {
  type        = list(string)
  description = "Break-glass SSH source CIDRs. See modules/firewall/variables.tf. Empty in every committed configuration."
  default     = []
}
