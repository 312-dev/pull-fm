# The provider block is intentionally empty, for the same reason the hcloud and
# cloudflare blocks in envs/*/providers.tf are.
#
# The credential is read from the environment by the provider itself:
#   neon <- NEON_API_KEY
#
# Verified against the provider documentation rather than assumed:
#   "api_key (String) ... When not specified in the configuration, the provider
#    reads the value from the NEON_API_KEY environment variable."
#   https://registry.terraform.io/providers/kislerdm/neon/latest/docs
#
# Any value assigned to a provider argument is rendered into the plan file even
# when it comes from a variable marked `sensitive`. Plan files get uploaded as
# CI artifacts and attached to pull requests, and this repository is public.
# Refusing to accept the value at all is the only version of this that cannot
# leak.
#
# Load the credential the same way every other root does:
#
#   source infra/lib/credentials.sh && pullfm_load_credentials neon
#
# That reads 1Password item `pull-fm/infra/NEON_API_KEY` and then calls
# pullfm_assert_neon_scope, which lists projects with the key and aborts if it
# can see anything other than the pull-fm project. The key is checked against
# what it can actually reach rather than against how it was named, exactly as
# the Cloudflare and Hetzner tokens are.
#
# SCOPE THE KEY AT NEON, NOT ONLY HERE. A personal API key inherits everything
# its owner can do, across every project on the account. Prefer an
# organisation-scoped key limited to the pull-fm project; the guard function is
# a backstop for a key that was minted too wide, not a substitute for minting it
# narrow.
provider "neon" {}
