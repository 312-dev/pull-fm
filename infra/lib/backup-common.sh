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
# A jurisdiction-scoped R2 bucket does not live on the account's default S3
# host. It lives on a jurisdiction host, and the default host answers for it
# with NoSuchBucket:
#
#   https://<acct>.r2.cloudflarestorage.com          the default host
#   https://<acct>.<jurisdiction>.r2.cloudflarestorage.com
#
# That is the worst shape an error can take: the credential is valid, the bucket
# exists, and the message says the bucket does not exist.
#
# NOTHING HERE NAMES A JURISDICTION, AND THAT IS DELIBERATE RATHER THAN TIDY.
# Jurisdiction is fixed at bucket creation and cannot be changed, so moving
# residency means NEW BUCKETS ON A DIFFERENT HOST, and any tool that had learned
# the old host breaks on the day of the move. `pullfm_backup_r2_endpoint`
# therefore PROBES: it treats every recorded value - the `s3 endpoint` field in
# 1Password, or the endpoint rendered into a node's environment file - as a
# CANDIDATE to be checked rather than a fact to be trusted, and falls back to
# deriving the alternatives from the account id. A stale recorded value costs a
# warning and one extra HEAD, not an outage.
#
# It also never assumes two buckets share a host. The backups bucket and the
# ledger bucket are separate buckets with separate credentials, and each loader
# probes the bucket it is about to use with the credential it just loaded.
# `infra/terraform/modules/backup-storage/outputs.tf` derives the endpoint from
# the jurisdiction variable and is the authority on what a bucket's host should
# be; this file's job is to still work when a recorded copy of that has drifted.

readonly PULLFM_BACKUP_OP_VAULT="${PULLFM_BACKUP_OP_VAULT:-MCP}"

# ---------------------------------------------------------------------------
# 1PASSWORD ITEMS ARE ADDRESSED BY TITLE HERE, AND THEY USED TO BE ADDRESSED BY
# ITEM ID.
# ---------------------------------------------------------------------------
#
# WHAT WAS WRONG. This file carried four base32 item ids with the reasoning that
# "an item id is an opaque locator, not a secret". `tools/check-public-
# identifiers.mjs` disagrees, and it is the one that gets to decide: an item id
# is a DIRECT OBJECT REFERENCE, so it turns any vault access from a search
# problem into a fetch. Two of these lines were live findings in that check on
# the day the US cutover started, and infra/lib/secrets.sh had already reached
# the opposite conclusion and written it down ("the title is what belongs in a
# PUBLIC repository").
#
# WHY THIS SHAPE. `op item get` takes a title or an id interchangeably, and the
# titles here are unambiguous, so nothing is lost by using the readable half.
#
# THE `_US` SUFFIX IS GONE, AND ITS REMOVAL IS WHY THESE TITLES ARE SAFE AGAIN.
# During the residency cutover these read `..._US`, because the plain-titled EU
# originals were still live and a rename would have been ambiguous. The EU estate
# was deleted on 2026-07-29 and those items are ARCHIVED as the audit trail, so
# the plain titles now name the US credentials and nothing else. An archived item
# is not returned by `op item get` without `--include-archive`, and the API
# refuses it outright with "item is not in an active state", so the retired EU
# names cannot be reached by accident from here.
#
# The suffix was retired on 2026-07-30 in one change with every consumer, because
# renaming the items alone would have broken the backup path and the restore
# drill, and editing the consumers alone would have pointed them at titles that
# did not exist yet.
readonly PULLFM_BACKUP_OP_R2="${PULLFM_BACKUP_OP_R2:-pull-fm/staging/R2_CREDENTIALS}"
readonly PULLFM_LEDGER_OP_R2="${PULLFM_LEDGER_OP_R2:-pull-fm/staging/R2_LEDGER_CREDENTIALS}"

# The Neon API key. ALSO A TITLE, AND IT USED TO BE THE ONE EXCEPTION HERE.
#
# This line was an item id, justified in the block above by saying the title
# contains parentheses which are not legal in an op:// reference. That was true
# of the REFERENCE SYNTAX only; `op item get` has no such restriction, so the
# exception was an artifact of `pullfm_backup_load_neon` using `op read`. It uses
# `pullfm_op_field` now and the id is gone. See infra/lib/credentials.sh, which
# carried the same id for the same reason and records the measurement.
readonly PULLFM_BACKUP_OP_NEON="${PULLFM_BACKUP_OP_NEON:-Neon API Key (pull.fm)}"
readonly PULLFM_BACKUP_OP_DSN="${PULLFM_BACKUP_OP_DSN:-pull-fm/staging/DATABASE_URL_DIRECT}"
readonly PULLFM_BACKUP_OP_CIPHER="${PULLFM_BACKUP_OP_CIPHER:-pull-fm/infra/BACKUP_DUMP_KEY}"

# ---------------------------------------------------------------------------
# THE US BUCKETS AND THE US PROJECT. THE EU ESTATE IS DELETED AND THERE IS NO
# LONGER A ROLLBACK BEHIND THESE VALUES.
# ---------------------------------------------------------------------------
#
# Residency moved from the EU to the US. Neither an R2 jurisdiction nor a Neon
# region can be changed in place, so the move was expressed the only way the
# platforms allow: NEW BUCKETS AND A NEW PROJECT.
#
# THIS BLOCK USED TO SAY THE EU ORIGINALS WERE "LEFT ALIVE AND UNTOUCHED" AND
# THAT A ROLLBACK WAS AN EDIT TO THESE FOUR VALUES. That stopped being true on
# 2026-07-29, when the EU project and all three EU buckets were deleted. Pointing
# any of these constants back at an EU name now names nothing, and the failure
# arrives as `NoSuchBucket` or a dead Neon project rather than as a rollback. The
# recovery path from here is a restore out of the US backups, not a repoint; see
# docs/RUNBOOK-DR.md.
#
# The US buckets are DEFAULT jurisdiction with an ENAM location hint, not
# `us`-jurisdiction, because R2 has no US jurisdiction to pin to. That is why
# they answer on the account's default S3 host, which the EU ones did not; see
# `pullfm_backup_r2_endpoint` below, which probes rather than trusting a recorded
# host at all.
readonly PULLFM_BACKUP_BUCKET="${PULLFM_BACKUP_BUCKET:-pull-fm-backups-staging-us}"

# THE LEDGER IS A SEPARATE BUCKET, AND THAT IS A SECURITY BOUNDARY RATHER THAN
# TIDINESS.
#
# R2 API tokens scope to a BUCKET and never to a prefix. The erasure ledger is
# written by the BFF, which is internet-facing, so a token that let it write
# `ledger/deletions/` inside `pull-fm-backups-staging-us` would also have let a
# compromised BFF delete every database backup. Splitting the bucket is the only
# way to give the application a credential that cannot reach the backups.
#
# Note also that there is no write-only R2 permission group: "Workers R2 Storage
# Bucket Item Write" grants read and delete as well, proved on 2026-07-29 by
# succeeding at both under a token holding only that group. What actually makes
# the ledger append-only is the bucket lock rule `erasure-ledger-immutable`, and
# lock rules are per-bucket too. See PULLFM-RISK-009 and PULLFM-RISK-011.
readonly PULLFM_LEDGER_BUCKET="${PULLFM_LEDGER_BUCKET:-pull-fm-ledger-staging-us}"

# The US Neon project (aws-us-east-1, Postgres 18). A Neon region is immutable,
# so there was never an in-place move to make.
#
# THE EU PROJECT IT REPLACES IS DELETED. This comment used to say it was "still
# live, still serving, and NOT to be deleted", and that it was the rollback for
# the database half of the cutover. It was deleted on 2026-07-29 once the US side
# was verified.
#
# `infra/neon` now adopts THIS project; the two agreed from the moment that root
# was repointed, so the note that used to say they disagree on purpose is gone
# rather than left to be read as current.
#
# Verified 2026-07-30 rather than assumed: `pull-fm/staging/DATABASE_URL` and
# `..._DIRECT` both resolve to endpoints on `us-east-1.aws.neon.tech`, and a
# `pullfm_neon GET /` against this id returns region_id `aws-us-east-1`.
readonly PULLFM_NEON_PROJECT_ID="${PULLFM_NEON_PROJECT_ID:-cold-brook-02833828}"
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

  # PULLFM_BACKUP_ENDPOINT is passed as a CANDIDATE, not as an answer. On a node
  # it is the only source available, because there is no `op` there to read the
  # recorded value from - but "the only source" and "correct" are different
  # claims, and the second one is the bucket's to make.
  PULLFM_R2_ENDPOINT="$(pullfm_backup_r2_endpoint "${PULLFM_BACKUP_BUCKET}" \
    "${PULLFM_BACKUP_OP_R2}" "${PULLFM_BACKUP_ENDPOINT:-}")"
  export PULLFM_R2_ENDPOINT
}

# The ledger bucket's own credential.
#
# A SEPARATE LOADER RATHER THAN A FLAG, because the two credentials are not
# interchangeable and the failure when they are confused is quiet: the backup
# token cannot see `pull-fm-ledger-staging-us` at all, so a ledger command run with
# it does not fail with "forbidden", it reports an EMPTY LEDGER. `replay-deletions`
# treats an empty ledger as "nothing to replay" and exits 0, which is precisely
# the shape of a check that reports success while checking nothing. Every ledger
# subcommand therefore loads this and never `pullfm_backup_load_r2`.
#
# THE TWO BUCKETS DO NOT SHARE AN ENDPOINT, EVEN WHEN THEY HAPPEN TO. This
# comment used to say "both buckets are EU-jurisdiction, so the endpoint is
# shared and only the key pair differs", and that was a true observation written
# as a rule. Jurisdiction is per bucket and immutable at creation, so the two can
# and will diverge - a residency move creates new buckets and there is no instant
# at which both are guaranteed to be on the same host. The ledger loader
# therefore seeds the probe from PULLFM_LEDGER_ENDPOINT, never from the backup
# bucket's endpoint, and probes the ledger bucket itself.
#
# PULLFM_LEDGER_ACCESS_KEY_ID is read first for the node case, where a rendered
# env file is the source and `op` is absent.
pullfm_backup_load_ledger_r2() {
  pullfm_need aws
  if [[ -n "${PULLFM_LEDGER_ACCESS_KEY_ID:-}" && -n "${PULLFM_LEDGER_SECRET_ACCESS_KEY:-}" ]]; then
    pullfm_info "ledger R2 credentials: from the environment"
    AWS_ACCESS_KEY_ID="${PULLFM_LEDGER_ACCESS_KEY_ID}"
    AWS_SECRET_ACCESS_KEY="${PULLFM_LEDGER_SECRET_ACCESS_KEY}"
  else
    pullfm_need op
    AWS_ACCESS_KEY_ID="$(pullfm_op_field "${PULLFM_LEDGER_OP_R2}" 'access key id')"
    AWS_SECRET_ACCESS_KEY="$(pullfm_op_field "${PULLFM_LEDGER_OP_R2}" 'secret access key')"
  fi
  AWS_DEFAULT_REGION="auto"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  unset AWS_SESSION_TOKEN AWS_PROFILE || true

  # Probe the LEDGER bucket, not the backup one. The credential just loaded
  # cannot see the backup bucket, so probing it would fail on every host and
  # blame the ledger credential for a bucket the caller never asked about.
  PULLFM_R2_ENDPOINT="$(pullfm_backup_r2_endpoint "${PULLFM_LEDGER_BUCKET}" \
    "${PULLFM_LEDGER_OP_R2}" "${PULLFM_LEDGER_ENDPOINT:-}")"
  export PULLFM_R2_ENDPOINT
}

# Probe rather than trust. See the header.
#
# PARAMETERISED BY BUCKET AND ITEM, because the probe is a HEAD against a real
# bucket with the credential currently loaded. It used to hard-code the backup
# bucket, which was correct while there was only one; with a separate ledger
# bucket and a separate bucket-scoped credential it became actively wrong. The
# ledger credential cannot see the backup bucket at all, so probing the backup
# bucket with it fails on every candidate host and reports "cannot reach bucket"
# for a bucket the caller never asked about. The bucket being probed must be the
# bucket about to be used.
#
#   $1  bucket to probe   (default: the backup bucket)
#   $2  1Password item id holding the recorded 's3 endpoint' (default: backups)
#   $3  an endpoint the caller already has, from a rendered environment file.
#       A CANDIDATE, NOT AN ANSWER: it used to be an early return, which meant a
#       node kept using a host recorded before the bucket moved and reported
#       NoSuchBucket for a bucket that exists. It is now the first thing probed,
#       so the usual case still costs exactly one HEAD.
pullfm_backup_r2_endpoint() {
  local bucket="${1:-${PULLFM_BACKUP_BUCKET}}"
  local op_item="${2:-${PULLFM_BACKUP_OP_R2}}"
  local recorded="${3:-}"

  local host candidates ep source
  if [[ -n "${recorded}" ]]; then
    source="the environment"
  elif command -v op >/dev/null; then
    recorded="$(pullfm_op_field "${op_item}" 's3 endpoint')"
    source="1Password item ${op_item}"
  else
    pullfm_die "no endpoint was passed and 1Password is not available, so there
is nothing to probe for bucket '${bucket}'.

On a node, render it into the environment file. It is whichever host the bucket
was CREATED on: the account default host, or a jurisdiction host if the bucket
is jurisdiction-scoped. The other one answers NoSuchBucket."
  fi

  # The account id: the first label of the host, identical in both forms.
  host="${recorded#https://}"
  host="${host%%.*}"

  # The recorded value first, then the two forms derived from the account id.
  # Default before jurisdiction only because a bucket with no jurisdiction is
  # the common case; both are tried, and a duplicate costs one wasted HEAD.
  # No jurisdiction is hard-coded as THE answer anywhere: this list is a set of
  # guesses and the bucket decides which one is right.
  #
  # THE `.eu.` CANDIDATE STAYS, AND ITS JUSTIFICATION HAS CHANGED. It used to be
  # kept "for the moment anyone exercises the rollback by overriding
  # PULLFM_BACKUP_BUCKET back to an EU bucket". There are no EU buckets any more,
  # so that reason is dead and saying it would be a false claim about why a line
  # exists.
  #
  # What it is now: this function's contract is that a RECORDED HOST IS A GUESS,
  # and the guess it most often gets wrong is a jurisdiction-scoped bucket
  # answering NoSuchBucket on the default host. `.eu.` is the only jurisdiction
  # host this account has ever used, so it is the one worth spending a HEAD on if
  # a jurisdiction-pinned bucket is ever created again. The US buckets are
  # default-jurisdiction and answer on the first derived host, so on every path
  # that runs today this candidate is never reached.
  candidates="${recorded}
https://${host}.r2.cloudflarestorage.com
https://${host}.eu.r2.cloudflarestorage.com"

  while read -r ep; do
    [[ -n "${ep}" ]] || continue
    if aws s3api head-bucket --bucket "${bucket}" \
      --endpoint-url "${ep}" >/dev/null 2>&1; then
      if [[ "${ep}" != "${recorded}" ]]; then
        pullfm_warn "R2 endpoint correction: ${source} records
  ${recorded}
which answers NoSuchBucket for '${bucket}'. It actually lives on
  ${ep}
Using the working host. FIX THE RECORDED VALUE - the 's3 endpoint' field on
1Password item ${op_item}, and the endpoint rendered into any node environment
file by infra/lib/secrets.sh. A restore that begins by being told the backup
bucket does not exist is the worst possible false alarm, and this correction is
the only thing currently standing between a stale record and that alarm."
      fi
      printf '%s' "${ep}"
      return 0
    fi
  done <<<"${candidates}"

  pullfm_die "cannot reach bucket '${bucket}' on any known R2 host.
Tried:
${candidates}
Check the credential on 1Password item ${op_item}."
}

pullfm_s3() { aws s3api "$@" --endpoint-url "${PULLFM_R2_ENDPOINT}"; }

# --- Neon --------------------------------------------------------------------

pullfm_backup_load_neon() {
  pullfm_need curl python3
  if [[ -z "${NEON_API_KEY:-}" ]]; then
    pullfm_need op
    # `pullfm_op_field`, not `op read`: PULLFM_BACKUP_OP_NEON is a TITLE now and
    # the parenthesis in it is illegal in an op:// reference. The helper also
    # rejects an empty field, which `op` returns at exit 0 when a label is wrong.
    NEON_API_KEY="$(pullfm_op_field "${PULLFM_BACKUP_OP_NEON}" 'password')"
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
