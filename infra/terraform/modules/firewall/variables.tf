variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names, e.g. pullfm-staging."
}

variable "labels" {
  type        = map(string)
  description = "Labels applied to every resource in this module."
}

variable "cloudflare_ipv4_cidrs" {
  type        = list(string)
  description = "Cloudflare edge IPv4 ranges. Sourced from the cloudflare_ip_ranges data source in the calling root so it tracks upstream changes."
}

variable "cloudflare_ipv6_cidrs" {
  type        = list(string)
  description = "Cloudflare edge IPv6 ranges."
}

variable "tailscale_udp_port" {
  type        = number
  description = "Inbound UDP port Tailscale uses for direct peer connections. Without it the tailnet still works but every session is relayed through DERP."
  default     = 41641
}

variable "restrict_egress" {
  type        = bool
  description = "Apply an outbound allowlist. Hetzner allows all egress when a firewall declares no 'out' rules, which means a compromised node can freely scan, mine or exfiltrate. Set false only while debugging a suspected egress block."
  default     = true
}

variable "ssh_allowlist_cidrs" {
  type        = list(string)
  description = <<-DESC
    Break-glass only. Source CIDRs permitted to reach TCP 22 on the nodes.

    Empty by default and expected to stay empty: SSH is reached over Tailscale
    (see modules/compute cloud-init), so an inbound rule for 22 adds public
    attack surface without adding access the operator uses. It exists for
    exactly one case - bootstrapping a node that has no tailnet membership yet,
    which is a chicken-and-egg problem with no other solution short of the
    rescue console.

    Set it to a single /32 in a local tfvars file, apply, bootstrap, then remove
    it and apply again. Never commit a value. A non-empty value in a committed
    file is a finding, not a convenience.
  DESC
  default     = []

  validation {
    condition     = !contains(var.ssh_allowlist_cidrs, "0.0.0.0/0") && !contains(var.ssh_allowlist_cidrs, "::/0")
    error_message = "ssh_allowlist_cidrs must never contain a default route. Break-glass access is a single operator address, not the internet."
  }
}
