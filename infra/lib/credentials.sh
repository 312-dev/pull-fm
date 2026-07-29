# shellcheck shell=bash
#
# Pull.fm - per-environment credential loading.
#
# SOURCE this file. It defines functions and exports nothing by itself, so
# sourcing it has no side effect until a function is called.
#
#   source "${ROOT}/infra/lib/credentials.sh"
#   pullfm_load_credentials staging
#
# ---------------------------------------------------------------------------
# The rule this file exists to enforce
# ---------------------------------------------------------------------------
#
# The Cloudflare **global API key** is a bootstrap credential only. It can mint
# and edit API tokens and nothing in this repository may run with it. It cannot
# be scoped: it grants full control of every zone on the account, plus R2, plus
# billing, and it is identical for staging and production.
#
# Every running process uses a **per-environment scoped API token** instead:
#
#   staging  ->  1Password  pull-fm/staging/CLOUDFLARE_API_TOKEN
#   prod     ->  1Password  pull-fm/prod/CLOUDFLARE_API_TOKEN
#
# Each token is limited to the pull.fm zone (DNS Write, Zone Read, Zone
# Settings Write, SSL and Certificates Write) plus account-level Workers R2
# Storage Write, which Terraform needs because cloudflare_r2_bucket is an
# account-scoped resource. See docs/RUNBOOK-COST.md and infra/terraform/README.md.
#
# pullfm_load_credentials REFUSES TO RUN if CLOUDFLARE_API_KEY or
# CLOUDFLARE_EMAIL are present, because the Cloudflare provider prefers them
# over CLOUDFLARE_API_TOKEN. A stray export in a shell profile would silently
# put every apply back on the global key while this file still looked correct.
# ---------------------------------------------------------------------------

readonly PULLFM_OP_VAULT="${PULLFM_OP_VAULT:-MCP}"

# The pull.fm zone. A token that can see anything else is not scoped.
readonly PULLFM_ZONE="pull.fm"

# The Neon organisation and project. Public identifiers, not credentials: they
# are the same values committed in infra/neon/terraform.tfvars.example.
readonly PULLFM_NEON_ORG_ID="${PULLFM_NEON_ORG_ID:-org-tiny-leaf-89756764}"
readonly PULLFM_NEON_PROJECT="${PULLFM_NEON_PROJECT:-pull-fm}"

# 1Password item holding the Neon API key, addressed BY ITEM ID.
#
# The human-readable title contains parentheses, which are not legal in an
# op:// secret reference, so the id form is the only one that resolves. Item ids
# are stable across renames, which is a second reason to prefer them.
readonly PULLFM_NEON_OP_ITEM="${PULLFM_NEON_OP_ITEM:-5ccxlg635x37rybelz53yeaqf4}"

_pullfm_die() { printf '\033[31m%s\033[0m\n' "$*" >&2; return 1; }

# `op read` addresses items with op://vault/item/field, so an item whose TITLE
# contains a slash (all of ours do: pull-fm/staging/...) is unaddressable that
# way. `op item get --fields label=` has no such restriction.
_pullfm_op_field() {
  local item="$1" field="$2" value
  value="$(op item get "${item}" --vault "${PULLFM_OP_VAULT}" \
    --fields "label=${field}" --reveal 2>/dev/null)" ||
    _pullfm_die "1Password: could not read '${field}' from item '${item}'" || return 1
  [[ -n "${value}" ]] ||
    _pullfm_die "1Password: field '${field}' on item '${item}' is empty" || return 1
  printf '%s' "${value}"
}

# Hard stop if the account-wide bootstrap credential is in the environment.
pullfm_reject_global_key() {
  if [[ -n "${CLOUDFLARE_API_KEY:-}" || -n "${CLOUDFLARE_EMAIL:-}" ]]; then
    _pullfm_die "REFUSING TO RUN: CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL are set.

The Cloudflare global API key is a bootstrap credential for minting tokens, not
a runtime credential. The provider prefers it over CLOUDFLARE_API_TOKEN, so
leaving it set silently reverts per-environment isolation (PULLFM-RISK-005).

  unset CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL"
    return 1
  fi
}

# Prove the token really is zone-scoped rather than trusting how it was minted.
# A token that can enumerate a second zone is not a per-environment credential,
# whatever its name says.
pullfm_assert_cloudflare_scope() {
  local zones
  zones="$(curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/zones?per_page=50" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(z["name"] for z in d.get("result") or []) if d.get("success") else "!ERROR")')"

  if [[ "${zones}" == "!ERROR" ]]; then
    _pullfm_die "Cloudflare token rejected by the API. Is it active?"
    return 1
  fi

  local unexpected
  unexpected="$(grep -vx "${PULLFM_ZONE}" <<<"${zones}" || true)"
  if [[ -n "${unexpected}" ]]; then
    _pullfm_die "REFUSING TO RUN: this Cloudflare token can see zones other than ${PULLFM_ZONE}:
${unexpected}"
    return 1
  fi
}

# Prove the Neon API key cannot reach a project other than pull-fm.
#
# Same principle as the Cloudflare check above, and it matters more here: a Neon
# PERSONAL api key inherits everything its owner can do across every
# organisation they belong to, and there is nothing in the key itself that says
# so. An organisation-scoped key is the correct credential; this function is the
# backstop that notices when a wider one was used by mistake.
#
# Neon's API now REQUIRES org_id as a query parameter for an organisation's
# projects. A bare GET /projects returns the caller's personal projects only, so
# both are checked: the org listing must contain exactly pull-fm, and the
# personal listing must be empty. A key that can see a personal project is a key
# whose blast radius is not this repository.
pullfm_assert_neon_scope() {
  local org="${PULLFM_NEON_ORG_ID}" body names

  body="$(curl -sS -H "Authorization: Bearer ${NEON_API_KEY}" \
    "https://console.neon.tech/api/v2/projects?org_id=${org}")" ||
    _pullfm_die "Neon API unreachable" || return 1

  names="$(printf '%s' "${body}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if "projects" not in d:
    print("!ERROR " + json.dumps(d)[:200])
else:
    print("\n".join(p["name"] for p in d["projects"]))
')"

  if [[ "${names}" == "!ERROR"* ]]; then
    _pullfm_die "Neon rejected the API key or the org id: ${names#!ERROR }"
    return 1
  fi

  local unexpected
  unexpected="$(grep -vx "${PULLFM_NEON_PROJECT}" <<<"${names}" | grep -v '^$' || true)"
  if [[ -n "${unexpected}" ]]; then
    _pullfm_die "REFUSING TO RUN: this Neon key can see projects other than ${PULLFM_NEON_PROJECT}:
${unexpected}"
    return 1
  fi

  # A key with no personal projects still proves nothing about scoping, but a
  # key WITH them proves the absence of it, which is the case worth catching.
  local personal
  personal="$(curl -sS -H "Authorization: Bearer ${NEON_API_KEY}" \
    "https://console.neon.tech/api/v2/projects" |
    python3 -c '
import json, sys
try:
    print("\n".join(p["name"] for p in json.load(sys.stdin).get("projects") or []))
except Exception:
    print("")
')"
  if [[ -n "${personal}" ]]; then
    _pullfm_die "REFUSING TO RUN: this Neon key also reaches personal projects:
${personal}

Mint an organisation-scoped key for ${PULLFM_NEON_ORG_ID} instead."
    return 1
  fi
}

# Guard against pointing Hetzner work at the wrong project. The pull-fm token
# must only ever see pull-fm resources; if it enumerates the personal fleet,
# stop before anything is created or destroyed.
pullfm_assert_hetzner_project() {
  local names
  names="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    https://api.hetzner.cloud/v1/servers | grep -o '"name":"[^"]*"' || true)"
  if grep -qE 'anythingllm|ente-jellyfin|hetzner-box' <<<"${names}"; then
    _pullfm_die "REFUSING TO RUN: this Hetzner token sees the personal fleet, not the pull-fm project."
    return 1
  fi
}

# pullfm_load_credentials <staging|prod|shared>
#
# `shared` (envs/shared, the zone-wide TLS posture) deliberately resolves to the
# staging token: the zone settings it owns apply to both environments, and both
# per-environment tokens carry Zone Settings Write on pull.fm. Giving it a
# fourth credential would add a rotation obligation without narrowing anything.
pullfm_load_credentials() {
  local env="${1:?usage: pullfm_load_credentials <staging|prod|shared|neon>}"

  command -v op >/dev/null || _pullfm_die "1Password CLI (op) not found" || return 1
  pullfm_reject_global_key || return 1

  case "${env}" in
    shared) env=staging ;;
    staging | prod) ;;
    neon)
      # infra/neon is a fourth root and needs a DIFFERENT credential set: the
      # Neon API key plus the R2 state pair, and neither a Hetzner nor a
      # Cloudflare token. Loading credentials a root cannot use is not
      # harmless; it widens what a mistake in that root can reach.
      NEON_API_KEY="$(op read "op://${PULLFM_OP_VAULT}/${PULLFM_NEON_OP_ITEM}/password")" ||
        _pullfm_die "1Password: could not read the Neon API key" || return 1
      [[ -n "${NEON_API_KEY}" ]] ||
        _pullfm_die "1Password: the Neon API key is empty" || return 1

      AWS_ACCESS_KEY_ID="$(_pullfm_op_field 'pull-fm/infra/R2_TFSTATE' 'access key id')" || return 1
      AWS_SECRET_ACCESS_KEY="$(_pullfm_op_field 'pull-fm/infra/R2_TFSTATE' 'secret access key')" || return 1

      export NEON_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
      pullfm_assert_neon_scope || return 1
      return 0
      ;;
    *)
      _pullfm_die "unknown environment '${env}' (expected staging, prod, shared or neon)"
      return 1
      ;;
  esac

  HCLOUD_TOKEN="$(_pullfm_op_field 'Hetzner pull.fm API Token' 'password')" || return 1
  CLOUDFLARE_API_TOKEN="$(_pullfm_op_field "pull-fm/${env}/CLOUDFLARE_API_TOKEN" 'credential')" || return 1

  # Terraform's R2 state backend speaks S3, not the Cloudflare API, so it takes
  # a separate R2 access key pair. Kept distinct from the environment token on
  # purpose: state must stay readable even if an environment credential is
  # revoked during an incident.
  AWS_ACCESS_KEY_ID="$(_pullfm_op_field 'pull-fm/infra/R2_TFSTATE' 'access key id')" || return 1
  AWS_SECRET_ACCESS_KEY="$(_pullfm_op_field 'pull-fm/infra/R2_TFSTATE' 'secret access key')" || return 1

  export HCLOUD_TOKEN CLOUDFLARE_API_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
}

# Read-only credential for the cost report. Notifications Read + Billing Read +
# Workers R2 Storage Read, and nothing else, so `make cost` can verify that the
# billing alerts are armed without holding a credential that could disarm them.
pullfm_load_cost_credentials() {
  command -v op >/dev/null || _pullfm_die "1Password CLI (op) not found" || return 1
  pullfm_reject_global_key || return 1

  HCLOUD_TOKEN="$(_pullfm_op_field 'Hetzner pull.fm API Token' 'password')" || return 1
  CLOUDFLARE_COST_TOKEN="$(_pullfm_op_field 'pull-fm/infra/CLOUDFLARE_COST_READ' 'credential')" || return 1
  export HCLOUD_TOKEN CLOUDFLARE_COST_TOKEN
}
