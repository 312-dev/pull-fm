#!/usr/bin/env bash
#
# Pull.fm - the Gate 4 restore drill. It destroys data and then gets it back.
#
# ===========================================================================
# THIS IS NOT A DRY RUN AND MUST NOT BECOME ONE
# ===========================================================================
#
# Gate 4 asks for proof that a restore works. The only thing that proves that is
# a restore, so this script writes rows, deletes them for real, restores for
# real, and compares what came back against what went in. Every number in
# docs/RUNBOOK-DR.md section 5 is emitted by this file; none of them is an
# estimate.
#
# It runs against the STAGING branch by default and refuses `main` outright.
#
# ===========================================================================
# THE FIVE THINGS IT MEASURES
# ===========================================================================
#
#   1. RTO of the branch-restore path. Decision to "the database answers".
#   2. RTO of the dump path. Fetch, verify, decrypt, pg_restore.
#   3. RPO of the PITR path, measured by writing rows on either side of a
#      recorded server timestamp and seeing which side survives a restore to it.
#      Not "Neon says arbitrary-second", but which row was actually there.
#   4. Whether the restored data is BYTE-FOR-BYTE what went in, by checksum,
#      not by "the table has rows in it".
#   5. Whether the deletion-replay claim in legal/privacy-policy.md section 7
#      holds. Phase 7 exists to try to falsify it, and on the first run it
#      succeeded. See the comment on phase 7.
#
# ===========================================================================
# USAGE
# ===========================================================================
#
#   infra/backup/restore-drill.sh                # full drill against staging
#   infra/backup/restore-drill.sh --branch NAME  # some other non-protected branch
#   infra/backup/restore-drill.sh --skip-dump    # branch paths only, ~2 min
#   infra/backup/restore-drill.sh --keep         # leave branches for inspection
#
# Everything it creates is named `drill-` or `rp-drill-` and everything it
# creates is removed in phase 9, which verifies the removal rather than assuming
# it. A drill that leaves litter in a ten-branch quota is a drill that stops
# being run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# THE DRILL GETS ITS OWN LEDGER BUCKET, AND IT IS NOT OPTIONAL.
#
# The drill erases a synthetic user, exports the ledger entry, and deletes that
# entry again at cleanup, because a drill uuid left in the ledger makes every
# future `replay-deletions` report a phantom erasure. The real ledger bucket
# carries the bucket lock rule `erasure-ledger-immutable`, which refuses
# DeleteObject outright, so a drill pointed at it CANNOT clean up after itself:
# the delete fails and the drill permanently pollutes a compliance record. This
# bucket is deliberately unlocked so the cleanup can succeed.
#
# SET BEFORE THE SOURCE, WHICH IS THE WHOLE REASON IT IS HERE AND NOT BELOW THE
# ARGUMENT PARSING. backup-common.sh declares the variable `readonly` with a
# `${VAR:-default}` fallback, so an assignment afterwards is not "an override
# that loses to the default", it is a fatal "readonly variable" under `set -e`.
#
# US CUTOVER: this is `pull-fm-ledger-drill-us`, default jurisdiction, ENAM
# location hint, and it is deliberately UNLOCKED for the reason above. The EU
# `pull-fm-ledger-drill` still exists and is the rollback; it is not deleted.
: "${PULLFM_LEDGER_BUCKET:=pull-fm-ledger-drill-us}"
export PULLFM_LEDGER_BUCKET

# shellcheck source=../lib/backup-common.sh
source "${ROOT}/infra/lib/backup-common.sh"

BACKUP="${ROOT}/infra/backup/pullfm-backup.sh"
RESTORE="${ROOT}/infra/backup/pullfm-restore.sh"

TARGET_BRANCH="staging"
SKIP_DUMP=0
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) TARGET_BRANCH="${2:?}"; shift 2 ;;
    --skip-dump) SKIP_DUMP=1; shift ;;
    --keep) KEEP=1; shift ;;
    *) pullfm_die "restore-drill: unknown option $1" ;;
  esac
done

[[ "${TARGET_BRANCH}" != "main" ]] || pullfm_die "the drill will not run against main"

# The drill ledger bucket's credential. The bucket itself is chosen above the
# source; this half needs `pullfm_op_field`, so it has to be after it.
#
# ADDRESSED BY TITLE, AND IT USED TO BE AN ITEM ID. The id here was a live
# finding in `tools/check-public-identifiers.mjs`: a vault item id is a direct
# object reference, so publishing one in a public repository turns any vault
# access from a search problem into a fetch. `op item get` takes either form,
# the title is unambiguous, and the `_US` suffix says which side of the
# residency cutover this credential belongs to.
readonly PULLFM_DRILL_LEDGER_OP_ITEM="${PULLFM_DRILL_LEDGER_OP_ITEM:-pull-fm/staging/R2_DRILL_LEDGER_CREDENTIALS_US}"
if [[ -z "${PULLFM_LEDGER_ACCESS_KEY_ID:-}" ]]; then
  PULLFM_LEDGER_ACCESS_KEY_ID="$(pullfm_op_field "${PULLFM_DRILL_LEDGER_OP_ITEM}" 'access key id')"
  PULLFM_LEDGER_SECRET_ACCESS_KEY="$(pullfm_op_field "${PULLFM_DRILL_LEDGER_OP_ITEM}" 'secret access key')"
  export PULLFM_LEDGER_ACCESS_KEY_ID PULLFM_LEDGER_SECRET_ACCESS_KEY
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; chmod 700 "${WORK}"
REPORT="${WORK}/report.json"
CREATED_BRANCHES=()
LEDGER_KEYS=()

# Cleanup is a trap as well as a phase. A drill that aborts halfway through must
# not leave a branch behind, because the next run then fails on quota and the
# drill quietly stops happening.
_cleanup() {
  local rc=$?
  if [[ ${KEEP} -eq 1 ]]; then
    pullfm_warn "--keep: leaving ${#CREATED_BRANCHES[@]} branch(es) behind:"
    printf '  %s\n' "${CREATED_BRANCHES[@]}" >&2
  elif [[ ${#CREATED_BRANCHES[@]} -gt 0 ]]; then
    local b
    for b in "${CREATED_BRANCHES[@]}"; do
      pullfm_neon DELETE "/branches/${b}" >/dev/null 2>&1 && pullfm_info "cleanup: deleted ${b}" || true
    done
  fi
  rm -rf "${WORK}"
  exit "${rc}"
}
trap _cleanup EXIT

# --- phase timing ------------------------------------------------------------

# Phases and findings accumulate in FILES rather than in shell arrays. A
# multi-line finding cannot survive being flattened into an array and split
# again on whitespace, and a drill whose report loses the interesting sentence
# is worse than no report.
PHASES_FILE="${WORK}/phases.tsv"
FINDINGS_FILE="${WORK}/findings.txt"
: >"${PHASES_FILE}"
: >"${FINDINGS_FILE}"

PHASE_T0=""
PHASE_CUR=""
phase() {
  phase_end
  PHASE_CUR="$1"
  PHASE_T0="$(pullfm_now_ms)"
  printf '\n\033[1;36m== %s ==\033[0m\n' "$1" >&2
}
phase_end() {
  if [[ -n "${PHASE_T0}" ]]; then
    printf '%s\t%s\n' "$(($(pullfm_now_ms) - PHASE_T0))" "${PHASE_CUR}" >>"${PHASES_FILE}"
    PHASE_T0=""
  fi
}

FINDING_COUNT=0
finding() {
  FINDING_COUNT=$((FINDING_COUNT + 1))
  printf '%s\0' "$1" >>"${FINDINGS_FILE}"
  printf '\033[35mFINDING: %s\033[0m\n' "$1" >&2
}

# --- SQL helpers -------------------------------------------------------------

sql() { psql "${DSN}" -X -A -t -q -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'; }
sql1() { sql "$1" | tr -d '[:space:]'; }
sqlf() { psql "${DSN}" -X -q -v ON_ERROR_STOP=1 -f "$1" >&2; }

# The fingerprint of the surviving marker set. A row count proves a restore
# started; a checksum proves it finished with the right bytes. Ordered inside
# the aggregate so it does not depend on scan order.
MARKER_SQL="select coalesce(md5(string_agg(t, '|' order by t)), 'EMPTY') from (
  select u.email::text || '~' || coalesce(u.display_name,'') || '~'
       || coalesce((select string_agg(w.title, ',' order by w.title)
                    from wishlist_items w where w.user_id = u.id), '-') || '~'
       || coalesce((select string_agg(c.provider || ':' || c.provider_account_id, ',' order by c.provider)
                    from user_connections c where c.user_id = u.id), '-') as t
  from users u where u.email::text like 'drill-%'
) s"

# =============================================================================

pullfm_info "Pull.fm restore drill ${RUN_ID}"
pullfm_info "target branch: ${TARGET_BRANCH}"

# --- 0. preflight ------------------------------------------------------------
phase "0. preflight"
pullfm_need psql pg_dump pg_restore openssl aws op python3 curl
pullfm_backup_load_neon
pullfm_backup_load_r2

# THE "IS THIS MAIN" GUARD IS ASKED OF THE CONTROL PLANE, AND IT USED TO BE A
# HARDCODED BRANCH ID.
#
# WHAT WAS WRONG. The line below used to compare TARGET_ID against a literal
# `br-...` belonging to the EU project's default branch. Two things were wrong
# with that and only one of them is about the residency move:
#
#   1. It is a live Neon branch id in a public repository, which addresses a
#      restorable copy of production data through the provider control plane.
#      `tools/check-public-identifiers.mjs` has a detector for exactly this.
#   2. It is pinned to ONE PROJECT. Point this drill at any other project - the
#      US project it now runs against, a scratch project, a future one - and the
#      literal matches nothing, so the guard silently stops guarding while still
#      reading like a safety check. A guard that cannot fire is worse than no
#      guard, because it stops anyone from writing a real one.
#
# WHY THIS SHAPE. `GET /branches` already returns `default` per branch and the
# response is already being parsed, so resolving the target and identifying the
# default branch is one pass over data that was fetched anyway. It costs nothing
# and it is correct on whatever project PULLFM_NEON_PROJECT_ID names.
read -r TARGET_ID TARGET_IS_DEFAULT <<<"$(pullfm_neon GET "/branches" | python3 -c '
import json, sys
want = sys.argv[1]
for b in json.load(sys.stdin)["branches"]:
    if b["id"] == want or b["name"] == want:
        print(b["id"], "yes" if b.get("default") else "no"); break
else:
    sys.exit("no such branch: " + want)
' "${TARGET_BRANCH}")"
[[ "${TARGET_IS_DEFAULT}" == "no" ]] ||
  pullfm_die "${TARGET_BRANCH} (${TARGET_ID}) is the project's DEFAULT branch, which is main.
The drill destroys data and rolls the branch back; it will not do that to main."

DSN="$(pullfm_backup_load_dsn)"
pullfm_info "dsn: $(pullfm_dsn_redact "${DSN}")"
pullfm_info "branch: ${TARGET_BRANCH} = ${TARGET_ID}"

# THE ORIGINAL PARENT, recorded before anything moves it.
#
# A branch restore RE-PARENTS the target: after `from-branch staging --source
# rp-x`, staging's parent IS rp-x, and Neon then refuses to delete rp-x with
# "cannot delete branch that has children". So every branch restore permanently
# consumes branch slots out of a quota of ten unless the target is put back
# under its original parent afterwards. Phase 11 does exactly that, and it can
# only do it because this line ran first.
ORIGINAL_PARENT="$(pullfm_neon GET "/branches/${TARGET_ID}" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["branch"].get("parent_id") or "")')"
[[ -n "${ORIGINAL_PARENT}" ]] ||
  pullfm_die "${TARGET_BRANCH} has no parent, so it is a root branch and phase 11
could not restore its lineage. Point the drill at a child branch."
pullfm_info "original parent: ${ORIGINAL_PARENT} (restored in phase 11)"

# The drill must not run against a branch that already holds rows it did not
# create. Not because it would break, but because phase 5 deletes things and an
# operator who pointed this at the wrong DSN deserves to be stopped.
PRE_USERS="$(sql1 'select count(*) from users')"
if [[ "${PRE_USERS}" != "0" ]]; then
  pullfm_warn "branch already holds ${PRE_USERS} user rows."
  [[ "${PULLFM_DRILL_NONEMPTY:-0}" == "1" ]] || pullfm_die \
    "REFUSING: phase 5 deletes rows and phase 6 rolls the whole branch back.
Set PULLFM_DRILL_NONEMPTY=1 only if losing everything written to this branch
since phase 3 is acceptable."
fi

HIST="$(pullfm_neon GET "" | python3 -c 'import json,sys; print(json.load(sys.stdin)["project"]["history_retention_seconds"])')"
pullfm_info "history_retention_seconds = ${HIST} ($((HIST / 3600))h)"

# --- 1. seed -----------------------------------------------------------------
phase "1. seed the known markers"

cat >"${WORK}/seed.sql" <<'SQL'
begin;
insert into users (id, workos_user_id, email, display_name) values
  ('11111111-1111-4111-8111-111111111111', 'drill_keep_a', 'drill-keep-a@pull.fm.invalid', 'Drill Keep A'),
  ('22222222-2222-4222-8222-222222222222', 'drill_keep_b', 'drill-keep-b@pull.fm.invalid', 'Drill Keep B'),
  ('33333333-3333-4333-8333-333333333333', 'drill_erase_c', 'drill-erase-c@pull.fm.invalid', 'Drill Erase C');

insert into wishlist_items (user_id, recording_mbid, artist_name, title, source, status) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'Marker Artist', 'Marker One',   'manual', 'wanted'),
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 'Marker Artist', 'Marker Two',   'manual', 'wanted'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000003', 'Marker Artist', 'Marker Three', 'manual', 'acquired'),
  ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000004', 'Marker Artist', 'Marker Four',  'manual', 'wanted');

-- Ciphertext-shaped bytes only. The constraint requires more than 28 octets
-- (a GCM nonce plus tag), which is exactly the check that would catch somebody
-- writing a plaintext token into this column, so the drill honours it rather
-- than working around it.
insert into user_connections
  (user_id, provider, provider_account_id, kek_id, wrapped_dek, access_token_ct) values
  ('11111111-1111-4111-8111-111111111111', 'listenbrainz', 'drill-a', 'drill-kek-1',
   decode(repeat('ab', 48), 'hex'), decode(repeat('cd', 64), 'hex')),
  ('33333333-3333-4333-8333-333333333333', 'lastfm', 'drill-c', 'drill-kek-1',
   decode(repeat('ef', 48), 'hex'), decode(repeat('01', 64), 'hex'));
commit;
SQL
sqlf "${WORK}/seed.sql"

MARKER_BEFORE="$(sql1 "${MARKER_SQL}")"
USERS_BEFORE="$(sql1 "select count(*) from users where email::text like 'drill-%'")"
WISH_BEFORE="$(sql1 "select count(*) from wishlist_items")"
CONN_BEFORE="$(sql1 "select count(*) from user_connections")"
pullfm_info "seeded ${USERS_BEFORE} users, ${WISH_BEFORE} wishlist rows, ${CONN_BEFORE} connections"
pullfm_info "marker fingerprint BEFORE = ${MARKER_BEFORE}"

# --- 2. capture the restore point --------------------------------------------
phase "2. capture a restore point"

T_RP="$(pullfm_pg_now "${DSN}")"
RP_ID="$("${RESTORE}" restore-point create "${TARGET_BRANCH}" --label drill | tail -1)"
CREATED_BRANCHES+=("${RP_ID}")
pullfm_info "restore point ${RP_ID} pinned at server time ${T_RP}"

DUMP_KEY=""
if [[ ${SKIP_DUMP} -eq 0 ]]; then
  DUMP_KEY="$("${BACKUP}" dump --kind drill --reason "restore drill ${RUN_ID}" --dsn "${DSN}" | tail -1)"
  pullfm_info "dump: ${DUMP_KEY}"
fi

# --- 3. a legitimate erasure, AFTER the restore point -------------------------
#
# This is the phase that makes the drill worth running. A user asks to be
# deleted at 10:00. At 10:30 somebody breaks the database and it is restored to
# 09:00. What happens to the person who asked to be gone?
phase "3. erase user C the way the application does"

cat >"${WORK}/erase.sql" <<'SQL'
begin;
-- deletion_log FIRST, exactly as apps/bff does it: if everything after this
-- fails there is still a durable record that erasure was requested.
insert into deletion_log (deleted_user_id, requested_at, completed_at, workos_deleted, notes)
values ('33333333-3333-4333-8333-333333333333', now(), now(), true, 'restore drill: legitimate GDPR erasure');
delete from users where id = '33333333-3333-4333-8333-333333333333';
commit;
SQL
sqlf "${WORK}/erase.sql"
T_ERASE="$(pullfm_pg_now "${DSN}")"

C_GONE="$(sql1 "select count(*) from users where id = '33333333-3333-4333-8333-333333333333'")"
[[ "${C_GONE}" == "0" ]] || pullfm_die "erasure did not remove user C"
pullfm_ok "user C erased at ${T_ERASE}; deletion_log has $(sql1 'select count(*) from deletion_log') row(s)"

# Export the ledger, which is the whole point of the ledger existing.
"${BACKUP}" ledger-export --dsn "${DSN}" >/dev/null
LEDGER_KEYS+=("${PULLFM_BACKUP_PREFIX_LEDGER}/33333333-3333-4333-8333-333333333333.json")

# --- 4. RPO probe ------------------------------------------------------------
#
# Written here rather than in its own drill because it needs a live branch with
# a known write history. Two rows either side of a recorded instant; the restore
# in phase 6 is to a DIFFERENT target, so this one gets its own PITR in phase 8.
phase "4. RPO probe: writes on either side of a recorded instant"

sql "insert into wishlist_items (user_id, recording_mbid, artist_name, title) values
  ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001', 'RPO', 'before-the-instant')" >/dev/null
T_RPO="$(pullfm_pg_now "${DSN}")"
sleep 1
sql "insert into wishlist_items (user_id, recording_mbid, artist_name, title) values
  ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000002', 'RPO', 'after-the-instant')" >/dev/null
pullfm_info "instant under test: ${T_RPO}"

# --- 5. the disaster ---------------------------------------------------------
phase "5. destroy the data"

T_DISASTER="$(pullfm_pg_now "${DSN}")"
sql "delete from wishlist_items" >/dev/null
sql "delete from user_connections" >/dev/null
sql "delete from users" >/dev/null
POST_DISASTER_USERS="$(sql1 'select count(*) from users')"
POST_DISASTER_MARKER="$(sql1 "${MARKER_SQL}")"
[[ "${POST_DISASTER_USERS}" == "0" ]] || pullfm_die "the disaster did not destroy anything, which is its own bug"
pullfm_warn "users=0, wishlist=0, connections=0. Marker fingerprint is now ${POST_DISASTER_MARKER}"

# --- 6. restore --------------------------------------------------------------
phase "6. restore from the pinned branch"

RTO_T0="$(pullfm_now_ms)"
PRESERVE="drill-preserved-${RUN_ID}"
"${RESTORE}" from-branch "${TARGET_BRANCH}" --source "${RP_ID}" --preserve "${PRESERVE}" >/dev/null
# The preserved copy of the destroyed state is itself a branch and counts
# against the quota, so it is tracked for cleanup like everything else.
PRESERVED_ID="$(pullfm_neon GET "/branches" | python3 -c '
import json, sys
for b in json.load(sys.stdin)["branches"]:
    if b["name"] == sys.argv[1]:
        print(b["id"]); break
' "${PRESERVE}")"
[[ -z "${PRESERVED_ID}" ]] || CREATED_BRANCHES+=("${PRESERVED_ID}")

# RTO does not end when the control plane says ready. It ends when a client can
# run a query, which is a different moment and the only one users experience.
# This loop is deliberately inside the measurement.
RECONNECT_TRIES=0
until psql "${DSN}" -X -A -t -q -v ON_ERROR_STOP=1 -c 'select 1' >/dev/null 2>&1; do
  RECONNECT_TRIES=$((RECONNECT_TRIES + 1))
  ((RECONNECT_TRIES < 60)) || pullfm_die "the branch never became connectable after the restore"
  sleep 1
done
RTO_MS=$(($(pullfm_now_ms) - RTO_T0))
pullfm_ok "RTO (decision -> first successful query): $(pullfm_ms_human ${RTO_MS})"
pullfm_info "  reconnect attempts after control-plane ready: ${RECONNECT_TRIES}"

if [[ ${RECONNECT_TRIES} -eq 0 ]]; then
  pullfm_info "the connection string survived the restore unchanged, as documented"
else
  finding "the connection string needed ${RECONNECT_TRIES}s of retries after a branch restore"
fi

# --- 7. verify ---------------------------------------------------------------
phase "7. verify what came back"

MARKER_AFTER="$(sql1 "${MARKER_SQL}")"
USERS_AFTER="$(sql1 "select count(*) from users where email::text like 'drill-%'")"
WISH_AFTER="$(sql1 'select count(*) from wishlist_items')"
CONN_AFTER="$(sql1 'select count(*) from user_connections')"
DL_AFTER="$(sql1 'select count(*) from deletion_log')"
C_PRESENT="$(sql1 "select count(*) from users where id = '33333333-3333-4333-8333-333333333333'")"
C_IN_LOG="$(sql1 "select count(*) from deletion_log where deleted_user_id = '33333333-3333-4333-8333-333333333333'")"

pullfm_info "marker fingerprint AFTER  = ${MARKER_AFTER}"
pullfm_info "users ${USERS_BEFORE} -> ${USERS_AFTER}, wishlist ${WISH_BEFORE} -> ${WISH_AFTER}, connections ${CONN_BEFORE} -> ${CONN_AFTER}"

DATA_OK=0
if [[ "${MARKER_AFTER}" == "${MARKER_BEFORE}" ]]; then
  pullfm_ok "the restored marker set is byte-identical to what was seeded"
  DATA_OK=1
else
  pullfm_warn "marker fingerprint MISMATCH: ${MARKER_BEFORE} -> ${MARKER_AFTER}"
  sql "select email, display_name from users where email::text like 'drill-%' order by email" >&2
fi

# ---------------------------------------------------------------------------
# THE CLAIM UNDER TEST
#
# legal/privacy-policy.md section 7 and docs/api/deletion-and-backups.md both
# say: "a restore replays the deletions", with deletion_log as the authoritative
# replay list. Phase 3 erased user C AFTER the restore point. So after a restore
# to that point, either:
#
#   C is absent, or the replay list still knows about C   -> claim survives
#   C is back AND deletion_log has forgotten C            -> claim is false
#
# and there is no third option, because deletion_log is a table inside the
# database that was just rolled back.
# ---------------------------------------------------------------------------
REPLAY_CLAIM="unknown"
if [[ "${C_PRESENT}" != "0" && "${C_IN_LOG}" == "0" ]]; then
  REPLAY_CLAIM="falsified"
  finding "RESTORE RESURRECTED AN ERASED USER AND LOST THE RECORD OF THE ERASURE.
  users still contains 33333333-... (the account that asked to be deleted)
  deletion_log contains ${DL_AFTER} row(s) and none of them is that account
  The replay list lives in the database being restored, so a rollback past an
  erasure rolls back the erasure and its own evidence at the same time. The
  in-database replay list cannot make an erasure durable across a restore, and
  the privacy policy's commitment is not satisfiable by deletion_log alone."
elif [[ "${C_PRESENT}" == "0" ]]; then
  REPLAY_CLAIM="held-user-absent"
  pullfm_ok "the erased user did not come back"
else
  REPLAY_CLAIM="held-log-survived"
  pullfm_ok "the erased user came back but deletion_log still names them"
fi

# --- 8. the out-of-band ledger, which is the fix -----------------------------
phase "8. replay deletions from the R2 ledger"

REPLAYED="$("${BACKUP}" replay-deletions --dsn "${DSN}" | tail -1)"
C_AFTER_REPLAY="$(sql1 "select count(*) from users where id = '33333333-3333-4333-8333-333333333333'")"
C_LOG_AFTER_REPLAY="$(sql1 "select count(*) from deletion_log where deleted_user_id = '33333333-3333-4333-8333-333333333333'")"

LEDGER_OK=0
if [[ "${C_AFTER_REPLAY}" == "0" && "${C_LOG_AFTER_REPLAY}" != "0" ]]; then
  LEDGER_OK=1
  pullfm_ok "replay removed the resurrected account and rebuilt its deletion_log row"
else
  finding "THE LEDGER REPLAY DID NOT REPAIR THE RESTORE.
  users rows for the erased id: ${C_AFTER_REPLAY} (want 0)
  deletion_log rows for it:     ${C_LOG_AFTER_REPLAY} (want >=1)"
fi

# And the markers that were supposed to survive must still be there afterwards.
# A replay that fixes the erasure by deleting everything is not a fix.
MARKER_AFTER_REPLAY="$(sql1 "select coalesce(md5(string_agg(t, '|' order by t)), 'EMPTY') from (
  select u.email::text || '~' || coalesce(u.display_name,'') as t
  from users u where u.email::text like 'drill-keep-%'
) s")"
KEEP_COUNT="$(sql1 "select count(*) from users where email::text like 'drill-keep-%'")"
[[ "${KEEP_COUNT}" == "2" ]] ||
  finding "the replay removed accounts it should not have: drill-keep-* is now ${KEEP_COUNT}, want 2"

# --- 9. PITR and the measured RPO --------------------------------------------
phase "9. PITR to a recorded instant, and the measured RPO"

# The branch restore in phase 6 rolled the RPO probe rows away with everything
# else, so they are re-created here against the current head and then restored
# to the instant between them.
sql "insert into wishlist_items (user_id, recording_mbid, artist_name, title) values
  ('11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000001', 'RPO', 'before-the-instant')" >/dev/null
T_RPO="$(pullfm_pg_now "${DSN}")"
sleep 1
sql "insert into wishlist_items (user_id, recording_mbid, artist_name, title) values
  ('11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000002', 'RPO', 'after-the-instant')" >/dev/null

PITR_T0="$(pullfm_now_ms)"
PITR_PRESERVE="drill-pitr-${RUN_ID}"
"${RESTORE}" pitr "${TARGET_BRANCH}" --at "${T_RPO}" --preserve "${PITR_PRESERVE}" >/dev/null
PITR_PRESERVED_ID="$(pullfm_neon GET "/branches" | python3 -c '
import json, sys
for b in json.load(sys.stdin)["branches"]:
    if b["name"] == sys.argv[1]:
        print(b["id"]); break
' "${PITR_PRESERVE}")"
[[ -z "${PITR_PRESERVED_ID}" ]] || CREATED_BRANCHES+=("${PITR_PRESERVED_ID}")

until psql "${DSN}" -X -A -t -q -c 'select 1' >/dev/null 2>&1; do sleep 1; done
PITR_MS=$(($(pullfm_now_ms) - PITR_T0))

RPO_BEFORE="$(sql1 "select count(*) from wishlist_items where recording_mbid = 'cccccccc-0000-4000-8000-000000000001'")"
RPO_AFTER="$(sql1 "select count(*) from wishlist_items where recording_mbid = 'cccccccc-0000-4000-8000-000000000002'")"
pullfm_info "PITR to ${T_RPO} took $(pullfm_ms_human ${PITR_MS})"
pullfm_info "  row written BEFORE the instant present: ${RPO_BEFORE} (want 1)"
pullfm_info "  row written AFTER  the instant present: ${RPO_AFTER} (want 0)"

RPO_VERDICT="exact"
if [[ "${RPO_BEFORE}" != "1" ]]; then
  RPO_VERDICT="lost-committed-write"
  finding "PITR to a recorded server timestamp LOST a transaction that had
  already committed before that timestamp. RPO is worse than the target instant."
elif [[ "${RPO_AFTER}" != "0" ]]; then
  RPO_VERDICT="restored-too-much"
  finding "PITR to a recorded server timestamp kept a write made AFTER it.
  The target is not honoured to the second, so a restore to just before a bad
  write may still include the bad write."
else
  pullfm_ok "PITR honoured the target to the second: the write before it survived, the write after it did not"
fi

# --- 10. the dump path -------------------------------------------------------
DUMP_RTO_MS=0
DUMP_VERDICT="skipped"
if [[ ${SKIP_DUMP} -eq 0 && -n "${DUMP_KEY}" ]]; then
  phase "10. the dump path: restore R2 -> a scratch branch"

  # NOT into the target branch, and not over any existing database. The dump
  # path is the one that exists for "Neon is gone", so the closest available
  # approximation is a branch with no drill data, plus a database created from
  # template1 inside it. That target has no extensions and no schema, which is
  # the only configuration that actually tests whether the dump is complete.
  SCRATCH_ID="$("${RESTORE}" restore-point create "${TARGET_BRANCH}" --label drill-dumptarget | tail -1)"
  CREATED_BRANCHES+=("${SCRATCH_ID}")

  # A restore point has no compute, so give this one an endpoint to restore into.
  pullfm_neon POST "/endpoints" "$(python3 -c '
import json, sys
print(json.dumps({"endpoint": {"branch_id": sys.argv[1], "type": "read_write"}}))' "${SCRATCH_ID}")" >/dev/null
  pullfm_neon_wait_ready "${SCRATCH_ID}" >/dev/null
  SCRATCH_DSN="$("${RESTORE}" dsn "${SCRATCH_ID}")"

  DUMP_T0="$(pullfm_now_ms)"
  RESTORED_DB="$("${RESTORE}" from-dump "${DUMP_KEY}" --into "${SCRATCH_DSN}" | tail -1)"
  DUMP_RTO_MS=$(($(pullfm_now_ms) - DUMP_T0))
  RESTORED_DSN="$(pullfm_dsn_with_db "${SCRATCH_DSN}" "${RESTORED_DB}")"

  # Extensions are checked explicitly, because their absence is exactly the
  # defect a Neon-branch-shaped test cannot see.
  SCRATCH_EXT="$(psql "${RESTORED_DSN}" -X -A -t -q -c \
    "select string_agg(extname, ',' order by extname) from pg_extension where extname <> 'plpgsql'" | tr -d '[:space:]')"
  pullfm_info "extensions in the restored database: ${SCRATCH_EXT:-NONE}"
  [[ "${SCRATCH_EXT}" == "citext,pg_trgm,pgcrypto,unaccent" ]] ||
    finding "the restored database has extensions '${SCRATCH_EXT:-NONE}',
  not the four this schema requires (citext, pg_trgm, pgcrypto, unaccent).
  A dump that does not carry its extensions cannot be restored anywhere except
  a database that already has them, which is not what a dump is for."

  SCRATCH_MARKER="$(psql "${RESTORED_DSN}" -X -A -t -q -v ON_ERROR_STOP=1 -c "${MARKER_SQL}" | tr -d '[:space:]')"
  if [[ "${SCRATCH_MARKER}" == "${MARKER_BEFORE}" ]]; then
    DUMP_VERDICT="identical"
    pullfm_ok "the dump restored byte-identical markers in $(pullfm_ms_human ${DUMP_RTO_MS})"
  else
    DUMP_VERDICT="mismatch"
    finding "the R2 dump restored a DIFFERENT marker set than was seeded:
  seeded:   ${MARKER_BEFORE}
  restored: ${SCRATCH_MARKER}"
  fi
fi

# --- 11. clean up ------------------------------------------------------------
phase "11. clean up and prove it"

sql "delete from users where email::text like 'drill-%'" >/dev/null
sql "delete from wishlist_items where artist_name in ('Marker Artist','RPO')" >/dev/null
sql "delete from deletion_log where deleted_user_id = '33333333-3333-4333-8333-333333333333'" >/dev/null

# Ledger entries for drill users are removed too. The ledger is append-only for
# real erasures; a drill uuid left in it would make every future replay report a
# phantom erasure, and a signal nobody believes is worse than no signal.
#
# VERIFIED RATHER THAN SWALLOWED. The previous version ended in `|| true`, which
# is the reason this is worth commenting on: the drill bucket is unlocked
# precisely so these deletes succeed, so a failure here means the drill is
# pointed at a LOCKED bucket, which is the one case where the pollution is
# permanent. Reporting it as a finding is the difference between noticing and
# not; it stays non-fatal because the drill's other results are still valid.
for k in "${LEDGER_KEYS[@]}"; do
  pullfm_s3 delete-object --bucket "${PULLFM_LEDGER_BUCKET}" --key "${k}" >/dev/null 2>&1 ||
    finding "could not delete drill ledger entry ${k} from ${PULLFM_LEDGER_BUCKET}; if that bucket is lock-protected the entry is now permanent and replay-deletions will report a phantom erasure"
done

LEFT_USERS="$(sql1 "select count(*) from users where email::text like 'drill-%'")"
LEFT_WISH="$(sql1 "select count(*) from wishlist_items")"
[[ "${LEFT_USERS}" == "0" ]] || finding "cleanup left ${LEFT_USERS} drill users behind"

# Branches, deleted here rather than only in the trap so the deletion can be
# verified while the report is still being written.
#
# ORDER MATTERS AND IT IS NOT OBVIOUS. The drill's branches end up in a chain
# with the target in the middle of it:
#
#   main -> drill-preserved -> rp-drill -> drill-pitr -> staging -> dumptarget
#
# Neon refuses to delete a branch that has children, AND refuses to re-parent a
# branch that has children without preserve_under_name (which would create yet
# another branch). So:
#
#   1. delete every LEAF first, which clears the dump target hanging off the
#      target branch,
#   2. THEN re-parent the target back onto its original parent, which is only
#      possible once it has no children of its own,
#   3. THEN delete the now-childless chain of ancestors, leaf-first, repeatedly.
#
# Getting this wrong does not corrupt anything, it just silently consumes the
# ten-branch quota until the next drill cannot create a restore point at all.
_delete_pass() {
  local passes="${1:-4}" pass b
  for ((pass = 0; pass < passes; pass++)); do
    local -a remaining=()
    for b in "${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}"; do
      if pullfm_neon_soft DELETE "/branches/${b}" >/dev/null 2>/dev/null; then
        pullfm_info "  deleted ${b}"
      else
        remaining+=("${b}")
      fi
    done
    CREATED_BRANCHES=("${remaining[@]+"${remaining[@]}"}")
    [[ ${#CREATED_BRANCHES[@]} -gt 0 ]] || return 0
    sleep 5
  done
}

if [[ ${KEEP} -eq 0 ]]; then
  CREATED_COUNT=${#CREATED_BRANCHES[@]}

  pullfm_info "step 1: delete leaves"
  _delete_pass 2

  pullfm_info "step 2: restore lineage ${TARGET_BRANCH} -> ${ORIGINAL_PARENT}"
  # Retried, and NOT silenced. The Neon control plane rejects a restore while
  # another operation on the same branch is still settling, and an earlier
  # version swallowed that with `|| true`, which left the whole chain
  # undeletable and the failure invisible.
  LINEAGE_OK=0
  for _try in 1 2 3; do
    if "${RESTORE}" from-branch "${TARGET_BRANCH}" --source "${ORIGINAL_PARENT}" \
      >/dev/null 2>"${WORK}/lineage.err"; then
      LINEAGE_OK=1
      break
    fi
    pullfm_warn "lineage reset attempt ${_try} failed:"
    tail -3 "${WORK}/lineage.err" >&2
    sleep 8
  done
  [[ ${LINEAGE_OK} -eq 1 ]] ||
    finding "could not re-parent ${TARGET_BRANCH} onto ${ORIGINAL_PARENT}. The
  drill branches below cannot be deleted and are occupying slots in a quota of
  ten. Re-parent by hand and then delete them leaf-first."

  pullfm_info "step 3: delete the chain"
  _delete_pass 5

  if [[ ${#CREATED_BRANCHES[@]} -gt 0 ]]; then
    finding "these drill branches were not deleted: ${CREATED_BRANCHES[*]}
  Neon refuses to delete a branch that still has children. Check
  \`infra/backup/pullfm-restore.sh branches\` and delete leaf-first by hand;
  they count against a quota of ten."
  else
    pullfm_ok "all ${CREATED_COUNT} drill branch(es) confirmed gone"
  fi
fi

FINAL_BRANCHES="$(pullfm_neon GET "/branches" | python3 -c '
import json, sys
print(", ".join(b["name"] for b in json.load(sys.stdin)["branches"]))')"
pullfm_info "branches now: ${FINAL_BRANCHES}"

phase_end

# --- report ------------------------------------------------------------------

python3 - "${REPORT}" "${PHASES_FILE}" "${FINDINGS_FILE}" "${RUN_ID}" \
  "${TARGET_BRANCH}" "${TARGET_ID}" "${HIST}" "${MARKER_BEFORE}" "${MARKER_AFTER}" \
  "${DATA_OK}" "${RTO_MS}" "${RECONNECT_TRIES}" "${PITR_MS}" "${RPO_VERDICT}" \
  "${RPO_BEFORE}" "${RPO_AFTER}" "${REPLAY_CLAIM}" "${LEDGER_OK}" "${REPLAYED}" \
  "${DUMP_KEY}" "${DUMP_RTO_MS}" "${DUMP_VERDICT}" "${FINAL_BRANCHES}" <<'PY'
import datetime, json, sys
(out, phases_file, findings_file, run_id, branch, branch_id, hist,
 marker_before, marker_after, data_ok, rto_ms, reconnects, pitr_ms, rpo_verdict,
 rpo_before, rpo_after, replay_claim, ledger_ok, replayed,
 dump_key, dump_ms, dump_verdict, branches_after) = sys.argv[1:24]

phases = []
for line in open(phases_file):
    if "\t" in line:
        ms, name = line.rstrip("\n").split("\t", 1)
        phases.append({"name": name, "ms": int(ms)})

findings = [f for f in open(findings_file).read().split("\0") if f.strip()]

report = {
    "run_id": run_id, "branch": branch, "branch_id": branch_id,
    "history_retention_seconds": int(hist),
    "marker_before": marker_before, "marker_after": marker_after,
    "data_identical": data_ok == "1",
    "branch_restore_rto_ms": int(rto_ms),
    "reconnect_retries_after_restore": int(reconnects),
    "pitr_ms": int(pitr_ms),
    "rpo_verdict": rpo_verdict,
    "rpo_row_before_instant_present": int(rpo_before),
    "rpo_row_after_instant_present": int(rpo_after),
    "deletion_replay_claim": replay_claim,
    "ledger_replay_repaired": ledger_ok == "1",
    "ledger_entries_replayed": int(replayed or 0),
    "dump_key": dump_key or None,
    "dump_restore_rto_ms": int(dump_ms),
    "dump_verdict": dump_verdict,
    "branches_after": branches_after,
    "phases": phases,
    "findings": findings,
    "completed_at": datetime.datetime.now(datetime.timezone.utc)
                     .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
json.dump(report, open(out, "w"), indent=2, sort_keys=True)

print("\n== DRILL REPORT ==", file=sys.stderr)
rows = [
    ("branch restore RTO (decision -> first query)", "%.1f s" % (report["branch_restore_rto_ms"] / 1000)),
    ("PITR restore", "%.1f s" % (report["pitr_ms"] / 1000)),
    ("dump restore (fetch+verify+decrypt+pg_restore)",
     "skipped" if report["dump_restore_rto_ms"] == 0 else "%.1f s" % (report["dump_restore_rto_ms"] / 1000)),
    ("restored data identical to seed", "YES" if report["data_identical"] else "NO"),
    ("RPO verdict", report["rpo_verdict"]),
    ("deletion-replay claim", report["deletion_replay_claim"]),
    ("R2 ledger repaired it", "YES" if report["ledger_replay_repaired"] else "NO"),
]
w = max(len(r[0]) for r in rows)
for k, v in rows:
    print("  %-*s  %s" % (w, k, v), file=sys.stderr)
print("\n  phases:", file=sys.stderr)
for ph in phases:
    print("  %8.1f s  %s" % (ph["ms"] / 1000, ph["name"]), file=sys.stderr)
if findings:
    print("\n  %d finding(s):" % len(findings), file=sys.stderr)
    for f in findings:
        print("    - " + f.replace("\n", "\n      "), file=sys.stderr)
PY

# The report goes to R2 under the drill prefix, which has its own 14 day expiry
# rule. It is evidence that the drill ran and what it found, and evidence that
# only exists on the laptop of whoever ran it is not evidence.
REPORT_KEY="${PULLFM_BACKUP_PREFIX_DRILL}/${RUN_ID}-report.json"
pullfm_s3 put-object --bucket "${PULLFM_BACKUP_BUCKET}" --key "${REPORT_KEY}" \
  --body "${REPORT}" --content-type application/json >/dev/null
pullfm_info "report: s3://${PULLFM_BACKUP_BUCKET}/${REPORT_KEY}"
cat "${REPORT}"

# Exit non-zero if the drill did not prove what it exists to prove. The findings
# about the deletion-replay claim are DELIBERATELY not failures: they are the
# drill working. A drill that exits 1 when it discovers something is a drill
# people stop running.
if [[ "${DATA_OK}" != "1" ]]; then
  pullfm_die "THE DRILL FAILED: restored data does not match what was seeded."
fi
if [[ ${SKIP_DUMP} -eq 0 && "${DUMP_VERDICT}" == "mismatch" ]]; then
  pullfm_die "THE DRILL FAILED: the R2 dump does not restore to what was dumped."
fi
pullfm_ok "drill complete"
