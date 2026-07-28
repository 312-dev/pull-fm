output "ssl_mode" {
  description = "Effective Cloudflare to origin TLS mode for the zone."
  value       = module.zone_settings.ssl_mode
}

output "hsts_enabled" {
  description = "Whether the zone emits Strict-Transport-Security."
  value       = module.zone_settings.hsts_enabled
}
