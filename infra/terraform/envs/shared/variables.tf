variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone ID for pull.fm."
}

variable "ssl_mode" {
  type        = string
  description = "Cloudflare to origin TLS mode. Leave at 'full' until Cloudflare Origin CA certificates are installed on the BFF nodes, then move to 'strict'."
  default     = "full"
}

variable "min_tls_version" {
  type        = string
  description = "Minimum client TLS version accepted at the edge."
  default     = "1.2"
}

variable "enable_hsts" {
  type        = bool
  description = "Emit Strict-Transport-Security for the zone."
  default     = false
}

variable "hsts_max_age" {
  type        = number
  description = "HSTS max-age in seconds."
  default     = 86400
}

variable "hsts_include_subdomains" {
  type        = bool
  description = "Apply HSTS to subdomains, including the staging hostnames."
  default     = false
}

variable "hsts_preload" {
  type        = bool
  description = "Set the HSTS preload flag."
  default     = false
}
