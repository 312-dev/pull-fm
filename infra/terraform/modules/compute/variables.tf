variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names, e.g. pullfm-staging."
}

variable "labels" {
  type        = map(string)
  description = "Labels applied to every resource in this module."
}

variable "location" {
  type        = string
  description = "Hetzner location. Must be an EU site: Pull.fm processes EU personal data and the GDPR posture assumes EU-only hosting."

  validation {
    condition     = contains(["fsn1", "nbg1", "hel1"], var.location)
    error_message = "location must be an EU Hetzner site (fsn1, nbg1 or hel1). US and APAC sites would break the EU-only data residency assumption."
  }
}

variable "network_id" {
  type        = string
  description = "ID of the private network to attach every node to."
}

variable "subnet_ip_range" {
  type        = string
  description = "CIDR of the node subnet. Private addresses are derived from it so they stay stable across rebuilds."
}

variable "image_name" {
  type        = string
  description = "Base image name. Resolved to an ARM64 image ID by the hcloud_image data source."
  default     = "ubuntu-24.04"
}

# --- sizing ------------------------------------------------------------------

variable "app_server_type" {
  type        = string
  description = "Server type for BFF nodes."
  default     = "cax21"

  validation {
    condition     = startswith(var.app_server_type, "cax")
    error_message = "Only CAX (Ampere ARM64) types are permitted. Hetzner raised CPX/CCX pricing 150-210 percent on 2026-06-15 while CAX rose about 30 percent; see docs/PLAN.md section 2. Changing this is a cost decision, not a sizing one."
  }
}

variable "db_server_type" {
  type        = string
  description = "Server type for the Postgres node."
  default     = "cax31"

  validation {
    condition     = startswith(var.db_server_type, "cax")
    error_message = "Only CAX (Ampere ARM64) types are permitted. See docs/PLAN.md section 2."
  }
}

variable "app_node_count" {
  type        = number
  description = "Number of BFF nodes. Two is the minimum that survives a single host failure and permits a rolling deploy with zero non-2xx (Gate 6)."
  default     = 2

  validation {
    condition     = var.app_node_count >= 1 && var.app_node_count <= 8
    error_message = "app_node_count must be between 1 and 8."
  }
}

variable "load_balancer_type" {
  type        = string
  description = "Hetzner load balancer type."
  default     = "lb11"
}

# --- access ------------------------------------------------------------------

variable "ssh_public_keys" {
  type        = map(string)
  description = "Map of operator name to OpenSSH public key. Public keys are not secrets; the matching private keys never appear anywhere in this repo."
  default     = {}
}

variable "app_firewall_id" {
  type        = string
  description = "Firewall to attach to BFF nodes."
}

variable "db_firewall_id" {
  type        = string
  description = "Firewall to attach to the Postgres node."
}

variable "tailscale_auth_key" {
  type        = string
  description = "Optional single-use, pre-authorized, ephemeral Tailscale auth key used once at first boot. Prefer leaving this null and enrolling out of band: cloud-init is stored in Terraform state and is readable from the Hetzner API for the life of the server, so any key placed here should be treated as burned after first boot."
  sensitive   = true
  default     = null
}

variable "admin_user" {
  type        = string
  description = "Unprivileged sudo account created by cloud-init. Root login over SSH is disabled."
  default     = "pullfm"
}

# --- durability --------------------------------------------------------------

variable "enable_app_backups" {
  type        = bool
  description = "Hetzner automatic backups on BFF nodes. BFF nodes are stateless and rebuilt from config management, so this is normally wasted spend."
  default     = false
}

variable "enable_db_backups" {
  type        = bool
  description = "Hetzner automatic backups on the Postgres node. Costs 20 percent of the server price (about EUR 3.20/mo on a cax31). This is NOT the backup strategy - pgBackRest to R2 is - but it is the cheapest way to get a whole-machine rollback when a config change bricks the node."
  default     = true
}

variable "db_data_volume_size" {
  type        = number
  description = "Size in GB of a dedicated Postgres data volume. 0 disables it and keeps the cluster on the node's local NVMe. A separate volume decouples data lifetime from server lifetime, which is what makes prevent_destroy actually meaningful. Costs about EUR 0.044/GB/mo."
  default     = 0

  validation {
    condition     = var.db_data_volume_size == 0 || (var.db_data_volume_size >= 10 && var.db_data_volume_size <= 10240)
    error_message = "db_data_volume_size must be 0 (disabled) or between 10 and 10240 GB."
  }
}

variable "db_delete_protection" {
  type        = bool
  description = "Hetzner-side delete and rebuild protection on the Postgres node. This is the second lock; the first is the prevent_destroy lifecycle block."
  default     = true
}

variable "lb_delete_protection" {
  type        = bool
  description = "Hetzner-side delete protection on the load balancer. Destroying the LB changes its public IP, which invalidates the DNS records and every cached A record downstream."
  default     = true
}

# --- public addressing -------------------------------------------------------

variable "db_public_ipv4_enabled" {
  type        = bool
  description = "Give the Postgres node a public IPv4. Default false: an interface that does not exist cannot be exposed by a mistaken firewall edit. Also saves the IPv4 surcharge."
  default     = false
}

variable "db_public_ipv6_enabled" {
  type        = bool
  description = "Give the Postgres node a public IPv6. Default true so apt and pgBackRest-to-R2 have egress without a NAT hop. Both endpoints are dual-stack."
  default     = true
}

# --- load balancer behaviour -------------------------------------------------

variable "enable_proxy_protocol" {
  type        = bool
  description = "Enable PROXY protocol on LB services. Required for the origin to see the true L3 peer, which is what lets the app reject any connection that did not come from a Cloudflare edge address, and what makes per-IP rate limiting (PLAN section 6) meaningful. The origin MUST be configured to parse it before this is enabled or every connection fails."
  default     = true
}

variable "health_check_path" {
  type        = string
  description = "HTTP path the LB polls to decide target health."
  default     = "/healthz"
}

variable "health_check_port" {
  type        = number
  description = "Port the LB polls for health. Kept on plain HTTP so a certificate problem does not masquerade as an application outage."
  default     = 80
}
