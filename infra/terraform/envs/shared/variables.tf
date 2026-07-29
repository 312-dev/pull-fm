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

variable "enable_authenticated_origin_pulls" {
  type        = bool
  description = "Zone-wide mTLS from Cloudflare to the origin. Requires the origin to present ssl_verify_client on with Cloudflare's origin-pull CA."
  default     = false
}

# ---------------------------------------------------------------------------
# Edge rate limiting and custom firewall rules.
#
# Zone-wide, so they live in this root rather than in a per-environment one. See
# ../../modules/edge-rate-limit/main.tf for the argument and for the plan
# constraints on `period_seconds` and on the number of rules.
# ---------------------------------------------------------------------------

variable "api_hostnames" {
  type        = list(string)
  description = "Every API hostname the edge rules apply to, across environments. One ruleset covers the whole zone, so both the staging and the production API hostnames belong here; the rules distinguish them by http.host."
  default     = ["api-staging.pull.fm", "api.pull.fm"]
}

variable "edge_rate_limit_period_seconds" {
  type        = number
  description = "Counting period for the edge rules. 10 and 60 are the only values available below Enterprise."
  default     = 60
}

variable "edge_api_requests_per_period" {
  type        = number
  description = "Volumetric ceiling for all API traffic from one address per period. Above the origin's RATE_LIMIT_MAX by design: the origin is the layer that refuses with a problem document, this is the layer that sheds floods."
  default     = 600
}

variable "edge_catalogue_requests_per_period" {
  type        = number
  description = "Ceiling for catalogue and discovery paths from one address per period. This is the enumeration budget: on these routes a distinct identifier is a guaranteed cache miss and therefore one outbound provider call."
  default     = 120
}

variable "edge_auth_requests_per_period" {
  type        = number
  description = "Ceiling for the unauthenticated auth endpoints from one address per period. Mirrors AUTH_MAGIC_AUTH_PER_IP_MAX at the edge."
  default     = 20
}

variable "enable_edge_api_rule" {
  type        = bool
  description = "Create the volumetric API rate limiting rule."
  default     = true
}

variable "enable_edge_catalogue_rule" {
  type        = bool
  description = "Create the catalogue enumeration rate limiting rule. If the plan allows only one rule, keep this one: it matches the demonstrated abuse."
  default     = true
}

variable "enable_edge_auth_rule" {
  type        = bool
  description = "Create the auth-endpoint rate limiting rule."
  default     = true
}

variable "enable_edge_custom_rules" {
  type        = bool
  description = "Manage the http_request_firewall_custom phase. Off leaves it unmanaged rather than managed-and-empty, which matters because an empty managed ruleset would delete rules created by hand."
  default     = true
}

variable "block_metrics_at_edge" {
  type        = bool
  description = "Refuse /metrics at the edge. Defence in depth behind METRICS_TOKEN; the node-local watchdog scrapes over loopback and never traverses Cloudflare."
  default     = true
}

variable "block_docs_at_edge" {
  type        = bool
  description = "Refuse /docs and /openapi.json at the edge. Leave false wherever the reference browser is deliberately published."
  default     = false
}
