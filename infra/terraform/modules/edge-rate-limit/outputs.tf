output "rate_limit_ruleset_id" {
  description = "Ruleset id for the http_ratelimit phase, or null when every rate limiting rule is disabled."
  value       = try(cloudflare_ruleset.rate_limit[0].id, null)
}

output "custom_ruleset_id" {
  description = "Ruleset id for the http_request_firewall_custom phase, or null when the phase is left unmanaged."
  value       = try(cloudflare_ruleset.custom[0].id, null)
}

output "rate_limit_rule_refs" {
  description = "The rate limiting rules actually created, in evaluation order. Ordering is load-bearing: the narrow catalogue budget must be evaluated before the broad volumetric one."
  value       = [for r in local.rate_limit_rules : r.ref]
}

output "custom_rule_refs" {
  description = "The custom firewall rules actually created."
  value       = [for r in local.custom_rules : r.ref]
}

output "edge_ceilings" {
  description = "The effective per-address ceilings, so an operator can compare them against the origin's RATE_LIMIT_MAX without reading the module."
  value = {
    period_seconds = var.period_seconds
    api            = var.enable_api_rule ? var.api_requests_per_period : null
    catalogue      = var.enable_catalogue_rule ? var.catalogue_requests_per_period : null
    auth           = var.enable_auth_rule ? var.auth_requests_per_period : null
  }
}
