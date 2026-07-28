# Both provider blocks are intentionally empty.
#
# The credential is read from the environment by the provider itself:
#   hcloud     <- HCLOUD_TOKEN
#   cloudflare <- CLOUDFLARE_API_TOKEN
#
# Assigning a token to a provider argument, even from a sensitive variable,
# writes it into the plan file. Plan files are routinely uploaded as CI
# artifacts and attached to pull requests, and this repository is public. Not
# accepting the value at all is the only version of this that cannot leak.
provider "hcloud" {}

provider "cloudflare" {}
