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
