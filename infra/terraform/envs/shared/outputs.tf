output "ssl_mode" {
  description = "Effective Cloudflare to origin TLS mode for the zone."
  value       = module.zone_settings.ssl_mode
}

output "hsts_enabled" {
  description = "Whether the zone emits Strict-Transport-Security."
  value       = module.zone_settings.hsts_enabled
}

output "edge_rate_limit_ruleset_id" {
  description = "Ruleset id for the http_ratelimit phase, or null when no rate limiting rule is enabled."
  value       = module.edge_rate_limit.rate_limit_ruleset_id
}

output "edge_custom_ruleset_id" {
  description = "Ruleset id for the http_request_firewall_custom phase, or null when the phase is left unmanaged."
  value       = module.edge_rate_limit.custom_ruleset_id
}

output "edge_ceilings" {
  description = "Effective per-address edge ceilings, so they can be compared against the origin's RATE_LIMIT_MAX without reading the module."
  value       = module.edge_rate_limit.edge_ceilings
}
