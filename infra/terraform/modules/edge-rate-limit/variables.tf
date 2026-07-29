variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for pull.fm."
}

variable "api_hostnames" {
  type        = list(string)
  description = "Every API hostname these rules apply to, across environments. Zone rulesets are singletons per zone and per phase, so staging and prod cannot each own one; the environments are distinguished inside the expressions instead. An empty list makes every rule match nothing, which is a silent no-op and is refused below."

  validation {
    condition     = length(var.api_hostnames) > 0
    error_message = "At least one API hostname is required. An empty list produces rules that match nothing, which looks deployed and protects nothing."
  }
}

# ---------------------------------------------------------------------------
# Rate limiting rules.
#
# PLAN CONSTRAINTS, because getting these wrong is an apply-time failure rather
# than a plan-time one. Cloudflare rate limiting rules allow a `period` of 10 or
# 60 seconds on Pro and Business, and add 120/300/600/3600 on Enterprise. The
# number of rules is also plan-bound (Free 1, Pro 2, Business 5, Enterprise
# 100+). Every rule below is individually toggleable so a zone on a smaller plan
# can deploy the subset it is entitled to rather than failing the whole apply.
# ---------------------------------------------------------------------------

variable "period_seconds" {
  type        = number
  description = "Counting period for every rate limiting rule. 10 and 60 are the only values available below Enterprise."
  default     = 60

  validation {
    condition     = contains([10, 60, 120, 300, 600, 3600], var.period_seconds)
    error_message = "period_seconds must be one of 10, 60, 120, 300, 600, 3600. Values above 60 are Enterprise-only and will fail at apply on a smaller plan."
  }
}

variable "mitigation_timeout_seconds" {
  type        = number
  description = "How long the action stays applied after the threshold is first crossed. Kept equal to the period by default so a blocked client is released as soon as its own counter would have reset, rather than being punished for longer than it misbehaved."
  default     = 60
}

variable "api_requests_per_period" {
  type        = number
  description = "Ceiling for all API traffic from one address. Deliberately ABOVE the origin's own RATE_LIMIT_MAX (300 a minute): the origin limiter is the precise control and this is the volumetric shield, so a client that the origin would refuse should be refused by the origin, with its problem+json body, rather than by an edge block that says nothing. This exists to shed floods before they cost an origin connection at all."
  default     = 600
}

variable "catalogue_requests_per_period" {
  type        = number
  description = "Ceiling for the catalogue and discovery paths from one address. These are the routes where a distinct identifier is a guaranteed cache miss and therefore one outbound provider call, so this is the enumeration budget rather than a traffic budget. Well above any real client (a feed render fetches a handful) and far below a useful enumeration rate."
  default     = 120
}

variable "auth_requests_per_period" {
  type        = number
  description = "Ceiling for the unauthenticated auth endpoints from one address. Mirrors AUTH_MAGIC_AUTH_PER_IP_MAX at the edge so a mail-relay abuse attempt is refused before it reaches the origin, the WorkOS API, or anyone's inbox."
  default     = 20
}

variable "enable_api_rule" {
  type        = bool
  description = "The volumetric API ceiling."
  default     = true
}

variable "enable_catalogue_rule" {
  type        = bool
  description = "The catalogue enumeration ceiling. If the plan only allows ONE rate limiting rule, this is the one to keep: it is the rule that matches the demonstrated abuse."
  default     = true
}

variable "enable_auth_rule" {
  type        = bool
  description = "The auth-endpoint ceiling."
  default     = true
}

# ---------------------------------------------------------------------------
# Custom firewall rules.
# ---------------------------------------------------------------------------

variable "enable_custom_rules" {
  type        = bool
  description = "Create the http_request_firewall_custom ruleset at all. Off leaves the phase unmanaged rather than managed-and-empty, which matters because an empty managed ruleset would DELETE any rule created by hand in the dashboard."
  default     = true
}

variable "block_metrics_at_edge" {
  type        = bool
  description = "Refuse /metrics at the edge. Defence in depth rather than the control: METRICS_TOKEN is the control and loopback callers are exempted at the origin by socket address. The origin's nginx serves `location /` to the edge, so this closes the path from the public internet without touching the node-local watchdog, which never traverses Cloudflare."
  default     = true
}

variable "block_docs_at_edge" {
  type        = bool
  description = "Refuse /docs and /openapi.json at the edge. Intended for production, where DOCS_ENABLED is false and the paths should not merely 404 from the origin. Leave false wherever the reference browser is deliberately published."
  default     = false
}
