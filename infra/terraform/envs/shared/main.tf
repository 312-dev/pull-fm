# Pull.fm - zone-wide Cloudflare configuration.
#
# Why this root exists at all: TLS mode, minimum TLS version and HSTS are
# properties of the pull.fm ZONE, not of an environment. If staging and prod
# each managed them, every apply of one would revert the other's settings and
# the last apply would win silently. Splitting them out means each setting has
# exactly one owner.
#
# Nothing environment-specific belongs here. DNS records are per-environment
# and stay in envs/staging and envs/prod.

module "zone_settings" {
  source = "../../modules/zone-settings"

  zone_id                 = var.cloudflare_zone_id
  ssl_mode                = var.ssl_mode
  min_tls_version         = var.min_tls_version
  enable_hsts             = var.enable_hsts
  hsts_max_age            = var.hsts_max_age
  hsts_include_subdomains = var.hsts_include_subdomains
  hsts_preload            = var.hsts_preload
}
