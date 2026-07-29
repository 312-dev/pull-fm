#!/usr/bin/env bash
#
# Pull.fm - Neon restore primitives.
#
# ===========================================================================
# THE ARGUMENT FOR BRANCHES, WHICH IS THE WHOLE DESIGN
# ===========================================================================
#
# Neon gives three ways to get old data back, and they are not interchangeable.
#
#   PITR ("instant restore"). Restore a branch to any instant inside
#   `history_retention_seconds`. That is SIX HOURS on the free plan. Inside the
#   window it is close to perfect: arbitrary-second targeting, a control-plane
#   operation, no data movement. Outside it, it does not exist.
#
#   A BRANCH TAKEN AT A POINT IN TIME. Creating a child branch pins the parent's
#   pages at that LSN. The branch is then an independent object that Neon keeps
#   alive because the branch exists, not because the parent's history window
#   still covers it. That is the important property and it is what turns a
#   six-hour window into an arbitrary-length one for the specific instants you
#   chose to keep. It costs the storage of the diff, which for this database is
#   tens of megabytes, and it costs one of TEN branch slots on the free plan.
#
#   A LOGICAL DUMP. Slow, complete, and the only one that still exists if the
#   Neon account does not. infra/backup/pullfm-backup.sh.
#
# So the strategy is: PITR for "we noticed in the last few hours", a pinned
# branch for "we are about to do something dangerous" and for a daily marker,
# and a dump for "more than six hours ago" and for "Neon is gone". Each covers
# what the previous one does not, and the runbook says which to reach for.
#
# THE BRANCH LIMIT IS THE CONSTRAINT AND IT IS SMALL. Ten. Two are already spent
# on main and staging. `restore-point prune` exists because the failure mode of
# forgetting is that the next `restore-point create`, at the worst possible
# moment, fails with a quota error.
#
# ===========================================================================
# WHAT A RESTORE DOES NOT DO
# ===========================================================================
#
# It does not replay deletions. See `pullfm-backup.sh replay-deletions` and the
# long comment above it. Rolling the database back to a point before an erasure
# also rolls back `deletion_log`, so the database comes back with the deleted
# user present and no record that they asked to be gone. Every restore path in
# this file prints that reminder, because the drill proved it is real.
#
# ===========================================================================
# USAGE
# ===========================================================================
#
#   infra/backup/pullfm-restore.sh branches
#   infra/backup/pullfm-restore.sh dsn <branch-id-or-name> [--pooled]
#   infra/backup/pullfm-restore.sh restore-point create <branch> [--label L] [--at TS]
#   infra/backup/pullfm-restore.sh restore-point list
#   infra/backup/pullfm-restore.sh restore-point delete <branch-id>
#   infra/backup/pullfm-restore.sh restore-point prune [--keep N]
#   infra/backup/pullfm-restore.sh pitr <branch> --at <timestamp> [--preserve NAME]
#   infra/backup/pullfm-restore.sh from-branch <branch> --source <branch> [--preserve NAME]
#   infra/backup/pullfm-restore.sh from-dump <key> --into <dsn> [--database NAME]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/backup-common.sh
source "${ROOT}/infra/lib/backup-common.sh"

readonly RP_PREFIX="rp-"
readonly RP_KEEP_DEFAULT=4

# Branch ids that must never be the TARGET of a restore run from this tool
# without an explicit override. `main` is production.
readonly PROTECTED_BRANCHES="br-curly-wave-as91izv6 main"

_resolve_branch() { # name-or-id -> id
  local want="$1"
  pullfm_neon GET "/branches" | python3 -c '
import json, sys
want = sys.argv[1]
bs = json.load(sys.stdin)["branches"]
for b in bs:
    if b["id"] == want or b["name"] == want:
        print(b["id"]); break
else:
    sys.exit("no branch named or identified by " + want)
' "${want}"
}

_branch_name() {
  pullfm_neon GET "/branches/$1" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["branch"]["name"])'
}

_assert_not_protected() {
  local id="$1" name
  name="$(_branch_name "${id}")"
  local p
  for p in ${PROTECTED_BRANCHES}; do
    if [[ "${id}" == "${p}" || "${name}" == "${p}" ]]; then
      [[ "${PULLFM_ALLOW_PROTECTED:-0}" == "1" ]] || pullfm_die \
        "REFUSING: '${name}' (${id}) is a protected branch.

This tool will not restore, reset or delete production data. If that is
genuinely the intent, the operator sets PULLFM_ALLOW_PROTECTED=1 by hand, which
is deliberately something a script cannot do for them."
    fi
  done
}

# ---------------------------------------------------------------------------

cmd_branches() {
  pullfm_backup_load_neon
  pullfm_neon GET "/branches" | python3 -c '
import json, sys
for b in json.load(sys.stdin)["branches"]:
    print("%-28s %-34s parent=%-28s %-8s %7.1f MB  created=%s" % (
        b["id"], b["name"], b.get("parent_id") or "-", b["current_state"],
        b.get("logical_size", 0) / 1e6, b["created_at"]))
'
}

cmd_dsn() {
  local want="${1:?usage: dsn <branch>}"; shift || true
  local pooled=false
  [[ "${1:-}" == "--pooled" ]] && pooled=true
  pullfm_backup_load_neon
  local id; id="$(_resolve_branch "${want}")"
  # The role and database names are fixed by the Neon project, not by us.
  pullfm_neon GET "/connection_uri?branch_id=${id}&database_name=neondb&role_name=neondb_owner&pooled=${pooled}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["uri"])'
}

# ---------------------------------------------------------------------------
# restore points
# ---------------------------------------------------------------------------

cmd_rp_create() {
  local want="${1:?usage: restore-point create <branch> [--label L] [--at TS]}"; shift || true
  local label="manual" at=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --label) label="${2:?}"; shift 2 ;;
      --at) at="${2:?}"; shift 2 ;;
      *) pullfm_die "restore-point create: unknown option $1" ;;
    esac
  done
  pullfm_backup_load_neon

  local parent stamp name body t0
  parent="$(_resolve_branch "${want}")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  # Slugged, because a branch name is a URL path segment and an operator typing
  # a label with a space at 3am should get a branch, not a 400.
  label="$(printf '%s' "${label}" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
  name="${RP_PREFIX}${label}-${stamp}"

  # NO ENDPOINT. A restore point is data, not a place to connect to, and every
  # compute costs CU-hours out of a 100/month allowance. `from-branch` reads it
  # through the target branch's endpoint, and if a human needs to look inside
  # one directly they can add an endpoint for the ten minutes that takes.
  if [[ -n "${at}" ]]; then
    body="$(python3 -c 'import json,sys; print(json.dumps({"branch":{"parent_id":sys.argv[1],"name":sys.argv[2],"parent_timestamp":sys.argv[3]}}))' "${parent}" "${name}" "${at}")"
  else
    body="$(python3 -c 'import json,sys; print(json.dumps({"branch":{"parent_id":sys.argv[1],"name":sys.argv[2]}}))' "${parent}" "${name}")"
  fi

  t0="$(pullfm_now_ms)"
  local id
  id="$(pullfm_neon POST "/branches" "${body}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["branch"]["id"])')"
  pullfm_neon_wait_ready "${id}" >/dev/null

  pullfm_ok "restore point ${name} = ${id}  ($(pullfm_ms_human $(($(pullfm_now_ms) - t0))))"
  pullfm_info "  pinned from ${parent}${at:+ at ${at}}"
  printf '%s\n' "${id}"
}

cmd_rp_list() {
  pullfm_backup_load_neon
  pullfm_neon GET "/branches" | python3 -c '
import json, sys
prefix = sys.argv[1]
rows = [b for b in json.load(sys.stdin)["branches"] if b["name"].startswith(prefix)]
if not rows:
    print("  (no restore points)")
for b in sorted(rows, key=lambda b: b["created_at"]):
    print("%-28s %-44s parent_ts=%s %7.1f MB  %s" % (
        b["id"], b["name"], b.get("parent_timestamp", "-"),
        b.get("logical_size", 0) / 1e6, b["created_at"]))
' "${RP_PREFIX}"
}

cmd_rp_delete() {
  local id="${1:?usage: restore-point delete <branch-id>}"
  pullfm_backup_load_neon
  local name; name="$(_branch_name "${id}")"
  [[ "${name}" == ${RP_PREFIX}* ]] || pullfm_die \
    "REFUSING: '${name}' is not a restore point (its name does not start with '${RP_PREFIX}').

This subcommand only deletes branches this tool created. Deleting anything else
is a console operation, on purpose."
  # A 422 here is almost always "it has children", which happens after a
  # from-branch restore made the target a descendant of this restore point.
  pullfm_neon_soft DELETE "/branches/${id}" >/dev/null || {
    pullfm_die "could not delete ${name}.

If the message above says it has children, a branch was restored FROM this
restore point and is now descended from it. Re-parent that branch first:
  infra/backup/pullfm-restore.sh from-branch <child> --source <its original parent>"
  }
  pullfm_ok "deleted restore point ${name} (${id})"
}

cmd_rp_prune() {
  local keep="${RP_KEEP_DEFAULT}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep) keep="${2:?}"; shift 2 ;;
      *) pullfm_die "restore-point prune: unknown option $1" ;;
    esac
  done
  pullfm_backup_load_neon

  local doomed
  doomed="$(pullfm_neon GET "/branches" | python3 -c '
import json, sys
keep, prefix = int(sys.argv[1]), sys.argv[2]
rows = [b for b in json.load(sys.stdin)["branches"] if b["name"].startswith(prefix)]
rows.sort(key=lambda b: b["created_at"])
for b in rows[:max(0, len(rows) - keep)]:
    print(b["id"], b["name"])
' "${keep}" "${RP_PREFIX}")"

  if [[ -z "${doomed}" ]]; then
    pullfm_info "nothing to prune (keeping the newest ${keep})"
    return 0
  fi
  local id name
  while read -r id name; do
    [[ -n "${id}" ]] || continue
    pullfm_neon DELETE "/branches/${id}" >/dev/null
    pullfm_info "  pruned ${name} (${id})"
  done <<<"${doomed}"
}

# ---------------------------------------------------------------------------
# restores
# ---------------------------------------------------------------------------

_after_restore_notice() {
  pullfm_warn "
THE RESTORE IS NOT FINISHED.

A restore rolls back deletion_log along with everything else, so any account
erased after the restore target is now BACK, with no record that it asked to be
gone. Before this database serves traffic:

  infra/backup/pullfm-backup.sh replay-deletions --dsn <dsn>

That reads the R2 deletion ledger, which is outside the database and therefore
outside the rollback. legal/privacy-policy.md section 7 promises this happens."
}

cmd_pitr() {
  local want="${1:?usage: pitr <branch> --at <timestamp>}"; shift
  local at="" preserve=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --at) at="${2:?}"; shift 2 ;;
      --preserve) preserve="${2:?}"; shift 2 ;;
      *) pullfm_die "pitr: unknown option $1" ;;
    esac
  done
  [[ -n "${at}" ]] || pullfm_die "pitr requires --at <timestamp>"
  pullfm_backup_load_neon

  local id; id="$(_resolve_branch "${want}")"
  _assert_not_protected "${id}"

  # source_branch_id == the branch itself is how Neon expresses "restore this
  # branch to its own history".
  local body t0 elapsed
  body="$(python3 -c '
import json, sys
d = {"source_branch_id": sys.argv[1], "source_timestamp": sys.argv[2]}
if sys.argv[3]:
    d["preserve_under_name"] = sys.argv[3]
print(json.dumps(d))' "${id}" "${at}" "${preserve}")"

  pullfm_info "restoring ${want} (${id}) to ${at}"
  t0="$(pullfm_now_ms)"
  pullfm_neon POST "/branches/${id}/restore" "${body}" >/dev/null
  pullfm_neon_wait_ready "${id}" >/dev/null
  elapsed=$(($(pullfm_now_ms) - t0))

  pullfm_ok "PITR complete in $(pullfm_ms_human ${elapsed})"
  _after_restore_notice
  printf '%s\n' "${elapsed}"
}

cmd_from_branch() {
  local want="${1:?usage: from-branch <branch> --source <branch>}"; shift
  local src="" preserve=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source) src="${2:?}"; shift 2 ;;
      --preserve) preserve="${2:?}"; shift 2 ;;
      *) pullfm_die "from-branch: unknown option $1" ;;
    esac
  done
  [[ -n "${src}" ]] || pullfm_die "from-branch requires --source <branch>"
  pullfm_backup_load_neon

  local id src_id
  id="$(_resolve_branch "${want}")"
  src_id="$(_resolve_branch "${src}")"
  _assert_not_protected "${id}"

  local body t0 elapsed
  body="$(python3 -c '
import json, sys
d = {"source_branch_id": sys.argv[1]}
if sys.argv[2]:
    d["preserve_under_name"] = sys.argv[2]
print(json.dumps(d))' "${src_id}" "${preserve}")"

  pullfm_info "resetting ${want} (${id}) from ${src} (${src_id})"
  t0="$(pullfm_now_ms)"
  pullfm_neon POST "/branches/${id}/restore" "${body}" >/dev/null
  pullfm_neon_wait_ready "${id}" >/dev/null
  elapsed=$(($(pullfm_now_ms) - t0))

  pullfm_ok "branch restore complete in $(pullfm_ms_human ${elapsed})"
  pullfm_warn "LINEAGE: ${want} is now a CHILD of ${src}.

Neon refuses to delete a branch that has children, so ${src}${preserve:+ and ${preserve}}
can no longer be deleted while ${want} descends from it. Each branch restore
therefore costs branch slots out of a quota of ten, permanently, until the
target is put back under its original parent:

  infra/backup/pullfm-restore.sh from-branch ${want} --source <original-parent>

That is itself a reset and discards the restored data, so it is a cleanup step
for a drill and NOT something to run after a real recovery. After a real
recovery the right move is to accept the slots, or to promote the restored
branch and retire the old lineage deliberately."
  _after_restore_notice
  printf '%s\n' "${elapsed}"
}

# The slow path, and the only one that works when Neon does not.
#
# IT RESTORES INTO A NEW DATABASE, ALWAYS, and that is a correctness requirement
# rather than caution. pg_dump orders CREATE EXTENSION before CREATE SCHEMA
# public, because in a normal target `public` already exists from initdb. So
# "drop schema public cascade, then restore" fails on every extension:
#
#   pg_restore: error: ERROR: schema "public" does not exist
#   Command was: CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
#
# A freshly created database has a fresh `public` and the whole archive applies
# with zero errors. Restoring beside the live database and cutting over after
# verification is also simply the right shape for a recovery: nothing is
# destroyed by the attempt, so a failed restore costs a database and not the
# incident.
cmd_from_dump() {
  local key="${1:?usage: from-dump <key> --into <dsn> [--database NAME]}"; shift
  local into="" dbname=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --into) into="${2:?}"; shift 2 ;;
      --database) dbname="${2:?}"; shift 2 ;;
      --yes) shift ;;  # accepted and ignored: nothing here is destructive
      *) pullfm_die "from-dump: unknown option $1" ;;
    esac
  done
  [[ -n "${into}" ]] || pullfm_die "from-dump requires --into <dsn>"
  [[ -n "${dbname}" ]] || dbname="restore_$(date -u +%Y%m%d_%H%M%S)"
  [[ "${dbname}" =~ ^[a-z_][a-z0-9_]*$ ]] ||
    pullfm_die "--database must be a bare lowercase identifier, got '${dbname}'"
  pullfm_need pg_restore psql python3

  local tmp t0 t_fetch t_restore
  tmp="$(mktemp -d)"; chmod 700 "${tmp}"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT

  t0="$(pullfm_now_ms)"
  "${ROOT}/infra/backup/pullfm-backup.sh" fetch "${key}" "${tmp}/dump.pgc"
  t_fetch="$(pullfm_now_ms)"

  pullfm_info "creating database ${dbname} on $(pullfm_dsn_redact "${into}")"
  psql "${into}" -X -q -v ON_ERROR_STOP=1 -c "create database ${dbname}" >&2 ||
    pullfm_die "could not create ${dbname}. If it already exists, pick another
name: this command will not restore over a database it did not create."

  local target
  target="$(pullfm_dsn_with_db "${into}" "${dbname}")"

  # NOT --exit-on-error. A managed-Postgres dump restored into another managed
  # Postgres reliably produces a few permission-shaped complaints that change
  # nothing, and aborting on the first one turns a good restore into a failed
  # one. The errors are COUNTED and PRINTED instead, and the thing that decides
  # whether the restore worked is the data, checked by the caller.
  set +e
  pg_restore --dbname="${target}" --no-owner --no-privileges \
    "${tmp}/dump.pgc" 2>"${tmp}/restore.err"
  set -e
  t_restore="$(pullfm_now_ms)"

  local errs
  errs="$(grep -c 'error:' "${tmp}/restore.err" 2>/dev/null || true)"
  errs="${errs:-0}"
  if [[ "${errs}" != "0" ]]; then
    pullfm_warn "pg_restore reported ${errs} error line(s):"
    head -40 "${tmp}/restore.err" >&2
    pullfm_warn "Judge the restore on the data, not on this count, but do not
skip reading it: a missing extension shows up here and nowhere else."
  else
    pullfm_ok "pg_restore completed with no errors"
  fi

  pullfm_info "restored ${key} into database ${dbname}"
  pullfm_info "  fetch+verify+decrypt  $(pullfm_ms_human $((t_fetch - t0)))"
  pullfm_info "  pg_restore            $(pullfm_ms_human $((t_restore - t_fetch)))"
  pullfm_info "  total                 $(pullfm_ms_human $((t_restore - t0)))"
  _after_restore_notice

  # The database NAME on stdout, not the DSN. The caller already holds the
  # credential it passed in; echoing a URL with a password in it into a
  # transcript is a gift to whoever reads the transcript.
  printf '%s\n' "${dbname}"
}

# ---------------------------------------------------------------------------

case "${1:-}" in
  branches) shift; cmd_branches "$@" ;;
  dsn) shift; cmd_dsn "$@" ;;
  restore-point)
    shift
    case "${1:-}" in
      create) shift; cmd_rp_create "$@" ;;
      list)   shift; cmd_rp_list "$@" ;;
      delete) shift; cmd_rp_delete "$@" ;;
      prune)  shift; cmd_rp_prune "$@" ;;
      *) pullfm_die "restore-point: expected create, list, delete or prune" ;;
    esac
    ;;
  pitr) shift; cmd_pitr "$@" ;;
  from-branch) shift; cmd_from_branch "$@" ;;
  from-dump) shift; cmd_from_dump "$@" ;;
  *)
    cat >&2 <<'USAGE'
usage: infra/backup/pullfm-restore.sh <command> [options]

  branches                              list every Neon branch
  dsn <branch> [--pooled]               print a connection string for a branch

  restore-point create <branch> [--label L] [--at TS]
                                        pin a branch's data at now (or at TS).
                                        Prints the new branch id.
  restore-point list                    list pinned restore points
  restore-point delete <id>             delete one (refuses non-rp- branches)
  restore-point prune [--keep N]        keep the newest N (default 4)

  pitr <branch> --at <ts> [--preserve NAME]
                                        restore a branch to a point in its own
                                        6-hour history
  from-branch <branch> --source <b> [--preserve NAME]
                                        reset a branch from a restore point
  from-dump <key> --into <dsn> [--database NAME]
                                        the last-resort path: R2 dump ->
                                        a NEW database -> pg_restore. Nothing
                                        is overwritten. Works with Neon gone.
                                        Prints the new database name.

main (br-curly-wave-as91izv6) is refused as a target unless
PULLFM_ALLOW_PROTECTED=1 is set by hand.

Every restore path leaves one thing undone: replay-deletions. See
infra/backup/pullfm-backup.sh and docs/RUNBOOK-DR.md section 5.
USAGE
    exit 2
    ;;
esac
