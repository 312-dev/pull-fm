# Credential is read from CLOUDFLARE_API_TOKEN by the provider itself. See
# ../staging/providers.tf for why nothing is assigned here, and why the legacy
# global API key (CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL) is a bootstrap-only
# credential that must never run an apply.
#
#   source infra/lib/credentials.sh && pullfm_load_credentials shared
#
# `shared` deliberately resolves to the STAGING token. This root owns zone-wide
# TLS posture, which applies to both environments at once, and both per-
# environment tokens already carry Zone Settings Write on pull.fm. A fourth
# credential would add a rotation obligation without narrowing anything.
provider "cloudflare" {}
