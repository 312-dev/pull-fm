output "ssl_mode" {
  description = "Effective Cloudflare to origin TLS mode."
  value       = cloudflare_zone_setting.ssl.value
}

output "hsts_enabled" {
  description = "Whether Strict-Transport-Security is being emitted for the zone."
  value       = var.enable_hsts
}
