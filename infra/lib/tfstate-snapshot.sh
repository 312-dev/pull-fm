#!/usr/bin/env bash
#
# Pull.fm - pre-apply Terraform state snapshots for Cloudflare R2.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS: R2 CANNOT DO OBJECT VERSIONING
# ---------------------------------------------------------------------------
#
# Several documents in this repository used to say that object versioning was
# enabled on `pull-fm-tfstate` and that a bad apply could be rolled back by
# restoring the previous version of the state object. That recovery path was
# never available and cannot be made available. Cloudflare's S3 compatibility
# matrix lists both `PutBucketVersioning` and `GetBucketVersioning` as
# UNIMPLEMENTED, and `ListObjectVersions` does not appear in it at all.
#
# The reason this went unnoticed is worth keeping, because it is the trap:
#
#   aws s3api get-bucket-versioning --bucket pull-fm-tfstate   ->  exit 0, empty
#   aws s3api get-bucket-policy     --bucket pull-fm-tfstate   ->  NotImplemented
#
# R2 answers the versioning query with an empty configuration instead of an
# error. In S3 an empty versioning configuration means "versioning has never
# been enabled on this bucket", which reads as a setting nobody switched on
# rather than a capability that does not exist. One API says no by erroring and
# the other says no by shrugging, and only one of those is noticeable.
#
# So versioning is not a control to be turned on. It is a control to be
# replaced, which is what this script is.
#
# ---------------------------------------------------------------------------
# WHAT IT DOES AND WHAT IT DELIBERATELY DOES NOT COVER
# ---------------------------------------------------------------------------
#
# Before an apply, copy the live state object to a timestamped key, then read
# that copy back and compare digests. If the readback does not match, this exits
# non-zero and the apply never runs.
#
# The verification is the point and it is deliberately BEFORE the apply rather
# than after it. A snapshot that was never proved readable is not a snapshot,
# and finding that out while trying to recover from a bad apply is the worst
# possible moment. This is the same lesson as Gate 4: an untested restore is not
# a restore.
#
# THIS PROTECTS AGAINST: a bad apply. A truncated or corrupted state write, an
# import that adopted the wrong resources, a `state rm` that removed too much, a
# provider bug that mangled state. That is the failure this repository actually
# documents a rollback for, and it is now genuinely covered.
#
# THIS DOES NOT PROTECT AGAINST: loss of the bucket, loss of the Cloudflare
# account, or an attacker holding the R2 credential. Snapshots live in the same
# bucket, under the same credential, as the thing they are backing up. That is a
# real limitation rather than an oversight, and it matters more here than it
# usually would because `PULLFM-RISK-001` records that this Cloudflare account
# is shared with an unrelated personal fleet and could be suspended as a unit.
# Use `--local` before an import-heavy or destructive apply to also write a copy
# outside the blast radius, and read the warning it prints.
#
# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
#
#   infra/lib/tfstate-snapshot.sh snapshot infra/neon
#   infra/lib/tfstate-snapshot.sh snapshot infra/neon --local ~/tfstate-backups
#   infra/lib/tfstate-snapshot.sh list     infra/neon
#   infra/lib/tfstate-snapshot.sh restore  infra/neon <snapshot-key>
#
# Credentials come from the environment, exactly as `terraform init` takes them:
#
#   source infra/lib/credentials.sh && pullfm_load_credentials neon
#
# Nothing about the bucket is hardcoded. The bucket, key and account-specific
# endpoint are read from the root's own `backend.hcl`, which is gitignored,
# because this repository is public.
#
# ---------------------------------------------------------------------------
# RETENTION
# ---------------------------------------------------------------------------
#
# Keeps the newest PULLFM_TFSTATE_SNAPSHOT_KEEP snapshots per root (default 20)
# and deletes the rest after a successful snapshot.
#
# Count-based rather than age-based on purpose. An age rule ("delete older than
# 90 days") assumes applies happen regularly; this project can go months without
# one, and an age rule would quietly delete every snapshot it had, leaving the
# next apply with no history at exactly the moment the configuration has drifted
# furthest from what anyone remembers. A count rule degrades to "keep the last
# 20 applies, however long that took", which is the property actually wanted.
#
# Each state object is a few kilobytes, so 20 of them is not a storage decision.

set -euo pipefail

readonly SNAPSHOT_PREFIX="snapshots"
KEEP="${PULLFM_TFSTATE_SNAPSHOT_KEEP:-20}"

_die() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

_warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
_info() { printf '%s\n' "$*" >&2; }

# --- backend discovery -------------------------------------------------------
#
# Parses the root's backend.hcl rather than taking the bucket and endpoint as
# arguments, so this script and `terraform init` can never disagree about which
# bucket they are talking to.
_load_backend() {
  local root="${1:?usage: _load_backend <terraform-root-dir>}"
  local hcl="${root%/}/backend.hcl"

  [[ -d "${root}" ]] || _die "not a directory: ${root}"
  [[ -f "${hcl}" ]] || _die "no backend.hcl in ${root}.

It is gitignored, so a fresh checkout has to create it:
  cp ${root%/}/backend.hcl.example ${hcl}
and fill in the Cloudflare account id."

  BUCKET="$(sed -n 's/^[[:space:]]*bucket[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${hcl}" | head -1)"
  KEY="$(sed -n 's/^[[:space:]]*key[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${hcl}" | head -1)"
  ENDPOINT="$(sed -n 's/.*s3[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${hcl}" | head -1)"

  [[ -n "${BUCKET}" ]] || _die "could not read 'bucket' from ${hcl}"
  [[ -n "${KEY}" ]] || _die "could not read 'key' from ${hcl}"
  [[ -n "${ENDPOINT}" ]] || _die "could not read the s3 endpoint from ${hcl}"

  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] ||
    _die "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set.

  source infra/lib/credentials.sh && pullfm_load_credentials neon"

  command -v aws >/dev/null || _die "the aws CLI is required"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
}

_s3() { aws s3api "$@" --endpoint-url "${ENDPOINT}"; }

_sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# --- snapshot ----------------------------------------------------------------

cmd_snapshot() {
  local root="${1:?usage: snapshot <terraform-root-dir> [--local <dir>]}"
  shift || true
  local local_dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --local) local_dir="${2:?--local needs a directory}"; shift 2 ;;
      *) _die "unknown option: $1" ;;
    esac
  done

  _load_backend "${root}"

  local tmp snap_key stamp sha_src sha_back rc
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  # A root whose first apply has not happened has no state to protect. Succeed
  # rather than fail, so a wrapper can call this unconditionally.
  set +e
  _s3 get-object --bucket "${BUCKET}" --key "${KEY}" "${tmp}/live.tfstate" >/dev/null 2>&1
  rc=$?
  set -e
  if [[ ${rc} -ne 0 ]]; then
    _info "no existing state at s3://${BUCKET}/${KEY} - nothing to snapshot (first apply)."
    return 0
  fi

  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "${tmp}/live.tfstate" 2>/dev/null ||
    _die "the LIVE state object is not valid JSON. Do not apply. Investigate first."

  stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
  local sha="unknown"
  if git rev-parse --short HEAD >/dev/null 2>&1; then sha="$(git rev-parse --short HEAD)"; fi
  snap_key="${SNAPSHOT_PREFIX}/${KEY}/${stamp}-${sha}.tfstate"

  _s3 put-object --bucket "${BUCKET}" --key "${snap_key}" \
    --body "${tmp}/live.tfstate" --content-type application/json >/dev/null ||
    _die "failed to write the snapshot. Do not apply."

  # THE READBACK. Without this the whole exercise is a hope.
  _s3 get-object --bucket "${BUCKET}" --key "${snap_key}" "${tmp}/readback.tfstate" >/dev/null ||
    _die "wrote the snapshot but could not read it back. Do not apply."

  sha_src="$(_sha256 "${tmp}/live.tfstate")"
  sha_back="$(_sha256 "${tmp}/readback.tfstate")"
  [[ "${sha_src}" == "${sha_back}" ]] ||
    _die "snapshot readback digest mismatch. Do not apply.
  live:     ${sha_src}
  readback: ${sha_back}"

  _info "snapshot verified: s3://${BUCKET}/${snap_key}"
  _info "  sha256 ${sha_src}"

  if [[ -n "${local_dir}" ]]; then
    mkdir -p "${local_dir}"
    local dest="${local_dir%/}/$(printf '%s' "${KEY}" | tr '/' '_').${stamp}.tfstate"
    cp "${tmp}/readback.tfstate" "${dest}"
    chmod 600 "${dest}"
    _warn "local copy: ${dest}
THIS FILE CONTAINS THE PRODUCTION DATABASE PASSWORD IN PLAINTEXT (PULLFM-RISK-008).
It is mode 0600. Delete it once the apply is confirmed good, and do not put it on
shared storage, a synced folder, or a backup that leaves this machine."
  fi

  cmd_prune_inner
}

# --- retention ---------------------------------------------------------------

cmd_prune_inner() {
  local keys count excess
  keys="$(_s3 list-objects-v2 --bucket "${BUCKET}" \
    --prefix "${SNAPSHOT_PREFIX}/${KEY}/" \
    --query 'sort_by(Contents,&Key)[].Key' --output text 2>/dev/null || true)"
  [[ -n "${keys}" && "${keys}" != "None" ]] || return 0

  # Keys are sorted lexicographically and the timestamp is ISO-8601 with a fixed
  # width, so lexicographic order IS chronological order here.
  count="$(printf '%s\n' ${keys} | wc -l | tr -d ' ')"
  excess=$((count - KEEP))
  [[ ${excess} -gt 0 ]] || return 0

  _info "retention: ${count} snapshots, keeping ${KEEP}, deleting ${excess}"
  # shellcheck disable=SC2086
  printf '%s\n' ${keys} | head -n "${excess}" | while read -r k; do
    [[ -n "${k}" && "${k}" != "${KEY}" ]] || continue
    _s3 delete-object --bucket "${BUCKET}" --key "${k}" >/dev/null && _info "  deleted ${k}"
  done
}

# --- list --------------------------------------------------------------------

cmd_list() {
  _load_backend "${1:?usage: list <terraform-root-dir>}"
  _info "snapshots of s3://${BUCKET}/${KEY}"
  _s3 list-objects-v2 --bucket "${BUCKET}" \
    --prefix "${SNAPSHOT_PREFIX}/${KEY}/" \
    --query 'sort_by(Contents,&Key)[].[LastModified,Size,Key]' --output text 2>/dev/null ||
    _info "  (none)"
}

# --- restore -----------------------------------------------------------------

cmd_restore() {
  local root="${1:?usage: restore <terraform-root-dir> <snapshot-key>}"
  local snap_key="${2:?usage: restore <terraform-root-dir> <snapshot-key>}"
  _load_backend "${root}"

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  _s3 get-object --bucket "${BUCKET}" --key "${snap_key}" "${tmp}/snap.tfstate" >/dev/null ||
    _die "cannot read snapshot ${snap_key}"

  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "${tmp}/snap.tfstate" 2>/dev/null ||
    _die "snapshot ${snap_key} is not valid JSON. Refusing to restore it over live state."

  # Lineage guard. Terraform assigns each state a UUID lineage and refuses to
  # operate across a mismatch. Catching it here, before the overwrite, turns a
  # confusing post-restore Terraform error into a refusal that still has the
  # original state intact.
  local live_lineage snap_lineage live_serial snap_serial
  snap_lineage="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("lineage",""))' "${tmp}/snap.tfstate")"
  snap_serial="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("serial",""))' "${tmp}/snap.tfstate")"

  if _s3 get-object --bucket "${BUCKET}" --key "${KEY}" "${tmp}/live.tfstate" >/dev/null 2>&1; then
    live_lineage="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("lineage",""))' "${tmp}/live.tfstate" 2>/dev/null || echo "")"
    live_serial="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("serial",""))' "${tmp}/live.tfstate" 2>/dev/null || echo "")"

    if [[ -n "${live_lineage}" && "${live_lineage}" != "${snap_lineage}" ]]; then
      _die "lineage mismatch. Refusing to restore.
  live:     ${live_lineage}
  snapshot: ${snap_lineage}
These are histories of two different states. Restoring one over the other is
almost certainly wrong; if it is genuinely intended, do it by hand and know why."
    fi

    _info "live serial ${live_serial}  ->  snapshot serial ${snap_serial}"

    # Restoring is itself a destructive write, so it gets a snapshot of its own.
    # Otherwise a restore to the wrong snapshot is unrecoverable, which is the
    # same class of problem this script was written to fix.
    local pre_key
    pre_key="${SNAPSHOT_PREFIX}/${KEY}/$(date -u +%Y-%m-%dT%H%M%SZ)-pre-restore.tfstate"
    _s3 put-object --bucket "${BUCKET}" --key "${pre_key}" \
      --body "${tmp}/live.tfstate" --content-type application/json >/dev/null ||
      _die "could not snapshot the current state before restoring. Aborting."
    _info "current state saved to ${pre_key}"
  fi

  _s3 put-object --bucket "${BUCKET}" --key "${KEY}" \
    --body "${tmp}/snap.tfstate" --content-type application/json >/dev/null ||
    _die "restore failed while writing ${KEY}"

  _s3 get-object --bucket "${BUCKET}" --key "${KEY}" "${tmp}/verify.tfstate" >/dev/null ||
    _die "restored but could not read back ${KEY}. Investigate immediately."
  [[ "$(_sha256 "${tmp}/snap.tfstate")" == "$(_sha256 "${tmp}/verify.tfstate")" ]] ||
    _die "restore readback digest mismatch. Investigate immediately."

  _info "restored s3://${BUCKET}/${KEY} from ${snap_key}"
  _info "Run 'terraform plan' before anything else. Expect no changes if this"
  _info "was a rollback of a failed apply."
}

case "${1:-}" in
  snapshot) shift; cmd_snapshot "$@" ;;
  list)     shift; cmd_list "$@" ;;
  restore)  shift; cmd_restore "$@" ;;
  *)
    cat >&2 <<'USAGE'
usage: infra/lib/tfstate-snapshot.sh <command> <terraform-root-dir> [args]

  snapshot <root> [--local <dir>]   copy live state to a verified timestamped key
  list     <root>                   list snapshots for that root
  restore  <root> <snapshot-key>    copy a snapshot back over the live key

R2 does not support object versioning, so this is the rollback mechanism.
Run `snapshot` BEFORE every apply; it exits non-zero if the copy cannot be
read back, so a failed snapshot stops the apply.
USAGE
    exit 2
    ;;
esac
