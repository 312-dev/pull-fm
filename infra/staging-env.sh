#!/usr/bin/env bash
#
# Ephemeral staging: bring the environment up for a gate run, tear it down after.
#
# Staging exists to run gates, not to serve traffic. Hetzner bills by the hour,
# so a standing environment costs about EUR 35 a month to sit idle, while a
# three hour gate session costs around EUR 0.15. Rebuilding from IaC is already
# a Gate 4 requirement, so tearing down exercises the thing we have to prove
# anyway rather than avoiding it.
#
#   ./infra/staging-env.sh up       provision and print the endpoints
#   ./infra/staging-env.sh down     destroy compute, KEEP the backup bucket
#   ./infra/staging-env.sh status   what is running and what it costs
#   ./infra/staging-env.sh cost     current monthly run rate
#
# CREDENTIALS: per-environment scoped tokens only, loaded from 1Password by
# infra/lib/credentials.sh. The Cloudflare global API key is bootstrap-only and
# this script refuses to start when CLOUDFLARE_API_KEY or CLOUDFLARE_EMAIL are
# present in the environment. Both tokens are then checked against what they can
# actually see: Hetzner must not enumerate the personal fleet, and Cloudflare
# must not enumerate a zone other than pull.fm.
#
# WHAT SURVIVES A TEARDOWN, and why:
#   - The R2 backup bucket. It holds the only copy of anything worth keeping,
#     and it is free at this size. Destroying it would make the Gate 4 restore
#     drill meaningless.
#   - Terraform state.
#
# WHAT DOES NOT SURVIVE: servers, the load balancer, the private network, the
# DNS records, and every byte of staging Postgres data. That is the point. If a
# teardown loses something you needed, it belonged in R2.
#
# DNS USED TO BE ON THE SURVIVES LIST AND THAT WAS WRONG. Measured 2026-07-29:
# `terraform destroy -target=...` destroys the targets AND everything that
# depends on them, and each DNS record's content is the load balancer address.
# The record cannot outlive the address it publishes, so a keep-list entry for
# module.dns did nothing except make the header untrue. `up` recreates all four
# records from IaC, which costs one Cloudflare propagation and nothing else.
#
# THE SECOND LOCK HAS TO BE UNLOCKED FIRST. Hetzner's delete_protection is
# enforced by the API, so it survives `terraform destroy` and fails it halfway:
# the app node, firewalls and DNS go, while the database node and load balancer
# stay up and keep billing. The staging root now defaults both flags to false
# (docs/PLAN.md section 10c always said staging should), but a live resource
# created before that change still carries the flag in Hetzner, and the
# Terraform graph that would clear it is already half destroyed by then. So
# clear_delete_protection() clears it over the API, and only for a project that
# has already passed the personal-fleet refusal above.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_DIR="${ROOT}/infra/terraform/envs/staging"

# Per-environment scoped credentials. The Cloudflare global API key is a
# bootstrap credential for minting tokens and is refused here; see the header
# of infra/lib/credentials.sh.
# shellcheck source=lib/credentials.sh
source "${ROOT}/infra/lib/credentials.sh"

# Resources deliberately excluded from teardown. See the header.
#
# module.dns is NOT here, despite being free to keep, because a keep-list cannot
# protect a resource that depends on a target: the records publish the load
# balancer address and go with it. Listing it would document a guarantee the
# mechanism cannot make.
readonly KEEP=(
  "module.backup_storage"
)

log()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

load_credentials() {
  pullfm_load_credentials staging || die "could not load staging credentials"
}

# Both tokens are checked against what they can actually see rather than
# against how they were named: Hetzner must not enumerate the personal fleet,
# and Cloudflare must not enumerate a second zone.
assert_correct_project() {
  pullfm_assert_hetzner_project || exit 1
  pullfm_assert_cloudflare_scope || exit 1
}

cmd_up() {
  load_credentials
  assert_correct_project
  log "provisioning staging..."
  terraform -chdir="${ENV_DIR}" apply -input=false -auto-approve
  echo
  log "endpoints"
  terraform -chdir="${ENV_DIR}" output 2>/dev/null | grep -E "hostname|ipv4|bucket" || true
  echo
  warn "The meter is running. Tear down with: ./infra/staging-env.sh down"
}

# Hetzner delete/rebuild protection is enforced by the API and therefore
# survives terraform. Clearing it here rather than through terraform is
# deliberate: by the time a targeted destroy hits the protected resource, the
# network and firewall it depends on may already be gone, so the apply that
# would flip the flag cannot be planned. Only ever reached after
# pullfm_assert_hetzner_project has confirmed this is not the personal fleet.
clear_delete_protection() {
  local id kind
  # networks last in the list but first in the failure order: a protected
  # network blocks the FINAL step of a teardown, after every server it contained
  # is already gone, which is the most expensive place for a destroy to stop.
  for kind in servers load_balancers networks volumes; do
    while read -r id; do
      [[ -z "${id}" ]] && continue
      warn "clearing delete protection on ${kind}/${id}"
      curl -sS -o /dev/null -X POST \
        -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
        -H 'Content-Type: application/json' \
        --data '{"delete":false,"rebuild":false}' \
        "https://api.hetzner.cloud/v1/${kind}/${id}/actions/change_protection" || true
    done < <(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
      "https://api.hetzner.cloud/v1/${kind}" |
      python3 -c "
import json,sys
for x in json.load(sys.stdin).get('${kind}', []):
    if any((x.get('protection') or {}).values()):
        print(x['id'])
")
  done
}

cmd_down() {
  load_credentials
  assert_correct_project
  clear_delete_protection

  log "destroying staging compute (the R2 backup bucket is preserved)..."

  # Build a target list of everything EXCEPT the keep-list. Terraform has no
  # "destroy all but these" flag, so the exclusion is computed from state.
  local targets=()
  while read -r addr; do
    [[ -z "${addr}" ]] && continue
    local keep=false
    for k in "${KEEP[@]}"; do
      [[ "${addr}" == "${k}"* ]] && keep=true && break
    done
    [[ "${keep}" == false ]] && targets+=("-target=${addr}")
  done < <(terraform -chdir="${ENV_DIR}" state list 2>/dev/null || true)

  if [[ ${#targets[@]} -eq 0 ]]; then
    log "nothing to destroy"
    return 0
  fi

  terraform -chdir="${ENV_DIR}" destroy -input=false -auto-approve "${targets[@]}"
  echo
  log "staging destroyed. The R2 backup bucket remains; DNS is rebuilt by 'up'."
  cmd_cost
}

cmd_status() {
  load_credentials
  # The escaping here is deliberate: an f-string cannot contain a backslash
  # before Python 3.12, so the JSON keys are lifted into locals first and the
  # program is fed on stdin rather than through -c.
  local servers
  servers="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    https://api.hetzner.cloud/v1/servers)"
  python3 - "${servers}" <<'PY'
import json, sys

srv = json.loads(sys.argv[1]).get("servers", [])
if not srv:
    print("  no servers running (staging is torn down)")
for x in srv:
    ip = (x.get("public_net", {}).get("ipv4") or {}).get("ip", "-")
    name, kind, state = x["name"], x["server_type"]["name"], x["status"]
    print(f"  {name:26s} {kind:7s} {state:9s} {ip}")
PY
}

cmd_cost() {
  load_credentials
  local servers lbs
  servers="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" https://api.hetzner.cloud/v1/servers)"
  lbs="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" https://api.hetzner.cloud/v1/load_balancers)"
  python3 - "$servers" "$lbs" <<'PY'
import json, sys
srv = json.loads(sys.argv[1]).get("servers", [])
lbs = json.loads(sys.argv[2]).get("load_balancers", [])
total = 0.0
for x in srv:
    p = float(x["server_type"]["prices"][0]["price_monthly"]["gross"]); total += p
    print(f"  {x['name']:26s} EUR {p:6.2f}/mo")
for l in lbs:
    p = float(l["load_balancer_type"]["prices"][0]["price_monthly"]["gross"]); total += p
    print(f"  {l['name']:26s} EUR {p:6.2f}/mo")
print(f"  {'TOTAL':26s} EUR {total:6.2f}/mo  (about EUR {total/730:.4f}/hour)")
if total == 0:
    print("  staging is fully torn down; only free-tier resources remain")
PY
}

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  cost)   cmd_cost ;;
  *)      die "usage: $0 {up|down|status|cost}" ;;
esac
