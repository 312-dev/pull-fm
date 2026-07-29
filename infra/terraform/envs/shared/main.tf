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

  enable_authenticated_origin_pulls = var.enable_authenticated_origin_pulls
}

# Edge rate limiting and custom firewall rules.
#
# Here for the same reason the TLS settings are: a zone ruleset is a SINGLETON
# per zone and per phase, so staging and prod cannot each own one without every
# apply of one silently deleting the other's rules.
#
# NOT YET APPLIED, AND NOT APPLIABLE WITH ANY TOKEN THIS PROJECT HOLDS. The
# staging token returns "Authentication error" on both /rulesets and
# /rate_limits. The exact permissions a token needs are written down in
# ../../modules/edge-rate-limit/README-token-permissions.md; mint one, then plan
# before applying, because Cloudflare parses the filter expressions server side
# and `terraform validate` cannot see them.
module "edge_rate_limit" {
  source = "../../modules/edge-rate-limit"

  zone_id       = var.cloudflare_zone_id
  api_hostnames = var.api_hostnames

  period_seconds                = var.edge_rate_limit_period_seconds
  api_requests_per_period       = var.edge_api_requests_per_period
  catalogue_requests_per_period = var.edge_catalogue_requests_per_period
  auth_requests_per_period      = var.edge_auth_requests_per_period

  enable_api_rule       = var.enable_edge_api_rule
  enable_catalogue_rule = var.enable_edge_catalogue_rule
  enable_auth_rule      = var.enable_edge_auth_rule

  enable_custom_rules   = var.enable_edge_custom_rules
  block_metrics_at_edge = var.block_metrics_at_edge
  block_docs_at_edge    = var.block_docs_at_edge
}
