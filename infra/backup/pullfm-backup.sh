#!/usr/bin/env bash
#
# Pull.fm - logical dumps to R2, and the deletion ledger that makes a restore
# legal as well as correct.
#
# ===========================================================================
# WHY THIS EXISTS AND WHAT IT IS NOT
# ===========================================================================
#
# The database is Neon. Neon takes its own copy-on-write history and can restore
# a branch to any point inside it in seconds, which is strictly better than the
# pgBackRest-into-a-fresh-node path this repository used to plan for. So this
# tool is NOT the primary restore mechanism. `infra/backup/pullfm-restore.sh` is.
#
# This tool covers the two things Neon's own history cannot, and it is worth
# being precise about them because "we have backups" is not a statement:
#
#   1. TIME. `history_retention_seconds` is 21600 on the free plan. Six hours.
#      A bug discovered on Monday about Friday's data is outside it, and no
#      amount of Neon-side cleverness brings it back. A dump is the only thing
#      that survives that.
#
#   2. BLAST RADIUS. Every Neon restore primitive lives inside the Neon project.
#      If the project, the organisation or the account goes, so do the branches
#      and so does the history. A dump in R2 is the only copy of this database
#      that is not inside the database vendor.
#
# What it deliberately does NOT try to be: a continuous archive. There is no WAL
# shipping here, so the RPO of THIS layer is the interval between dumps, and
# that is a full day for the scheduled job. That is not the service RPO; it is
# the RPO of the last-resort layer. The layered numbers are in
# docs/RUNBOOK-DR.md section 1 and only that table should be quoted at anyone.
#
# ===========================================================================
# ENCRYPTION
# ===========================================================================
#
# R2 encrypts at rest under Cloudflare's key, which protects against a stolen
# disk and against nothing else. If the R2 access key leaks, a server-side-only
# encrypted dump is plaintext to whoever holds it. pgBackRest solved this with a
# repository cipher; pgBackRest is gone, so the cipher has to be here.
#
# Construction: AES-256-CBC with a PBKDF2-derived key (600k iterations, random
# salt per object), then HMAC-SHA256 over the CIPHERTEXT with an independent
# key. Encrypt-then-MAC, which is the ordering that is actually sound. Both keys
# live in 1Password on `pull-fm/infra/BACKUP_DUMP_KEY` and NOWHERE ELSE, and
# they are subject to the same escrow requirement as the KEK: losing them turns
# every dump in the bucket into noise. openssl was chosen over age or gpg for
# one reason: it is present on every machine that could ever have to run a
# restore, including a rescue image, and a restore tool with an install step is
# a restore tool that fails when it is needed.
#
# ===========================================================================
# RETENTION, WHICH USED TO BE THE UNANSWERED QUESTION
# ===========================================================================
#
# The bucket carried no expiry rule, on the documented grounds that "a dump
# taken before a destructive operation must outlive that operation". True, and
# it does not imply "forever". It implies a bound longer than the operation.
# `legal/privacy-policy.md` section 7 commits that backup retention is bounded,
# and an unbounded bucket made that sentence false.
#
# The fix is that dumps are not one class of object. Three prefixes, three
# bounds, enforced by an R2 lifecycle rule (the platform, not this script, so it
# holds even if this script never runs again):
#
#   dumps/scheduled/   35 days   the nightly dump
#   dumps/preflight/   90 days   taken immediately before a destructive change
#   dumps/hold/        none      an explicit, reasoned, reviewable exception
#
# `retention-check` asserts the live rules match those numbers, so drift is a
# failed check rather than a discovery during an audit. `hold/` requires
# --reason and is listed by `retention-check` with its age, which is what makes
# it an exception with an owner rather than a hole.
#
# R2 DOES support lifecycle expiry. It does NOT support object versioning
# (PutBucketVersioning / GetBucketVersioning are unimplemented and
# GetBucketVersioning returns an EMPTY BODY at exit 0 rather than an error, which
# is why this repository believed for a while that it had it). Nothing here
# assumes a previous version of an object can be recovered: every write is to a
# key that has never existed, and `ledger-export` refuses to overwrite.
#
# ===========================================================================
# USAGE
# ===========================================================================
#
#   infra/backup/pullfm-backup.sh dump [--kind scheduled|preflight|hold|drill]
#                                      [--reason "..."] [--dsn <dsn>]
#   infra/backup/pullfm-backup.sh list [prefix]
#   infra/backup/pullfm-backup.sh verify <key>
#   infra/backup/pullfm-backup.sh fetch  <key> <outfile>
#   infra/backup/pullfm-backup.sh retention-apply
#   infra/backup/pullfm-backup.sh retention-check
#   infra/backup/pullfm-backup.sh ledger-export [--dsn <dsn>]
#   infra/backup/pullfm-backup.sh ledger-list
#   infra/backup/pullfm-backup.sh replay-deletions [--dsn <dsn>] [--dry-run]
#
# Credentials come from 1Password. Nothing is read from a file on disk and
# nothing is written to one except under --local, because this repository is
# public and a dump is every user record we hold.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/backup-common.sh
source "${ROOT}/infra/lib/backup-common.sh"

readonly TOOL_VERSION="1"

# Retention, in days, per prefix. These numbers are the policy; changing one
# here is changing what legal/privacy-policy.md section 7 promises, so change
# both or neither. 0 means no expiry rule.
readonly RETAIN_SCHEDULED=35
readonly RETAIN_PREFLIGHT=90
readonly RETAIN_DRILL=14
readonly RETAIN_HOLD=0

# `hold/` is unbounded by construction, so it needs a review trigger instead of
# an expiry. Anything older than this is reported by retention-check as an
# exception that has outlived its justification.
readonly HOLD_REVIEW_DAYS=180

# ---------------------------------------------------------------------------
# cipher material
# ---------------------------------------------------------------------------

_load_cipher() {
  pullfm_need openssl
  # Environment first, so a node with an 0600 env file and no 1Password can run
  # the nightly dump unattended. See the note in infra/lib/backup-common.sh.
  if [[ -n "${PULLFM_BACKUP_CIPHER_PASS:-}" && -n "${PULLFM_BACKUP_HMAC_KEY:-}" ]]; then
    CIPHER_PASS="${PULLFM_BACKUP_CIPHER_PASS}"
    HMAC_KEY="${PULLFM_BACKUP_HMAC_KEY}"
  else
    pullfm_need op
    CIPHER_PASS="$(pullfm_op_field "${PULLFM_BACKUP_OP_CIPHER}" 'cipher passphrase')"
    HMAC_KEY="$(pullfm_op_field "${PULLFM_BACKUP_OP_CIPHER}" 'hmac key')"
  fi
  # EXPORTED because `openssl enc -pass env:CIPHER_PASS` reads the environment
  # of the openssl process, not this shell's variables. Passing it as -pass
  # pass:... instead would put the key in the process table for every other user
  # on the machine to read, which is the reason for the env indirection.
  export CIPHER_PASS HMAC_KEY
}

_encrypt() { # <plain> <out>
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 \
    -pass env:CIPHER_PASS -in "$1" -out "$2"
}

_decrypt() { # <cipher> <out>
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
    -pass env:CIPHER_PASS -in "$1" -out "$2"
}

_hmac() { # <file> -> hex
  openssl dgst -sha256 -mac HMAC -macopt "key:${HMAC_KEY}" -r "$1" | cut -d' ' -f1
}

# Constant-time-ish compare. Shell cannot do this properly, so compare digests
# of the two values instead of the values: an attacker who can time this learns
# only about a hash they already have.
_hmac_equal() {
  local a b
  a="$(printf '%s' "$1" | openssl dgst -sha256 -r | cut -d' ' -f1)"
  b="$(printf '%s' "$2" | openssl dgst -sha256 -r | cut -d' ' -f1)"
  [[ "${a}" == "${b}" ]]
}

# ---------------------------------------------------------------------------
# dump
# ---------------------------------------------------------------------------

cmd_dump() {
  local kind="scheduled" reason="" dsn="" local_copy=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --kind) kind="${2:?--kind needs a value}"; shift 2 ;;
      --reason) reason="${2:?--reason needs a value}"; shift 2 ;;
      --dsn) dsn="${2:?--dsn needs a value}"; shift 2 ;;
      --local) local_copy="${2:?--local needs a directory}"; shift 2 ;;
      *) pullfm_die "dump: unknown option $1" ;;
    esac
  done

  local prefix
  case "${kind}" in
    scheduled) prefix="${PULLFM_BACKUP_PREFIX_SCHEDULED}" ;;
    preflight) prefix="${PULLFM_BACKUP_PREFIX_PREFLIGHT}" ;;
    drill)     prefix="${PULLFM_BACKUP_PREFIX_DRILL}" ;;
    hold)
      prefix="${PULLFM_BACKUP_PREFIX_HOLD}"
      [[ -n "${reason}" ]] || pullfm_die "dump --kind hold requires --reason.

hold/ has no expiry. An object that outlives every stated retention bound needs
a written justification attached to it, or the bound is decorative."
      ;;
    *) pullfm_die "dump: --kind must be scheduled, preflight, drill or hold" ;;
  esac

  # preflight without a reason is allowed but is almost always a mistake: the
  # reason is the whole record of what the dump was protecting against.
  if [[ "${kind}" == "preflight" && -z "${reason}" ]]; then
    pullfm_warn "dump --kind preflight with no --reason. Six months from now the
only thing distinguishing this object from the nightly one is its prefix."
  fi

  pullfm_need pg_dump psql python3
  pullfm_backup_load_r2
  _load_cipher
  [[ -n "${dsn}" ]] || dsn="$(pullfm_backup_load_dsn)"

  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  local t0 t_dump t_enc t_put
  t0="$(pullfm_now_ms)"

  # The point-in-time this dump represents, taken from the SERVER, plus the LSN.
  # Without these a dump is a pile of rows with no position in the timeline, and
  # "restore to just before the dump" is unanswerable.
  local pg_now pg_lsn
  pg_now="$(pullfm_pg_now "${dsn}")"
  pg_lsn="$(psql "${dsn}" -X -A -t -v ON_ERROR_STOP=1 \
    -c "select pg_current_wal_lsn()" | tr -d '[:space:]')"

  pullfm_info "dumping $(pullfm_dsn_redact "${dsn}")"
  pullfm_info "  server time ${pg_now}  lsn ${pg_lsn}"

  # --format=custom so pg_restore can list, filter and parallelise. Compressed
  # by pg_dump itself, so nothing else has to be installed to read it.
  #
  # NO --schema=public, AND THAT IS THE WHOLE POINT OF THIS COMMENT.
  #
  # The first version of this tool passed --schema=public, which produced a dump
  # that restored perfectly into a database that already had the extensions and
  # failed completely into one that did not. pg_dump treats extensions as
  # database-level objects, so restricting to a schema silently drops all four
  # of them:
  #
  #   pg_restore --list <schema-restricted dump> | grep EXTENSION   ->  nothing
  #   pg_restore --list <full dump>              | grep EXTENSION   ->  citext,
  #                                          pg_trgm, pgcrypto, unaccent
  #
  # users.email is `citext`. A dump without CREATE EXTENSION citext cannot
  # recreate the users table at all, so the schema-restricted dump was not a
  # backup of this database in the only scenario a dump exists for: restoring
  # somewhere that is not this Neon project. The failure was invisible in every
  # test that restored into a Neon branch, because a branch inherits the
  # extensions from its parent.
  #
  # Ownership and ACLs are kept in the artifact even though a restore normally
  # discards them with --no-owner, because a dump is also the record of what the
  # schema and its grants looked like, and the least-privilege application role
  # is created by hand-written SQL that lives nowhere in Terraform.
  pg_dump --format=custom --compress=9 \
    --file="${tmp}/dump.pgc" "${dsn}" 2>"${tmp}/pgdump.err" || {
    pullfm_warn "$(cat "${tmp}/pgdump.err")"
    pullfm_die "pg_dump failed. Nothing was uploaded."
  }
  t_dump="$(pullfm_now_ms)"

  # Row counts, so `verify` can answer "is this dump plausible" without
  # restoring it, and so a dump that silently captured an empty database is
  # visible in the listing rather than at restore time.
  local counts
  counts="$(psql "${dsn}" -X -A -t -v ON_ERROR_STOP=1 <<'SQL' | python3 -c 'import sys,json; print(json.dumps({l.split("|")[0]: int(l.split("|")[1]) for l in sys.stdin.read().split() if "|" in l}))'
select 'users'||'|'||count(*) from users
union all select 'user_connections'||'|'||count(*) from user_connections
union all select 'wishlist_items'||'|'||count(*) from wishlist_items
union all select 'api_tokens'||'|'||count(*) from api_tokens
union all select 'audit_log'||'|'||count(*) from audit_log
union all select 'deletion_log'||'|'||count(*) from deletion_log;
SQL
)"

  _encrypt "${tmp}/dump.pgc" "${tmp}/dump.enc"
  t_enc="$(pullfm_now_ms)"

  local sha_plain sha_cipher mac size_plain size_cipher stamp key git_sha
  sha_plain="$(pullfm_sha256 "${tmp}/dump.pgc")"
  sha_cipher="$(pullfm_sha256 "${tmp}/dump.enc")"
  mac="$(_hmac "${tmp}/dump.enc")"
  size_plain="$(wc -c <"${tmp}/dump.pgc" | tr -d ' ')"
  size_cipher="$(wc -c <"${tmp}/dump.enc" | tr -d ' ')"
  stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
  git_sha="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  key="${prefix}/${stamp}-${git_sha}.pgc.enc"

  # Manifest first? No: ciphertext first. A manifest with no object is a
  # dangling promise that `list` would show as a backup. An object with no
  # manifest fails `verify` loudly, which is the safer of the two half-states.
  pullfm_s3 put-object --bucket "${PULLFM_BACKUP_BUCKET}" --key "${key}" \
    --body "${tmp}/dump.enc" --content-type application/octet-stream >/dev/null ||
    pullfm_die "upload failed for ${key}"

  # Every value is passed as an argument rather than interpolated into the
  # program text. A --reason containing a quote would otherwise write a manifest
  # that is not JSON, and the first time anyone would notice is `verify` failing
  # during a restore.
  python3 - "${tmp}/manifest.json" "${kind}" "${reason}" "${key}" "${pg_now}" \
    "${pg_lsn}" "${PULLFM_NEON_PROJECT_ID}" "$(pg_dump --version | awk '{print $3}')" \
    "${sha_plain}" "${sha_cipher}" "${mac}" "${size_plain}" "${size_cipher}" \
    "${counts}" "${git_sha}" "${TOOL_VERSION}" <<'PY'
import datetime, json, sys
(out, kind, reason, key, server_time, lsn, project, pgdump_v,
 sha_plain, sha_cipher, mac, n_plain, n_cipher, counts, git_sha, tool_v) = sys.argv[1:17]
json.dump({
    "tool_version": int(tool_v),
    "kind": kind,
    "reason": reason or None,
    "object_key": key,
    "created_at": datetime.datetime.now(datetime.timezone.utc)
                   .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "server_time": server_time,
    "wal_lsn": lsn,
    "neon_project": project,
    "pg_dump_version": pgdump_v,
    "format": "pg_dump custom, compress 9",
    "cipher": "AES-256-CBC / PBKDF2-SHA256 600000 iters / encrypt-then-MAC HMAC-SHA256",
    "sha256_plaintext": sha_plain,
    "sha256_ciphertext": sha_cipher,
    "hmac_sha256_ciphertext": mac,
    "bytes_plaintext": int(n_plain),
    "bytes_ciphertext": int(n_cipher),
    "row_counts": json.loads(counts),
    "git_sha": git_sha,
}, open(out, "w"), indent=2, sort_keys=True)
PY

  pullfm_s3 put-object --bucket "${PULLFM_BACKUP_BUCKET}" --key "${key}.manifest.json" \
    --body "${tmp}/manifest.json" --content-type application/json >/dev/null ||
    pullfm_die "uploaded ${key} but its manifest failed. Treat that object as unverified."
  t_put="$(pullfm_now_ms)"

  # THE READBACK. Same lesson as infra/lib/tfstate-snapshot.sh: a backup nobody
  # has read is not a backup, and the moment to find that out is now and not
  # during a restore. This re-downloads, re-MACs and decrypts, so it proves the
  # object AND the key in 1Password AND the digest chain, end to end.
  pullfm_info "verifying the object that was just written..."
  _verify_key "${key}" "${tmp}"

  pullfm_ok "dump verified: s3://${PULLFM_BACKUP_BUCKET}/${key}"
  pullfm_info "  pg_dump   $(pullfm_ms_human $((t_dump - t0)))"
  pullfm_info "  encrypt   $(pullfm_ms_human $((t_enc - t_dump)))"
  pullfm_info "  upload    $(pullfm_ms_human $((t_put - t_enc)))"
  pullfm_info "  total     $(pullfm_ms_human $(($(pullfm_now_ms) - t0)))"
  pullfm_info "  plaintext ${size_plain} B, ciphertext ${size_cipher} B"

  if [[ -n "${local_copy}" ]]; then
    mkdir -p "${local_copy}"
    cp "${tmp}/dump.enc" "${local_copy%/}/$(basename "${key}")"
    cp "${tmp}/manifest.json" "${local_copy%/}/$(basename "${key}").manifest.json"
    chmod 600 "${local_copy%/}/$(basename "${key}")"
    pullfm_warn "local copy in ${local_copy}. It is ciphertext, but the key that
opens it is one 'op read' away on the same laptop. Delete it when done."
  fi

  # stdout is the key, so callers can capture it.
  printf '%s\n' "${key}"
}

# ---------------------------------------------------------------------------
# verify / fetch
# ---------------------------------------------------------------------------

_verify_key() { # <key> <tmpdir>
  local key="$1" tmp="$2"
  pullfm_s3 get-object --bucket "${PULLFM_BACKUP_BUCKET}" --key "${key}" \
    "${tmp}/rb.enc" >/dev/null || pullfm_die "cannot read back ${key}"
  pullfm_s3 get-object --bucket "${PULLFM_BACKUP_BUCKET}" --key "${key}.manifest.json" \
    "${tmp}/rb.manifest.json" >/dev/null || pullfm_die "cannot read the manifest for ${key}"

  local m_sha m_mac m_plain
  m_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256_ciphertext"])' "${tmp}/rb.manifest.json")"
  m_mac="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["hmac_sha256_ciphertext"])' "${tmp}/rb.manifest.json")"
  m_plain="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256_plaintext"])' "${tmp}/rb.manifest.json")"

  [[ "$(pullfm_sha256 "${tmp}/rb.enc")" == "${m_sha}" ]] ||
    pullfm_die "${key}: ciphertext sha256 does not match its manifest."

  # MAC BEFORE DECRYPT. Decrypting an unauthenticated blob is how a padding
  # oracle becomes a chosen-ciphertext attack; more practically, it is how a
  # corrupted object produces a confusing openssl error instead of a clear one.
  _hmac_equal "$(_hmac "${tmp}/rb.enc")" "${m_mac}" ||
    pullfm_die "${key}: HMAC MISMATCH. The object was modified, or the hmac key
in 1Password is not the one it was written with. Do not restore this."

  _decrypt "${tmp}/rb.enc" "${tmp}/rb.pgc" ||
    pullfm_die "${key}: decryption failed after a valid MAC, which should be
impossible. The cipher passphrase in 1Password is probably not the one used."

  [[ "$(pullfm_sha256 "${tmp}/rb.pgc")" == "${m_plain}" ]] ||
    pullfm_die "${key}: plaintext sha256 does not match its manifest."

  # And prove it is a real archive rather than a well-formed pile of bytes.
  pg_restore --list "${tmp}/rb.pgc" >"${tmp}/toc.txt" 2>/dev/null ||
    pullfm_die "${key}: decrypted cleanly but pg_restore cannot read it."

  local objects
  objects="$(grep -c ';' "${tmp}/toc.txt" || true)"
  pullfm_info "  ${key}: mac ok, digests ok, ${objects} archive entries"
}

cmd_verify() {
  local key="${1:?usage: verify <key>}"
  pullfm_need pg_restore openssl python3
  pullfm_backup_load_r2
  _load_cipher
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT
  _verify_key "${key}" "${tmp}"
  python3 -m json.tool "${tmp}/rb.manifest.json" >&2
  pullfm_ok "${key} is restorable"
}

cmd_fetch() {
  local key="${1:?usage: fetch <key> <outfile>}" out="${2:?usage: fetch <key> <outfile>}"
  pullfm_backup_load_r2
  _load_cipher
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT
  _verify_key "${key}" "${tmp}"
  cp "${tmp}/rb.pgc" "${out}"
  chmod 600 "${out}"
  pullfm_warn "${out} is PLAINTEXT and contains every row of the database.
Mode 0600. Delete it when the restore is done."
}

cmd_list() {
  local prefix="${1:-dumps/}"
  pullfm_backup_load_r2
  pullfm_s3 list-objects-v2 --bucket "${PULLFM_BACKUP_BUCKET}" --prefix "${prefix}" \
    --query 'sort_by(Contents,&Key)[?!ends_with(Key, `manifest.json`)].[LastModified,Size,Key]' \
    --output text 2>/dev/null || pullfm_info "  (none)"
}

# ---------------------------------------------------------------------------
# retention
# ---------------------------------------------------------------------------

_lifecycle_json() {
  python3 - <<PY
import json
rules = [
  # R2 creates this rule itself on every bucket. PutBucketLifecycleConfiguration
  # REPLACES the whole configuration, so omitting it here would silently delete
  # it and leave failed multipart uploads billing forever.
  {"ID": "Default Multipart Abort Rule", "Status": "Enabled",
   "Filter": {"Prefix": ""},
   "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}},
]
for name, prefix, days in [
    ("pullfm-scheduled-dumps", "${PULLFM_BACKUP_PREFIX_SCHEDULED}/", ${RETAIN_SCHEDULED}),
    ("pullfm-preflight-dumps", "${PULLFM_BACKUP_PREFIX_PREFLIGHT}/", ${RETAIN_PREFLIGHT}),
    ("pullfm-drill-artifacts", "${PULLFM_BACKUP_PREFIX_DRILL}/",     ${RETAIN_DRILL}),
]:
    rules.append({"ID": name, "Status": "Enabled",
                  "Filter": {"Prefix": prefix},
                  "Expiration": {"Days": days}})
print(json.dumps({"Rules": rules}))
PY
}

cmd_retention_apply() {
  pullfm_backup_load_r2
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  _lifecycle_json >"${tmp}/lc.json"
  pullfm_s3 put-bucket-lifecycle-configuration \
    --bucket "${PULLFM_BACKUP_BUCKET}" \
    --lifecycle-configuration "file://${tmp}/lc.json" >/dev/null ||
    pullfm_die "could not write the lifecycle configuration"
  pullfm_ok "lifecycle rules applied to ${PULLFM_BACKUP_BUCKET}"
  cmd_retention_check
}

cmd_retention_check() {
  pullfm_backup_load_r2
  local live rc=0
  live="$(pullfm_s3 get-bucket-lifecycle-configuration --bucket "${PULLFM_BACKUP_BUCKET}" 2>/dev/null || echo '{"Rules":[]}')"

  local expected
  expected="$(_lifecycle_json)"

  python3 - "${live}" "${expected}" <<'PY' || rc=$?
import json, sys
live = {r["ID"]: r for r in json.loads(sys.argv[1]).get("Rules", [])}
want = {r["ID"]: r for r in json.loads(sys.argv[2]).get("Rules", [])}
bad = False
for rid, r in want.items():
    have = live.get(rid)
    if have is None:
        print(f"MISSING lifecycle rule: {rid}"); bad = True; continue
    if have.get("Status") != "Enabled":
        print(f"DISABLED lifecycle rule: {rid}"); bad = True
    wd = r.get("Expiration", {}).get("Days")
    hd = have.get("Expiration", {}).get("Days")
    if wd != hd:
        print(f"DRIFT on {rid}: expiry is {hd} days, policy says {wd}"); bad = True
    else:
        print(f"ok  {rid}: {r['Filter']['Prefix'] or '(all)'} expires after {wd} days"
              if wd else f"ok  {rid}")
for rid in live:
    if rid not in want:
        print(f"UNEXPECTED lifecycle rule: {rid}. Nothing in this repo wrote it."); bad = True
sys.exit(1 if bad else 0)
PY

  # hold/ has no expiry rule by design, so it gets a review trigger instead.
  local holds
  holds="$(pullfm_s3 list-objects-v2 --bucket "${PULLFM_BACKUP_BUCKET}" \
    --prefix "${PULLFM_BACKUP_PREFIX_HOLD}/" \
    --query 'Contents[].[LastModified,Key]' --output text 2>/dev/null || true)"
  if [[ -n "${holds}" && "${holds}" != "None" ]]; then
    pullfm_warn "objects under ${PULLFM_BACKUP_PREFIX_HOLD}/ have NO expiry:"
    printf '%s\n' "${holds}" >&2
    pullfm_warn "Anything here older than ${HOLD_REVIEW_DAYS} days has outlived
the destructive operation it was taken for. Delete it or restate why not."
  else
    pullfm_info "no objects under ${PULLFM_BACKUP_PREFIX_HOLD}/ - retention is fully bounded"
  fi

  if [[ ${rc} -ne 0 ]]; then
    pullfm_die "lifecycle configuration does not match the retention policy in
this file and in legal/privacy-policy.md section 7. Run: retention-apply"
  fi
  pullfm_ok "retention matches policy"
}

# ---------------------------------------------------------------------------
# the deletion ledger
# ---------------------------------------------------------------------------
#
# THIS IS THE MOST IMPORTANT THING IN THIS FILE, and it exists because the drill
# in docs/RUNBOOK-DR.md section 5 falsified a claim the privacy policy makes.
#
# The claim: "a restore replays the deletions", using `deletion_log` as the
# authoritative replay list.
#
# The problem: `deletion_log` is a table IN THE DATABASE BEING RESTORED. Roll
# the database back to a point before an erasure and you roll back the erasure
# AND the record of it, simultaneously. The user is resurrected and there is no
# longer anything that says they should not be. A replay list that is inside the
# thing being rolled back is not a replay list.
#
# The fix is that the ledger has to live somewhere the restore cannot reach.
# One R2 object per deletion, written under a key derived from the user id, so:
#
#   * it is append-only BY CONSTRUCTION rather than by permission. There is no
#     read-modify-write, so two writers cannot lose each other's record, and no
#     object versioning is required, which matters because R2 has none.
#   * a restore of Postgres cannot alter it.
#   * it holds an opaque uuid and timestamps and nothing else. That is the same
#     data `deletion_log` already retains permanently and which
#     legal/privacy-policy.md section 7 already discloses, so this adds a
#     location, not a category.
#
# WHAT THIS EXPORTER IS NOW FOR, WHICH IS NOT WHAT IT WAS FOR.
#
# It used to be the only writer, on a timer, and that interval WAS the
# erasure-durability RPO. The deletion cascade in apps/bff now writes the ledger
# object inline and refuses to delete anything if that write fails, so an erasure
# is durable at the moment of the request and the RPO is zero.
#
# This remains as a RECONCILER, and it earns its place twice: it backfills
# deletion_log rows that predate the inline write, and it is the only thing that
# would notice a divergence between the two records. It is idempotent by
# construction - HEAD before PUT, one object per id - so running it against a
# ledger the application already wrote is a no-op that costs one HEAD per row.
#
# The HEAD-before-PUT is now belt and braces rather than the guarantee: the
# bucket lock rule refuses an overwriting PutObject outright. Keep it anyway,
# because it turns "the lock rejected 400 writes" into "400 already present".

_ledger_key() { printf '%s/%s.json' "${PULLFM_BACKUP_PREFIX_LEDGER}" "$1"; }

cmd_ledger_export() {
  local dsn=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dsn) dsn="${2:?}"; shift 2 ;;
      *) pullfm_die "ledger-export: unknown option $1" ;;
    esac
  done
  pullfm_need psql python3
  pullfm_backup_load_ledger_r2
  [[ -n "${dsn}" ]] || dsn="$(pullfm_backup_load_dsn)"

  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  psql "${dsn}" -X -A -t -F$'\t' -v ON_ERROR_STOP=1 -c \
    "select deleted_user_id, requested_at, coalesce(completed_at::text,''), workos_deleted from deletion_log order by requested_at" \
    >"${tmp}/rows.tsv"

  local wrote=0 skipped=0 line uid req comp wd key
  while IFS=$'\t' read -r uid req comp wd; do
    [[ -n "${uid}" ]] || continue
    key="$(_ledger_key "${uid}")"

    # HEAD before PUT. The ledger is append-only, and "append-only" that a
    # second run silently overwrites is just a filename convention.
    if pullfm_s3 head-object --bucket "${PULLFM_LEDGER_BUCKET}" --key "${key}" >/dev/null 2>&1; then
      skipped=$((skipped + 1))
      continue
    fi

    python3 - "${tmp}/entry.json" "${uid}" "${req}" "${comp}" "${wd}" <<'PY'
import json, sys, datetime
out, uid, req, comp, wd = sys.argv[1:6]
json.dump({
    "deleted_user_id": uid,
    "requested_at": req,
    "completed_at": comp or None,
    "workos_deleted": wd == "t",
    "exported_at": datetime.datetime.now(datetime.timezone.utc)
                    .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "note": "Authoritative erasure record. Survives a Postgres restore because it is not in Postgres. Re-delete this id before a restored system serves traffic.",
}, open(out, "w"), indent=2, sort_keys=True)
PY

    pullfm_s3 put-object --bucket "${PULLFM_LEDGER_BUCKET}" --key "${key}" \
      --body "${tmp}/entry.json" --content-type application/json >/dev/null ||
      pullfm_die "could not write ledger entry for ${uid}"
    wrote=$((wrote + 1))
  done <"${tmp}/rows.tsv"

  pullfm_info "ledger: ${wrote} new, ${skipped} already present"
  printf '%s\n' "${wrote}"
}

cmd_ledger_list() {
  pullfm_backup_load_ledger_r2
  pullfm_s3 list-objects-v2 --bucket "${PULLFM_LEDGER_BUCKET}" \
    --prefix "${PULLFM_BACKUP_PREFIX_LEDGER}/" \
    --query 'sort_by(Contents,&Key)[].[LastModified,Key]' --output text 2>/dev/null ||
    pullfm_info "  (none)"
}

# replay-deletions: the step that must run BEFORE a restored system serves
# traffic. Idempotent, so running it twice is free and running it when nothing
# needs replaying is a no-op that still proves it ran.
cmd_replay_deletions() {
  local dsn="" dry=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dsn) dsn="${2:?}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      *) pullfm_die "replay-deletions: unknown option $1" ;;
    esac
  done
  pullfm_need psql python3
  pullfm_backup_load_ledger_r2
  [[ -n "${dsn}" ]] || dsn="$(pullfm_backup_load_dsn)"

  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  local keys
  keys="$(pullfm_s3 list-objects-v2 --bucket "${PULLFM_LEDGER_BUCKET}" \
    --prefix "${PULLFM_BACKUP_PREFIX_LEDGER}/" \
    --query 'Contents[].Key' --output text 2>/dev/null || true)"
  if [[ -z "${keys}" || "${keys}" == "None" ]]; then
    pullfm_info "the ledger is empty: nothing to replay"
    printf '0\n'
    return 0
  fi

  : >"${tmp}/ids.txt"
  local k
  for k in ${keys}; do
    pullfm_s3 get-object --bucket "${PULLFM_LEDGER_BUCKET}" --key "${k}" \
      "${tmp}/e.json" >/dev/null || pullfm_die "cannot read ledger object ${k}"
    python3 -c '
import json, sys
e = json.load(open(sys.argv[1]))
print("\t".join([e["deleted_user_id"], e["requested_at"], e.get("completed_at") or e["requested_at"]]))
' "${tmp}/e.json" >>"${tmp}/ids.txt"
  done

  local total resurrected
  total="$(wc -l <"${tmp}/ids.txt" | tr -d ' ')"

  # How many of the ledger's ids are actually PRESENT in the target. This is the
  # number that matters: it is the count of people a restore just brought back
  # from the dead.
  resurrected="$(psql "${dsn}" -X -A -t -q -v ON_ERROR_STOP=1 <<SQL | tr -d '[:space:]'
-- DROP FIRST. Neon parks idle backends and hands the same one back to the next
-- connection, so a temporary table can outlive the psql process that made it
-- (docs/runbooks/neon-migration.md 11f). Against stock Postgres this line is a
-- no-op; against Neon it is the difference between working and
-- 'relation "_ledger" already exists' on the second invocation.
drop table if exists _ledger;
create temporary table _ledger(id uuid, requested_at timestamptz, completed_at timestamptz);
\\copy _ledger from '${tmp}/ids.txt' with (format text)
select count(*) from users u join _ledger l on l.id = u.id;
SQL
)"
  pullfm_info "ledger holds ${total} erasures; ${resurrected} of them exist in the target right now"

  if [[ ${dry} -eq 1 ]]; then
    printf '%s\n' "${resurrected}"
    return 0
  fi

  # One transaction. A partial replay leaves some people re-deleted and some
  # not, with no record of which, and that is worse than not having started.
  psql "${dsn}" -X -q -v ON_ERROR_STOP=1 <<SQL >&2
begin;
drop table if exists _ledger;  -- see the note above about Neon backend reuse
create temporary table _ledger(id uuid, requested_at timestamptz, completed_at timestamptz);
\\copy _ledger from '${tmp}/ids.txt' with (format text)

-- The erasure itself. ON DELETE CASCADE on every user-owned table does the
-- rest, which is why this is one statement and not a sweep that can half-fail.
delete from users u using _ledger l where u.id = l.id;

-- And put the record back, because the restore rolled that back too. Without
-- this, the next restore has to rediscover the same erasures from the ledger,
-- and an operator inspecting the database sees no evidence the replay happened.
insert into deletion_log (deleted_user_id, requested_at, completed_at, notes)
select l.id, l.requested_at, l.completed_at,
       'reconstructed from the R2 deletion ledger during a restore'
from _ledger l
where not exists (select 1 from deletion_log d where d.deleted_user_id = l.id);
commit;
SQL

  local left
  left="$(psql "${dsn}" -X -A -t -v ON_ERROR_STOP=1 -c \
    "select count(*) from users u where exists (select 1 from deletion_log d where d.deleted_user_id = u.id)" | tr -d '[:space:]')"
  [[ "${left}" == "0" ]] ||
    pullfm_die "replay finished but ${left} deleted ids are still present in users. DO NOT SERVE TRAFFIC."

  pullfm_ok "replayed ${resurrected} erasure(s); every ledger id is absent from users"
  printf '%s\n' "${resurrected}"
}

# ---------------------------------------------------------------------------

case "${1:-}" in
  dump)              shift; cmd_dump "$@" ;;
  list)              shift; cmd_list "$@" ;;
  verify)            shift; cmd_verify "$@" ;;
  fetch)             shift; cmd_fetch "$@" ;;
  retention-apply)   shift; cmd_retention_apply "$@" ;;
  retention-check)   shift; cmd_retention_check "$@" ;;
  ledger-export)     shift; cmd_ledger_export "$@" ;;
  ledger-list)       shift; cmd_ledger_list "$@" ;;
  replay-deletions)  shift; cmd_replay_deletions "$@" ;;
  *)
    cat >&2 <<'USAGE'
usage: infra/backup/pullfm-backup.sh <command> [options]

  dump [--kind scheduled|preflight|drill|hold] [--reason "..."] [--dsn D] [--local DIR]
                        pg_dump -> encrypt -> R2 -> READ IT BACK AND VERIFY.
                        Prints the object key on stdout.
  list [prefix]         list dump objects (default prefix dumps/)
  verify <key>          re-download, check MAC and digests, decrypt, pg_restore --list
  fetch <key> <out>     verify then write the PLAINTEXT archive to <out> (mode 0600)

  retention-apply       write the R2 lifecycle rules that bound dump retention
  retention-check       assert the live rules match the policy; list hold/ exceptions

  ledger-export [--dsn D]      copy deletion_log to the append-only R2 ledger
  ledger-list                  list ledger entries
  replay-deletions [--dsn D] [--dry-run]
                        re-apply every erasure in the ledger to a restored
                        database. MUST run before a restored system serves
                        traffic. Idempotent.

Neon's own history is the fast restore path and lives in pullfm-restore.sh.
This tool is the layer that survives (a) more than six hours and (b) the loss
of the Neon account. See docs/RUNBOOK-DR.md.
USAGE
    exit 2
    ;;
esac
