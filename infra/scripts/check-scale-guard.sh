#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Proves that scaling out without externalizing Redis FAILS A PLAN.
#
#   ./infra/scripts/check-scale-guard.sh
#
# The guard it exercises is the validation on app_node_count in
# infra/terraform/modules/compute/variables.tf. The property being protected is
# not a cost or a tidiness one:
#
#   Redis holds the MusicBrainz token bucket. MusicBrainz permits ONE REQUEST
#   PER SECOND FOR THE ENTIRE SERVICE, per IP, and Gate 1 asserts it at the
#   network layer. At one application node with Redis co-located there is one
#   bucket and the invariant holds by construction. At two nodes each running a
#   local Redis there are two buckets, each correctly honouring 1 req/s, and the
#   service emits 2 req/s while both nodes report perfect compliance. MetaBrainz
#   revokes API access for that, and nothing in the product works without them.
#
# A comment cannot enforce that, and neither can a code review that nobody runs.
# This is the check that the enforcement is real, and it is written as a script
# rather than left as a claim in a runbook because "the guard exists" is exactly
# the kind of statement that stays true in documentation after it stops being
# true in code.
#
# WHY A PLAN RATHER THAN `terraform validate`. `validate` does not evaluate
# variable validation for module inputs; it returns "Success!" on the very
# configuration this rejects. That was checked, not assumed, and it is the
# reason this script is more than two lines.
#
# Requires: terraform, and network access the first time (the fixture downloads
# the hcloud provider). No credentials: the plan is EXPECTED to also fail on the
# unconfigured provider, and this script asserts only on the validation message.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MODULE="${ROOT}/infra/terraform/modules/compute"

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

cat >"${WORK}/main.tf" <<EOF
terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.68"
    }
  }
}

# Deliberately the forbidden combination: more than one application node with
# Redis still co-located and no load balancer in front.
module "compute" {
  source = "${MODULE}"

  name_prefix       = "guard-test"
  labels            = {}
  location          = "fsn1"
  network_id        = "1"
  subnet_ip_range   = "10.20.1.0/24"
  app_firewall_id   = "1"
  cache_firewall_id = "2"

  app_node_count       = 2
  enable_cache_node    = false
  enable_load_balancer = false
}
EOF

echo "initialising the guard fixture..."
terraform -chdir="${WORK}" init -input=false -no-color >/dev/null

echo "planning the forbidden shape (this MUST fail)..."
set +e
OUTPUT=$(terraform -chdir="${WORK}" plan -input=false -no-color 2>&1)
STATUS=$?
set -e

fail() {
  echo
  echo "GUARD CHECK FAILED: $1" >&2
  echo
  echo "${OUTPUT}" >&2
  exit 1
}

[ "${STATUS}" -ne 0 ] || fail "terraform plan SUCCEEDED on two app nodes with Redis co-located. The MusicBrainz 1 req/s ceiling is no longer mechanically protected."

grep -q "app_node_count > 1 requires enable_cache_node = true" <<<"${OUTPUT}" ||
  fail "the plan failed, but not on the cache-node guard. Something else broke first, so the guard is unproven."

grep -q "app_node_count > 1 requires enable_load_balancer = true" <<<"${OUTPUT}" ||
  fail "the plan failed, but not on the load-balancer guard. A second node would be billed and never sent a request."

grep -q "1 request per second" <<<"${OUTPUT}" ||
  fail "the error message no longer explains WHY. An error a reader cannot act on gets worked around."

# The allowed shape must still plan past validation. Same fixture with the two
# flags set: it will still fail on the unconfigured provider, which is fine, but
# it must NOT fail on either validation. Without this half, a guard that
# rejected every value at all would pass the checks above.
sed -i.bak \
  -e 's/enable_cache_node    = false/enable_cache_node    = true/' \
  -e 's/enable_load_balancer = false/enable_load_balancer = true/' \
  "${WORK}/main.tf"

echo "planning the supported scale-out shape (validation must NOT fire)..."
set +e
ALLOWED=$(terraform -chdir="${WORK}" plan -input=false -no-color 2>&1)
set -e

if grep -q "app_node_count > 1 requires" <<<"${ALLOWED}"; then
  echo
  echo "GUARD CHECK FAILED: the documented two-node scale step is also rejected." >&2
  echo "This is right-sizing, not deletion: the two-node path has to stay usable." >&2
  echo
  echo "${ALLOWED}" >&2
  exit 1
fi

echo
echo "PASS"
echo "  two nodes with co-located Redis      rejected at plan time, with the reason"
echo "  two nodes with a separate cache node  accepted"
