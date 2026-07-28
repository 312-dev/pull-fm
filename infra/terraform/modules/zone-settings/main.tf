# Zone-wide TLS posture.
#
# These settings are properties of the pull.fm zone, not of an environment.
# They live in the envs/shared root precisely because staging and prod would
# otherwise both claim ownership and overwrite each other on alternating
# applies. Per-environment behaviour belongs in the dns module instead.

resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.zone_id
  setting_id = "ssl"
  value      = var.ssl_mode
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = var.zone_id
  setting_id = "min_tls_version"
  value      = var.min_tls_version
}

resource "cloudflare_zone_setting" "tls_1_3" {
  zone_id    = var.zone_id
  setting_id = "tls_1_3"
  value      = "on"
}

resource "cloudflare_zone_setting" "automatic_https_rewrites" {
  zone_id    = var.zone_id
  setting_id = "automatic_https_rewrites"
  value      = "on"
}

# Cloudflare exposes HSTS through the composite security_header setting rather
# than as a scalar, so it is written as one object.
resource "cloudflare_zone_setting" "security_header" {
  count = var.enable_hsts ? 1 : 0

  zone_id    = var.zone_id
  setting_id = "security_header"

  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = var.hsts_max_age
      include_subdomains = var.hsts_include_subdomains
      preload            = var.hsts_preload
      nosniff            = true
    }
  }
}

# Authenticated Origin Pulls, zone wide.
#
# Cloudflare presents a client certificate on every origin connection, and the
# origin refuses the handshake without one. This is the layer that survives an
# attacker who learns the origin IP: the Hetzner firewall cannot help on the
# load-balanced path (that traffic arrives on the private interface, and
# Hetzner Cloud Firewalls filter only the public one), so mTLS is what makes
# the origin unusable to anyone not coming through Cloudflare.
#
# The CA behind this is shared by every Cloudflare customer, so the origin must
# also check the certificate subject. See the nginx config in
# infra/staging/app/nginx-pullfm.conf; enabling this without that check is a
# weaker control than it appears.
#
# Ordering: the origin must be configured to REQUIRE the client certificate
# only once this is enabled, or Cloudflare's handshake fails and the zone
# serves 526.
resource "cloudflare_zone_setting" "authenticated_origin_pulls" {
  zone_id    = var.zone_id
  setting_id = "tls_client_auth"
  value      = var.enable_authenticated_origin_pulls ? "on" : "off"
}
