# shellcheck shell=bash
#
# Pull.fm - shared plumbing for the backup and restore tools.
#
# SOURCE this file. It defines functions and constants and exports nothing by
# itself, so sourcing it has no side effect until a function is called.
#
#   source "${ROOT}/infra/lib/backup-common.sh"
#   pullfm_backup_load_r2
#   pullfm_backup_load_neon
#
# ---------------------------------------------------------------------------
# Why this is a separate file from infra/lib/credentials.sh
# ---------------------------------------------------------------------------
#
# credentials.sh loads what a TERRAFORM ROOT needs: a Hetzner token, a
# per-environment Cloudflare token, the Neon API key, the R2 state pair. The
# backup tools need a different and deliberately narrower set:
#
#   * the R2 pair for the BACKUP bucket, which is not the state pair
#   * the Neon API key, for branch operations
#   * a Postgres DSN
#   * the dump cipher material
#
# and specifically NOT a Cloudflare API token or a Hetzner token. A restore is
# the operation most likely to be run at 3am by somebody who is already having a
# bad day, and it should not be the operation that also holds a credential that
# can delete DNS.
#
# ---------------------------------------------------------------------------
# THE R2 ENDPOINT TRAP, FOUND BY RUNNING IT
# ---------------------------------------------------------------------------
#
# `pull-fm-backups-staging` is an EU-JURISDICTION bucket. Jurisdiction-scoped
# buckets do not live on the account's default S3 host, they live on a
# jurisdiction host, and the default host answers for them with NoSuchBucket:
#
#   https://<acct>.r2.cloudflarestorage.com      ->  NoSuchBucket
#   https://<acct>.eu.r2.cloudflarestorage.com   ->  200
#
# The `s3 endpoint` field on the 1Password item `pull-fm/staging/R2_CREDENTIALS`
# records the DEFAULT host, so it is wrong, and it is wrong in the way that
# costs the most: the credential is valid, the bucket exists, and the error says
# the bucket does not exist. `pullfm_backup_r2_endpoint` therefore probes rather
# than trusts, and says so out loud when it has to correct the recorded value.
# The Terraform module already derives this correctly
# (`infra/terraform/modules/backup-storage/outputs.tf`); only the hand-written
# 1Password field disagrees.

readonly PULLFM_BACKUP_OP_VAULT="${PULLFM_BACKUP_OP_VAULT:-MCP}"

# 1Password items, addressed BY ITEM ID. Item ids are opaque locators, not
# secrets: they are useless without vault access, and they are stable across
# renames in a way titles are not. infra/lib/credentials.sh commits the Neon one
# already for the same reason.
readonly PULLFM_BACKUP_OP_R2="${PULLFM_BACKUP_OP_R2:-2ujy54s7j45zzme66ebu3sxfgi}"      # pull-fm/staging/R2_CREDENTIALS
readonly PULLFM_BACKUP_OP_NEON="${PULLFM_BACKUP_OP_NEON:-5ccxlg635x37rybelz53yeaqf4}"   # Neon API key
readonly PULLFM_BACKUP_OP_DSN="${PULLFM_BACKUP_OP_DSN:-63fl4tdvyw3euzs4a2b2b7bvvu}"     # DATABASE_URL_DIRECT (staging owner)
readonly PULLFM_BACKUP_OP_CIPHER="${PULLFM_BACKUP_OP_CIPHER:-4batahf3ih4fmyd7jhksgg6czu}"      # pull-fm/infra/BACKUP_DUMP_KEY

readonly PULLFM_BACKUP_BUCKET="${PULLFM_BACKUP_BUCKET:-pull-fm-backups-staging}"
readonly PULLFM_NEON_PROJECT_ID="${PULLFM_NEON_PROJECT_ID:-steep-frost-83698289}"
readonly PULLFM_NEON_API="${PULLFM_NEON_API:-https://console.neon.tech/api/v2}"

# Key prefixes. These are the retention classes; see `retention-apply` in
# infra/backup/pullfm-backup.sh and docs/RUNBOOK-DR.md section 6.
readonly PULLFM_BACKUP_PREFIX_SCHEDULED="dumps/scheduled"
readonly PULLFM_BACKUP_PREFIX_PREFLIGHT="dumps/preflight"
readonly PULLFM_BACKUP_PREFIX_HOLD="dumps/hold"
readonly PULLFM_BACKUP_PREFIX_LEDGER="ledger/deletions"
readonly PULLFM_BACKUP_PREFIX_DRILL="drills"

# --- output ------------------------------------------------------------------
#
# Everything diagnostic goes to stderr so that a subcommand's stdout stays a
# machine-readable value a caller can capture. `restore-drill.sh` depends on
# this: it captures object keys and branch ids out of these tools.

pullfm_die() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}
pullfm_warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
pullfm_info() { printf '%s\n' "$*" >&2; }
pullfm_ok() { printf '\033[32m%s\033[0m\n' "$*" >&2; }

pullfm_need() {
  local c
  for c in "$@"; do
    command -v "${c}" >/dev/null || pullfm_die "required command not found: ${c}"
  done
}

# --- timing ------------------------------------------------------------------
#
# RTO is a number or it is a wish. Every phase of the drill is bracketed by
# these, and the numbers in docs/RUNBOOK-DR.md come out of them rather than out
# of anybody's judgement about how long a thing "should" take.

# Milliseconds since the epoch, portable across macOS (BSD date has no %N) and
# Linux. python3 is already a hard dependency of infra/lib/tfstate-snapshot.sh.
pullfm_now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

pullfm_ms_human() {
  python3 - "$1" <<'PY'
import sys
ms = int(sys.argv[1])
s, ms = divmod(ms, 1000)
m, s = divmod(s, 60)
print(f"{m}m{s:02d}.{ms:03d}s" if m else f"{s}.{ms:03d}s")
PY
}

# --- 1Password ---------------------------------------------------------------
#
# `op read` on a MISSING FIELD returns an empty string at exit 0. Every read
# here therefore checks for emptiness explicitly; trusting the exit code is how
# a backup job runs happily for a month with no cipher key.

pullfm_op_field() {
  local item="$1" field="$2" value
  value="$(op item get "${item}" --vault "${PULLFM_BACKUP_OP_VAULT}" \
    --fields "label=${field}" --reveal 2>/dev/null)" ||
    pullfm_die "1Password: could not read '${field}' from '${item}'"
  [[ -n "${value}" ]] ||
    pullfm_die "1Password: field '${field}' on '${item}' is EMPTY.

op exits 0 for a field that does not exist, so an empty value here means the
field is missing or misnamed, not that the item is unreadable."
  printf '%s' "${value}"
}

# --- R2 ----------------------------------------------------------------------

# TWO CREDENTIAL SOURCES, ON PURPOSE.
#
# On a laptop, 1Password is the source and nothing touches the disk. On the
# application node there is no `op` and there never will be: the node holds a
# rendered 0600 env file written by infra/lib/secrets.sh, exactly like
# /etc/pullfm/bff.env. So every loader here takes the value from the
# environment when it is already there, and only reaches for 1Password when it
# is not. A scheduled backup that requires an interactive vault unlock is a
# scheduled backup that does not run.
pullfm_backup_load_r2() {
  pullfm_need aws
  if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    pullfm_info "R2 credentials: from the environment"
  else
    pullfm_need op
    AWS_ACCESS_KEY_ID="$(pullfm_op_field "${PULLFM_BACKUP_OP_R2}" 'access key id')"
    AWS_SECRET_ACCESS_KEY="$(pullfm_op_field "${PULLFM_BACKUP_OP_R2}" 'secret access key')"
  fi
  AWS_DEFAULT_REGION="auto"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION

  # Do not let an ambient session token from another profile leak in; R2 does
  # not use them and a stale one produces an unhelpful signature error.
  unset AWS_SESSION_TOKEN AWS_PROFILE || true

  PULLFM_R2_ENDPOINT="$(pullfm_backup_r2_endpoint)"
  export PULLFM_R2_ENDPOINT
}

# Probe rather than trust. See the header.
pullfm_backup_r2_endpoint() {
  if [[ -n "${PULLFM_BACKUP_ENDPOINT:-}" ]]; then
    printf '%s' "${PULLFM_BACKUP_ENDPOINT}"
    return 0
  fi

  local recorded host candidates ep
  if command -v op >/dev/null; then
    recorded="$(pullfm_op_field "${PULLFM_BACKUP_OP_R2}" 's3 endpoint')"
  else
    pullfm_die "PULLFM_BACKUP_ENDPOINT is not set and 1Password is not available.

On a node, set it in the environment file. It is the JURISDICTION-scoped host:
  https://<account-id>.eu.r2.cloudflarestorage.com
The account default host answers NoSuchBucket for this bucket."
  fi
  # Account host, e.g. https://<acct>.r2.cloudflarestorage.com
  host="${recorded#https://}"
  host="${host%%.*}"

  candidates="${recorded}
https://${host}.eu.r2.cloudflarestorage.com
https://${host}.r2.cloudflarestorage.com"

  while read -r ep; do
    [[ -n "${ep}" ]] || continue
    if aws s3api head-bucket --bucket "${PULLFM_BACKUP_BUCKET}" \
      --endpoint-url "${ep}" >/dev/null 2>&1; then
      if [[ "${ep}" != "${recorded}" ]]; then
        pullfm_warn "R2 endpoint correction: the 's3 endpoint' field on the 1Password
item ${PULLFM_BACKUP_OP_R2} records
  ${recorded}
which answers NoSuchBucket for '${PULLFM_BACKUP_BUCKET}'. The bucket is
jurisdiction-scoped and actually lives on
  ${ep}
Using the working host. FIX THE 1PASSWORD FIELD: a restore that begins by
being told the backup bucket does not exist is the worst possible false alarm."
      fi
      printf '%s' "${ep}"
      return 0
    fi
  done <<<"${candidates}"

  pullfm_die "cannot reach bucket '${PULLFM_BACKUP_BUCKET}' on any known R2 host.
Tried:
${candidates}
Check the credential on 1Password item ${PULLFM_BACKUP_OP_R2}."
}

pullfm_s3() { aws s3api "$@" --endpoint-url "${PULLFM_R2_ENDPOINT}"; }

# --- Neon --------------------------------------------------------------------

pullfm_backup_load_neon() {
  pullfm_need curl python3
  if [[ -z "${NEON_API_KEY:-}" ]]; then
    pullfm_need op
    NEON_API_KEY="$(op read "op://${PULLFM_BACKUP_OP_VAULT}/${PULLFM_BACKUP_OP_NEON}/password" 2>/dev/null)" ||
      pullfm_die "1Password: could not read the Neon API key"
    [[ -n "${NEON_API_KEY}" ]] || pullfm_die "1Password: the Neon API key is EMPTY"
  fi
  export NEON_API_KEY
}

# pullfm_neon <METHOD> <path-under-project> [json-body]
#
# Fails on a non-2xx rather than returning an error document, because every
# caller here would otherwise have to re-check, and one that forgot would treat
# "branch not created" as "branch created".
pullfm_neon() {
  local method="$1" path="$2" body="${3:-}" url out code
  url="${PULLFM_NEON_API}/projects/${PULLFM_NEON_PROJECT_ID}${path}"

  local -a args=(-sS -X "${method}" -H "Authorization: Bearer ${NEON_API_KEY}"
    -H 'Accept: application/json' -w '\n%{http_code}')
  if [[ -n "${body}" ]]; then
    args+=(-H 'Content-Type: application/json' --data "${body}")
  fi

  out="$(curl "${args[@]}" "${url}")" || pullfm_die "Neon API unreachable: ${method} ${path}"
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"

  if [[ "${code}" != 2* ]]; then
    pullfm_die "Neon API ${method} ${path} -> HTTP ${code}
${out}"
  fi
  printf '%s' "${out}"
}

# The same call, but it RETURNS a failure instead of exiting the process.
#
# pullfm_neon calls pullfm_die, and `exit` inside an `if` condition still exits
# the shell. A cleanup loop written as `if pullfm_neon DELETE ...; then` therefore
# terminated the whole drill on the first branch that could not be deleted yet,
# which is precisely the case the loop existed to retry. Prints the API's message
# on stderr so a caller can decide whether it is the expected kind of failure.
pullfm_neon_soft() {
  local method="$1" path="$2" body="${3:-}" url out code
  url="${PULLFM_NEON_API}/projects/${PULLFM_NEON_PROJECT_ID}${path}"
  local -a args=(-sS -X "${method}" -H "Authorization: Bearer ${NEON_API_KEY}"
    -H 'Accept: application/json' -w '\n%{http_code}')
  [[ -z "${body}" ]] || args+=(-H 'Content-Type: application/json' --data "${body}")

  out="$(curl "${args[@]}" "${url}" 2>/dev/null)" || return 1
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [[ "${code}" != 2* ]]; then
    printf '%s\n' "${out}" >&2
    return 1
  fi
  printf '%s' "${out}"
}

# Neon's control plane is eventually consistent about branch state. A branch
# reports `init` for a moment after creation and after a restore, and a psql
# connection during that window fails in a way that looks like a credential
# problem. Wait for `ready` and time how long it took, because that wait IS part
# of the RTO and pretending otherwise is how a 90-second restore gets reported
# as a 4-second one.
pullfm_neon_wait_ready() {
  local branch="$1" timeout="${2:-180}" started state elapsed
  started="$(pullfm_now_ms)"
  while :; do
    state="$(pullfm_neon GET "/branches/${branch}" |
      python3 -c 'import json,sys; print(json.load(sys.stdin)["branch"]["current_state"])')"
    [[ "${state}" == "ready" ]] && break
    elapsed=$((($(pullfm_now_ms) - started) / 1000))
    ((elapsed < timeout)) || pullfm_die "branch ${branch} still '${state}' after ${timeout}s"
    sleep 2
  done
  printf '%s' "$(($(pullfm_now_ms) - started))"
}

# --- Postgres ----------------------------------------------------------------

pullfm_backup_load_dsn() {
  if [[ -n "${PULLFM_BACKUP_DSN:-}" ]]; then
    printf '%s' "${PULLFM_BACKUP_DSN}"
    return 0
  fi
  command -v op >/dev/null ||
    pullfm_die "PULLFM_BACKUP_DSN is not set and 1Password is not available.

Use the DIRECT endpoint, not the pooler: pg_dump opens more than one connection
and PgBouncer in transaction mode does not survive that."
  pullfm_op_field "${PULLFM_BACKUP_OP_DSN}" 'credential'
}

# Redact the credential out of a DSN before it is printed or logged. This runs
# on every path that shows a DSN, because a restore transcript is exactly the
# kind of thing that gets pasted into an incident channel.
pullfm_dsn_redact() {
  printf '%s' "$1" | sed -E 's#://[^@/]*@#://REDACTED@#'
}

# The database's own clock, not the laptop's. Every restore target in this
# system is a server-side timestamp, and a two-second local clock skew is the
# difference between restoring to before and after the write you care about.
# Emitted as RFC 3339 with milliseconds, because that is what the Neon API
# accepts as a restore target and because Postgres's default `now()` rendering
# ("2026-07-29 08:28:54.68+00", with a SPACE) is not. Milliseconds are kept
# deliberately: truncating to the second moves the target BACKWARDS by up to a
# second, which silently excludes transactions that had already committed.
pullfm_pg_now() {
  psql "$1" -X -A -t -v ON_ERROR_STOP=1 \
    -c "select to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')" |
    tr -d '\n\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# Swap the database name in a DSN without touching anything else. A restore
# target is a DIFFERENT DATABASE on the same endpoint, and hand-editing a URL
# that contains a password is how a password ends up in a shell history.
pullfm_dsn_with_db() {
  python3 -c '
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
print(u.urlunparse(p._replace(path="/" + sys.argv[2])))
' "$1" "$2"
}

pullfm_sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
