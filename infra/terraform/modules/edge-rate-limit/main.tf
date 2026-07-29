# Edge rate limiting and custom firewall rules for the pull.fm zone.
#
# WHY THIS MODULE EXISTS
# ----------------------
# security/AUDIT-2026-07-29.md F11 found that there is no `cloudflare_ruleset`
# anywhere in infra/terraform: no WAF rules, no rate limiting rules, no bot
# management. Meanwhile envs/*/main.tf warns that a misconfiguration "hands an
# attacker a direct path around WAF and rate limiting", and THREAT-MODEL T01
# describes bypassing "WAF, bot management, per-IP rate limits, and the
# maintenance worker in one move". The threat model was describing the intended
# design; the tree contained the TLS half of it. F10 and F12 were both scored on
# the assumption that something sits in front, and nothing did.
#
# WHAT IT IS AND IS NOT
# ---------------------
# This is a volumetric shield, not the real control. The controls that actually
# understand what is being spent are in the application: the per-subject
# upstream-call budget (apps/bff/src/lib/upstream-budget.ts) and the per-IP floor
# (apps/bff/src/lib/rate-limit-store.ts), both counted in the `noeviction` quota
# Redis. The edge cannot know whether a request will be a cache hit, so it cannot
# budget upstream calls; what it can do is refuse a flood before it costs an
# origin connection, and refuse an obvious enumeration sweep before it costs
# anything at all.
#
# The two layers are deliberately not set to the same number. The edge sits
# ABOVE the origin ceiling so that a client the origin would refuse is refused BY
# the origin, with an RFC 9457 problem document explaining itself, rather than by
# an edge block that says nothing a client can act on.
#
# WHY THIS ROOT AND NOT A PER-ENVIRONMENT ONE
# -------------------------------------------
# A zone ruleset is a SINGLETON per zone and per phase. If envs/staging and
# envs/prod each declared one, every apply of one would delete the other's rules
# and the last apply would win silently - the same argument that put the TLS
# settings in envs/shared. The environments are distinguished inside the rule
# expressions via `api_hostnames` instead.
#
# APPLYING THIS NEEDS A TOKEN THAT DOES NOT EXIST YET
# ---------------------------------------------------
# No API token this project holds can create a ruleset: the staging token returns
# "Authentication error" on both /rulesets and /rate_limits. The exact permission
# set required is in README-token-permissions.md next to this file. Nothing here
# has been applied, and nothing here should be applied by weakening a scope to
# make it work.
#
# EXPRESSIONS ARE ONLY VALIDATED AT APPLY. `terraform validate` checks HCL and
# the provider schema; Cloudflare parses the filter expressions server side. Run
# `terraform plan` and then a real apply against staging first.

locals {
  # Repeated in several expressions, so it is built once. `http.host` is the
  # requested hostname, which is what distinguishes staging from production
  # inside a single zone-wide ruleset.
  api_host_match = join(
    " or ",
    [for h in var.api_hostnames : format("http.host eq %q", h)],
  )

  # The paths where a distinct identifier is a guaranteed cache miss and
  # therefore one outbound provider call. `/artists/`, `/tracks/` and `/albums/`
  # carry an MBID; `/search` carries a free-text query. These are the routes the
  # audit's cost asymmetry actually lives on.
  catalogue_prefixes = [
    "/v1/artists/",
    "/v1/tracks/",
    "/v1/albums/",
    "/v1/search",
    "/v1/feed",
    "/v1/recommendations",
    "/v1/stations",
  ]

  catalogue_path_match = join(
    " or ",
    [
      for p in local.catalogue_prefixes :
      format("starts_with(http.request.uri.path, %q)", p)
    ],
  )

  # The unauthenticated auth surface. `/v1/auth/start` sends mail, so an
  # unthrottled one is an open relay pointed at other people's inboxes.
  auth_path_match = "starts_with(http.request.uri.path, \"/v1/auth/\")"

  rate_limit_rules = concat(
    var.enable_catalogue_rule ? [{
      # FIRST, because rule order matters: the narrower budget has to be
      # evaluated before the broad one, or the broad rule's higher ceiling would
      # be the only one that ever fires on these paths.
      ref         = "pullfm_catalogue_enumeration"
      description = "Catalogue and discovery enumeration ceiling. A distinct identifier on these paths is a guaranteed cache miss and therefore one outbound provider call, so this is an enumeration budget rather than a traffic budget."
      expression  = "(${local.api_host_match}) and (${local.catalogue_path_match})"
      threshold   = var.catalogue_requests_per_period
    }] : [],

    var.enable_auth_rule ? [{
      ref         = "pullfm_auth_endpoints"
      description = "Unauthenticated auth-endpoint ceiling. POST /v1/auth/start causes mail to be sent, so this is refused at the edge before it reaches the origin, the identity provider, or an inbox."
      expression  = "(${local.api_host_match}) and (${local.auth_path_match})"
      threshold   = var.auth_requests_per_period
    }] : [],

    var.enable_api_rule ? [{
      # LAST, and deliberately the loosest. This is the volumetric backstop, set
      # above the origin's own ceiling so the origin stays the layer that
      # explains itself to a client.
      ref         = "pullfm_api_volumetric"
      description = "Volumetric ceiling for all API traffic from one address. Set above the origin's RATE_LIMIT_MAX on purpose: the origin refuses with problem+json, this refuses floods before they cost an origin connection."
      expression  = "(${local.api_host_match}) and starts_with(http.request.uri.path, \"/v1/\")"
      threshold   = var.api_requests_per_period
    }] : [],
  )

  custom_rules = concat(
    var.block_metrics_at_edge ? [{
      ref         = "pullfm_block_metrics"
      description = "Refuse /metrics from the public internet. Defence in depth: METRICS_TOKEN is the control and the node-local watchdog scrapes over loopback, which never traverses Cloudflare."
      expression  = "http.request.uri.path eq \"/metrics\""
    }] : [],

    var.block_docs_at_edge ? [{
      ref         = "pullfm_block_docs"
      description = "Refuse the reference browser and the OpenAPI document at the edge, for deployments where they are not meant to be published."
      expression  = "http.request.uri.path eq \"/openapi.json\" or starts_with(http.request.uri.path, \"/docs\")"
    }] : [],
  )
}

# ---------------------------------------------------------------------------
# Rate limiting rules (phase http_ratelimit).
#
# `characteristics` is ["ip.src", "cf.colo.id"] rather than ["ip.src"] alone,
# and that is the documented requirement rather than a choice: Cloudflare counts
# per data centre, so the colo has to be part of the key. The practical effect is
# that the real ceiling is per-address-per-colo; a single client reaches one
# colo, and an attacker spread across colos is a different rule's problem.
#
# `requests_to_origin = false` counts every request, including ones Cloudflare
# answers from its own cache. That is correct here: the thing being protected is
# the origin AND the shared upstream allowances behind it, and a request that
# Cloudflare serves from cache still tells us the client is sweeping.
# ---------------------------------------------------------------------------
resource "cloudflare_ruleset" "rate_limit" {
  count = length(local.rate_limit_rules) > 0 ? 1 : 0

  zone_id     = var.zone_id
  name        = "pullfm-rate-limit"
  description = "Per-address ceilings at the edge. The precise controls are in the application; see infra/terraform/modules/edge-rate-limit/main.tf."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    for r in local.rate_limit_rules : {
      ref         = r.ref
      description = r.description
      expression  = r.expression
      action      = "block"
      enabled     = true

      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = var.period_seconds
        requests_per_period = r.threshold
        mitigation_timeout  = var.mitigation_timeout_seconds
        requests_to_origin  = false
      }

      action_parameters = {
        # The API answers RFC 9457 everywhere else, so the edge does too. A
        # client that has to parse one error shape from the origin and an HTML
        # block page from the edge will parse neither.
        response = {
          status_code  = 429
          content_type = "application/problem+json"
          content = jsonencode({
            type   = "https://pull.fm/problems/rate-limited"
            title  = "Too Many Requests"
            status = 429
            detail = "Too many requests from this address. Slow down and retry later."
          })
        }
      }

      logging = {
        enabled = true
      }
    }
  ]
}

# ---------------------------------------------------------------------------
# Custom firewall rules (phase http_request_firewall_custom).
#
# Kept deliberately small. A large hand-written custom ruleset is a maintenance
# burden that ages badly and starts blocking legitimate clients; these two are
# path-scoped and cannot false-positive on a real API call.
# ---------------------------------------------------------------------------
resource "cloudflare_ruleset" "custom" {
  count = var.enable_custom_rules && length(local.custom_rules) > 0 ? 1 : 0

  zone_id     = var.zone_id
  name        = "pullfm-custom"
  description = "Path-scoped refusals at the edge. Defence in depth behind the origin's own controls, never instead of them."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    for r in local.custom_rules : {
      ref         = r.ref
      description = r.description
      expression  = r.expression
      action      = "block"
      enabled     = true

      action_parameters = {
        response = {
          status_code  = 403
          content_type = "application/problem+json"
          content = jsonencode({
            type   = "https://pull.fm/problems/forbidden"
            title  = "Forbidden"
            status = 403
            detail = "This path is not available."
          })
        }
      }

      logging = {
        enabled = true
      }
    }
  ]
}
