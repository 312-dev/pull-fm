variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for pull.fm."
}

variable "ssl_mode" {
  type        = string
  description = "Cloudflare to origin TLS mode. 'strict' validates the origin certificate and is the only mode that actually prevents a machine-in-the-middle between Cloudflare and Hetzner. It requires a Cloudflare Origin CA certificate installed on the BFF nodes first: applying strict before that is an immediate 526 outage."
  default     = "strict"

  validation {
    condition     = contains(["strict", "full"], var.ssl_mode)
    error_message = "ssl_mode must be strict or full. 'flexible' and 'off' send plaintext to the origin and are never acceptable for an API carrying auth tokens."
  }
}

variable "min_tls_version" {
  type        = string
  description = "Minimum TLS version Cloudflare accepts from clients. 1.2 is the floor for a Mozilla Observatory A+ (Gate 8)."
  default     = "1.2"
}

variable "enable_hsts" {
  type        = bool
  description = "Emit Strict-Transport-Security. Left off by default because HSTS is effectively irreversible for the duration of max_age: any client that has seen the header refuses plain HTTP until it expires. Turn it on for prod once the certificate chain is proven, not before."
  default     = false
}

variable "hsts_max_age" {
  type        = number
  description = "HSTS max-age in seconds. Start low (86400) to verify, then raise to 31536000 for the Observatory A+."
  default     = 86400
}

variable "hsts_include_subdomains" {
  type        = bool
  description = "Apply HSTS to every subdomain. Note this also covers api.staging and app.staging, so those must be HTTPS-clean first."
  default     = false
}

variable "hsts_preload" {
  type        = bool
  description = "Set the preload flag. Only enable when submission to the browser preload list is actually intended: removal from that list takes months."
  default     = false
}

variable "enable_authenticated_origin_pulls" {
  type        = bool
  description = "Require a Cloudflare client certificate on every origin connection (mTLS). The origin must already be configured to verify it, and to check the certificate subject: the origin-pull CA is shared across all Cloudflare customers."
  default     = false
}
