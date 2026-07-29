# Both provider blocks are intentionally empty.
#
# The credential is read from the environment by the provider itself:
#   hcloud     <- HCLOUD_TOKEN
#   cloudflare <- CLOUDFLARE_API_TOKEN   (per-environment scoped token)
#
# Assigning a token to a provider argument, even from a sensitive variable,
# writes it into the plan file. Plan files are routinely uploaded as CI
# artifacts and attached to pull requests, and this repository is public. Not
# accepting the value at all is the only version of this that cannot leak.
#
# CLOUDFLARE_API_TOKEN IS THE ONLY SUPPORTED AUTH PATH HERE.
#
# The Cloudflare provider also accepts CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL,
# the legacy account-wide global key, and PREFERS them when both are present.
# That key is a bootstrap credential: it exists to mint and edit API tokens and
# must never run an apply. It cannot be scoped to a zone, cannot be scoped to an
# environment, and reaches every zone on the account plus R2 plus billing.
#
# infra/lib/credentials.sh refuses to run when either variable is set, so a
# stray export in a shell profile fails loudly instead of silently reverting
# per-environment isolation. Load credentials with:
#
#   source infra/lib/credentials.sh && pullfm_load_credentials staging
#
# Token scope (1Password: pull-fm/staging/CLOUDFLARE_API_TOKEN):
#   zone pull.fm -> DNS Write, Zone Read, Zone Settings Write,
#                   SSL and Certificates Write
#   account      -> Workers R2 Storage Write
#
# The account-level R2 grant is not a widening for convenience: R2 buckets are
# account-scoped resources and Cloudflare offers no zone-level or per-bucket
# permission for bucket create/delete, so cloudflare_r2_bucket cannot be managed
# with anything narrower. Without it every plan fails with "failed to make http
# request" on the bucket.
provider "hcloud" {}

provider "cloudflare" {}
