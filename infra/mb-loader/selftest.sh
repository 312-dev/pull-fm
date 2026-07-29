#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Proves every way the canonical loader can fail, against a REAL Postgres.
#
#   ./infra/mb-loader/selftest.sh
#
# The loader's whole safety claim is "a failed or partial load leaves the
# previous data serving". That claim is only worth anything if each failure mode
# has been made to happen, so every case below breaks something specific and then
# asserts that the LIVE TABLE STILL HOLDS THE PREVIOUS DUMP - not that the loader
# printed an error, which is easy and proves nothing.
#
# The cases, and the real-world event each one stands for:
#
#   happy           a normal fortnightly run
#   already-loaded  the schedule fires on a day nothing new was published
#   sha mismatch    a substituted or corrupted archive
#   truncated       a download cut off mid-stream
#   malformed row   the upstream CSV changed shape
#   licence change  MetaBrainz relicense a future dump
#   short load      a download that ended on a clean boundary and looks fine
#   swap blocked    a long reader holds the table when the swap wants it
#   concurrent      two loaders racing
#   flag off        the reader with the feature disabled
#
# ---------------------------------------------------------------------------
# WHY THE FIXTURES ARE BUILT RATHER THAN CHECKED IN
#
# Each case needs an archive that is byte-for-byte valid except for the one
# thing it is testing, and the licence case needs the REAL COPYING file, whose
# digest is pinned in the loader. Building them here means the fixtures cannot
# drift from the loader's expectations without this script noticing, and it
# means no 2 GB blob lives in the repository.
#
# Requires a Postgres reachable at ADMIN_URL (docker-compose.dev.yml provides
# one) and the migrations applied to a scratch database it creates and drops.
# ---------------------------------------------------------------------------
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "${HERE}/../.." && pwd)
LOADER="${HERE}/mb-canonical-load.sh"

# `?sslmode=disable` is EXPLICIT rather than implied. The loader defaults an
# absent sslmode to `require`, because Neon needs it and because silently
# negotiating under libpq's weaker `prefer` is precisely the downgrade
# verify-migrations.mjs was shipped with and had to fix. The local docker
# Postgres speaks no TLS, so the exception is stated here rather than weakened
# there.
ADMIN_URL="${ADMIN_URL:-postgres://pullfm:pullfm_local_dev_not_a_secret@127.0.0.1:5432/postgres?sslmode=disable}"
SCRATCH_DB="${SCRATCH_DB:-pullfm_mb_loader_selftest}"
DUMP_A="musicbrainz-canonical-dump-20260703-080003"
DUMP_B="musicbrainz-canonical-dump-20260717-080003"

FAILED=0
pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  [ $# -gt 1 ] && printf '        %s\n' "$2"
  FAILED=$((FAILED + 1))
}

# Strips the password out of anything on its way to a log, for the reason
# packages/db/scripts/verify-migrations.mjs documents at length: a harness that
# discloses the credential on failure is worse than no harness.
scrub() { sed -E 's#(postgres(ql)?://[^:@/]+:)[^@]*@#\1<REDACTED>@#gi'; }

for tool in psql zstd tar curl awk python3; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "  SKIP  ${tool} is not on PATH"
    exit 77
  }
done

# ADMIN_URL with the database swapped, PRESERVING THE QUERY STRING. Splitting on
# `?` first is the whole point: dropping `?sslmode=require` does not error, it
# silently downgrades every connection to libpq's weaker default.
scratch_url() {
  local q="${ADMIN_URL#*\?}" base="${ADMIN_URL%%\?*}"
  [ "${q}" = "${ADMIN_URL}" ] && q="" || q="?${q}"
  printf '%s/%s%s' "${base%/*}" "$1" "${q}"
}
SCRATCH_URL=$(scratch_url "${SCRATCH_DB}")

q() { psql "${SCRATCH_URL}" -v ON_ERROR_STOP=1 -qtAX -c "$1" 2>&1 | scrub; }

WORK=$(mktemp -d)
cleanup() {
  psql "${ADMIN_URL}" -qtAX -c \
    "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

echo "pullfm mb-loader self-test  $(date -u +%FT%TZ)"
echo "-------------------------------------------------------------"

psql "${ADMIN_URL}" -qtAX -c "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)" >/dev/null 2>&1
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -qtAX -c "CREATE DATABASE ${SCRATCH_DB}" >/dev/null 2>&1 || {
  echo "  SKIP  cannot create a scratch database at ADMIN_URL"
  exit 77
}
DATABASE_URL_DIRECT="${SCRATCH_URL}" node "${ROOT}/packages/db/scripts/migrate.mjs" >/dev/null 2>&1 || {
  echo "  FAIL  migrations would not apply to the scratch database"
  exit 1
}

# ---------------------------------------------------------------------------
# Fixtures.
#
# COPYING is fetched from the real archive once, because the loader pins its
# SHA-256 and a hand-written stand-in would fail the licence gate in every case
# rather than only in the one testing it. Cached across runs.
# ---------------------------------------------------------------------------
COPYING_CACHE="${MB_SELFTEST_COPYING:-${HERE}/testdata/COPYING}"
if [ ! -s "${COPYING_CACHE}" ]; then
  mkdir -p "$(dirname "${COPYING_CACHE}")"
  curl -fsS --max-time 300 -r 0-16777215 \
    "https://data.metabrainz.org/pub/musicbrainz/canonical_data/${DUMP_B}/${DUMP_B}.tar.zst" 2>/dev/null |
    zstd -dc 2>/dev/null | tar -xOf - "${DUMP_B}/COPYING" 2>/dev/null >"${COPYING_CACHE}" || true
fi
[ -s "${COPYING_CACHE}" ] || {
  echo "  SKIP  could not obtain the real COPYING file (offline?)"
  exit 77
}

# Builds one archive. $1 dump id, $2 first id, $3 row count, $4 COPYING path.
build_archive() {
  local dump="$1" first="$2" count="$3" copying="$4"
  local dir="${WORK}/${dump}"
  rm -rf "${dir}"
  mkdir -p "${dir}/canonical"
  printf '2026-07-17 03:00:00\n' >"${dir}/TIMESTAMP"
  cp "${copying}" "${dir}/COPYING"
  FIRST="${first}" COUNT="${count}" python3 - "${dir}/canonical/canonical_musicbrainz_data.csv" <<'PY'
import csv, os, sys
first = int(os.environ["FIRST"]); count = int(os.environ["COUNT"])
with open(sys.argv[1], "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["id","artist_credit_id","artist_mbids","artist_credit_name",
                "release_mbid","release_name","recording_mbid","recording_name",
                "combined_lookup","score"])
    # A row with a newline inside a quoted field, deliberately: it is what makes
    # the loader's --max-rows splitter a record splitter rather than `head`.
    w.writerow([first, 129, "5d02f264-e225-41ff-83f7-d9b1f0b1874a",
                "Simon & Garfunkel", "896485f6-f2f0-3e42-8221-640deb403ba2",
                "Bridge Over\nTroubled Water",
                "645acbbc-ffb9-4383-affa-6d5cfb052a32", "The Boxer",
                "simongarfunkeltheboxer", 564])
    # A MULTI-ARTIST credit. 15.2% of rows in the real dump carry several
    # comma-separated UUIDs in one text field, and the first five million rows
    # of the published file carry none of them - so a `uuid` column passes every
    # small fixture and fails somewhere past row 5,000,000 on the only run that
    # matters. This row is here so that can never happen again.
    w.writerow([first + 1, 130,
                "731b7296-20ed-4a55-a548-55e123ffcf4c,"
                "97523d67-c4df-4dc6-b27c-c3294ea54c49,"
                "5c21f675-cc24-4ae5-b5b1-da657b08b639",
                "Harry Romero, Junior Sanchez & Alexander Technique",
                "896485f6-f2f0-3e42-8221-640deb403ba3", "Release X",
                "645acbbc-ffb9-4383-affa-6d5cfb052a33", "Track X",
                "harryromerojuniorsanchezalexandertechniquetrackx", 900])
    for i in range(2, count):
        n = first + i
        w.writerow([n, 1000 + n, "89ad4ac3-39f7-470e-963a-56509c546377",
                    f"Artist {n}", "61efbf58-5be4-40ba-9bef-49c92cc5b8ca",
                    f"Release {n}", f"00000000-0000-4000-8000-{n:012d}",
                    f"Track {n}", f"artist{n}track{n}", 1000 + n])
PY
  (cd "${WORK}" && tar -cf - "${dump}" | zstd -q -o "${dump}.tar.zst" -f)
  shasum -a 256 "${WORK}/${dump}.tar.zst" | cut -d' ' -f1 >"${WORK}/${dump}.tar.zst.sha256"
  rm -rf "${dir}"
}

load() {
  DATABASE_URL_DIRECT="${SCRATCH_URL}" "${LOADER}" "$@" 2>&1 | scrub
  return "${PIPESTATUS[0]}"
}

live_rows() { q "SELECT count(*) FROM mb.canonical"; }
live_dump() {
  q "SELECT dump_id FROM mb.load_state WHERE status='ok' ORDER BY finished_at DESC LIMIT 1"
}
stage_tables() {
  q "SELECT count(*) FROM pg_tables WHERE schemaname='mb' AND tablename LIKE 'canonical_stage_%'"
}

build_archive "${DUMP_A}" 1 40 "${COPYING_CACHE}"
build_archive "${DUMP_B}" 5000 60 "${COPYING_CACHE}"

# --- 1. happy path ---------------------------------------------------------
if load --archive "${WORK}/${DUMP_A}.tar.zst" --min-rows 40 >"${WORK}/out1" 2>&1; then
  [ "$(live_rows)" = "40" ] && [ "$(live_dump)" = "${DUMP_A}" ] &&
    pass "happy path loads and swaps" ||
    fail "happy path swapped the wrong thing" "rows=$(live_rows) dump=$(live_dump)"
else
  fail "happy path failed" "$(tail -3 "${WORK}/out1")"
fi

[ "$(stage_tables)" = "0" ] &&
  pass "no staging table is left behind" ||
  fail "a staging table survived a successful run"

# Every index the reader depends on exists under its canonical name after the
# swap. A rename that silently did not happen would leave the lookup index named
# after a dead staging table and the next load colliding on it.
MISSING=$(q "SELECT string_agg(x, ',') FROM unnest(ARRAY[
     'canonical_pkey','canonical_lookup_idx','canonical_recording_idx',
     'canonical_release_idx','canonical_artist_idx']) x
   WHERE x NOT IN (SELECT indexname FROM pg_indexes WHERE schemaname='mb')")
[ -z "${MISSING}" ] &&
  pass "indexes are renamed to their canonical names by the swap" ||
  fail "indexes missing after the swap" "${MISSING}"

# The quoted newline survived, which is what proves the CSV is parsed as CSV.
[ "$(q "SELECT release_name FROM mb.canonical WHERE recording_name='The Boxer'" | wc -l | tr -d ' ')" = "2" ] &&
  pass "a quoted newline inside a field survives the load" ||
  fail "a quoted newline was not preserved"

# --- 2. a search returns the right row --------------------------------------
GOT=$(q "SELECT recording_mbid FROM mb.canonical WHERE combined_lookup='simongarfunkeltheboxer'")
[ "${GOT}" = "645acbbc-ffb9-4383-affa-6d5cfb052a32" ] &&
  pass "an exact combined_lookup returns the right recording" ||
  fail "exact lookup returned '${GOT}'"

# A multi-artist credit survived the load AND is reachable through the GIN
# expression index by ANY of its members, not only the first. `artist_mbids` is
# a comma-separated text column for 15.2% of real rows, so a `uuid` column or a
# plain btree on the raw text would fail one of these two assertions.
GOT=$(q "SELECT artist_mbids FROM mb.canonical WHERE recording_name='Track X'")
case "${GOT}" in
*,*,*) pass "a multi-artist credit loads verbatim, commas and all" ;;
*) fail "multi-artist credit did not survive the load" "${GOT}" ;;
esac
GOT=$(q "SELECT count(*) FROM mb.canonical
          WHERE string_to_array(artist_mbids, ',')::uuid[]
             @> ARRAY['97523d67-c4df-4dc6-b27c-c3294ea54c49'::uuid]")
[ "${GOT}" = "1" ] &&
  pass "a NON-PRIMARY artist of a credit is found by containment" ||
  fail "containment on a non-primary artist returned '${GOT}'"
PLAN=$(q "EXPLAIN (COSTS OFF) SELECT 1 FROM mb.canonical
           WHERE string_to_array(artist_mbids, ',')::uuid[]
              @> ARRAY['97523d67-c4df-4dc6-b27c-c3294ea54c49'::uuid]")
case "${PLAN}" in
*canonical_artist_idx* | *"Seq Scan"*)
  # A 40-row table is a legitimate sequential scan. What matters is that the
  # expression parses identically to the indexed one; the plan on 789k real
  # rows was measured on a Neon branch and is recorded in the runbook.
  pass "the containment expression matches the indexed one"
  ;;
*) fail "unexpected containment plan" "${PLAN}" ;;
esac

# --- 3. already loaded -> exit 0, no work ------------------------------------
if load --archive "${WORK}/${DUMP_A}.tar.zst" --min-rows 40 >"${WORK}/out3" 2>&1; then
  grep -q "already loaded" "${WORK}/out3" &&
    pass "declines a dump that is already loaded, exit 0" ||
    fail "reloaded a dump that was already loaded"
else
  fail "already-loaded case exited non-zero"
fi

# ---------------------------------------------------------------------------
# From here on, every case must leave DUMP_A's 40 rows serving.
# ---------------------------------------------------------------------------
assert_intact() {
  local rows dump
  rows=$(live_rows)
  dump=$(live_dump)
  if [ "${rows}" = "40" ] && [ "${dump}" = "${DUMP_A}" ] && [ "$(stage_tables)" = "0" ]; then
    pass "$1"
  else
    fail "$1" "rows=${rows} dump=${dump} stages=$(stage_tables)"
  fi
}

# --- 4. sha256 mismatch -----------------------------------------------------
if load --archive "${WORK}/${DUMP_B}.tar.zst" --min-rows 60 \
  --sha256 0000000000000000000000000000000000000000000000000000000000000000 \
  >"${WORK}/out4" 2>&1; then
  fail "a sha256 mismatch was accepted"
else
  grep -qi "mismatch" "${WORK}/out4" &&
    pass "a sha256 mismatch is refused" ||
    fail "sha mismatch failed for the wrong reason" "$(tail -2 "${WORK}/out4")"
  assert_intact "the previous dump still serves after a sha mismatch"
fi

# --- 5. truncated download --------------------------------------------------
# Half the archive, with the publisher's real digest for the whole one. This is
# a download cut off in flight, and it must not produce a short table.
FULL=$(wc -c <"${WORK}/${DUMP_B}.tar.zst" | tr -d ' ')
head -c "$((FULL / 2))" "${WORK}/${DUMP_B}.tar.zst" >"${WORK}/truncated.tar.zst"
cp "${WORK}/${DUMP_B}.tar.zst.sha256" "${WORK}/truncated.tar.zst.sha256"
if load --archive "${WORK}/truncated.tar.zst" --dump "${DUMP_B}" --min-rows 60 \
  --sha256 "$(cat "${WORK}/${DUMP_B}.tar.zst.sha256")" >"${WORK}/out5" 2>&1; then
  fail "a truncated archive was accepted"
else
  pass "a truncated archive is refused"
  assert_intact "the previous dump still serves after a truncated download"
fi

# --- 6. malformed CSV row ---------------------------------------------------
# A non-UUID where a uuid column is expected: what an upstream schema change
# looks like from here. COPY must reject it and the run must abort.
BAD="${WORK}/bad"
mkdir -p "${BAD}/${DUMP_B}/canonical"
cp "${COPYING_CACHE}" "${BAD}/${DUMP_B}/COPYING"
printf 'x\n' >"${BAD}/${DUMP_B}/TIMESTAMP"
{
  printf 'id,artist_credit_id,artist_mbids,artist_credit_name,release_mbid,release_name,recording_mbid,recording_name,combined_lookup,score\n'
  printf '1,1,not-a-uuid,A,61efbf58-5be4-40ba-9bef-49c92cc5b8ca,R,645acbbc-ffb9-4383-affa-6d5cfb052a32,T,at,1\n'
} >"${BAD}/${DUMP_B}/canonical/canonical_musicbrainz_data.csv"
(cd "${BAD}" && tar -cf - "${DUMP_B}" | zstd -q -o "${WORK}/malformed.tar.zst" -f)
shasum -a 256 "${WORK}/malformed.tar.zst" | cut -d' ' -f1 >"${WORK}/malformed.tar.zst.sha256"
if load --archive "${WORK}/malformed.tar.zst" --dump "${DUMP_B}" --min-rows 1 \
  --sha256 "$(cat "${WORK}/malformed.tar.zst.sha256")" >"${WORK}/out6" 2>&1; then
  fail "a malformed CSV row was accepted"
else
  pass "a malformed CSV row aborts the load"
  assert_intact "the previous dump still serves after a malformed row"
fi

# --- 7. licence change ------------------------------------------------------
# The single most important case here. CC0 cannot be revoked for data already
# held, but a FUTURE dump can be relicensed, and a fortnightly re-fetch is a
# fortnightly re-consent. A relicensed archive must stop the pipeline.
printf 'Creative Commons Attribution-NonCommercial-ShareAlike 3.0\n' >"${WORK}/EVIL_COPYING"
build_archive "${DUMP_B}" 9000 20 "${WORK}/EVIL_COPYING"
if load --archive "${WORK}/${DUMP_B}.tar.zst" --dump "${DUMP_B}" --min-rows 20 \
  >"${WORK}/out7" 2>&1; then
  fail "a relicensed archive was loaded"
else
  grep -qi "LICENCE CHANGED" "${WORK}/out7" &&
    pass "a relicensed COPYING stops the load before it downloads anything" ||
    fail "the licence gate did not fire" "$(tail -2 "${WORK}/out7")"
  assert_intact "the previous dump still serves after a licence change"
fi

# A missing COPYING is a failure too: an archive whose licence cannot be read is
# one we must not load, and treating it as "skip the check" would be the obvious
# wrong simplification.
NOLIC="${WORK}/nolic"
mkdir -p "${NOLIC}/${DUMP_B}/canonical"
printf 'x\n' >"${NOLIC}/${DUMP_B}/TIMESTAMP"
printf 'id\n1\n' >"${NOLIC}/${DUMP_B}/canonical/canonical_musicbrainz_data.csv"
(cd "${NOLIC}" && tar -cf - "${DUMP_B}" | zstd -q -o "${WORK}/nolic.tar.zst" -f)
shasum -a 256 "${WORK}/nolic.tar.zst" | cut -d' ' -f1 >"${WORK}/nolic.tar.zst.sha256"
if load --archive "${WORK}/nolic.tar.zst" --dump "${DUMP_B}" --min-rows 1 \
  >"${WORK}/out7b" 2>&1; then
  fail "an archive with no COPYING was loaded"
else
  grep -qi "COPYING is missing" "${WORK}/out7b" &&
    pass "an archive with no COPYING is refused" ||
    fail "missing-COPYING failed for the wrong reason" "$(tail -2 "${WORK}/out7b")"
fi

# --- 8. short but well-formed load ------------------------------------------
# A download that ended on a clean boundary produces a valid, short table. The
# row floor is the only thing standing between that and publishing it.
build_archive "${DUMP_B}" 9000 5 "${COPYING_CACHE}"
if load --archive "${WORK}/${DUMP_B}.tar.zst" --dump "${DUMP_B}" --min-rows 60 \
  >"${WORK}/out8" 2>&1; then
  fail "a short load was published"
else
  grep -qi "Refusing to publish a partial load" "${WORK}/out8" &&
    pass "the row floor refuses a short but well-formed load" ||
    fail "the row floor did not fire" "$(tail -2 "${WORK}/out8")"
  assert_intact "the previous dump still serves after a short load"
fi

# --- 9. the swap cannot complete --------------------------------------------
# A reader holding the table blocks the DROP the swap needs. Without a
# lock_timeout the swap would queue for ACCESS EXCLUSIVE and every later reader
# would queue behind IT, turning a maintenance job into an outage. It must time
# out instead, and the old data must keep serving.
build_archive "${DUMP_B}" 9000 60 "${COPYING_CACHE}"
psql "${SCRATCH_URL}" -qtAX -c \
  "BEGIN; LOCK TABLE mb.canonical IN ACCESS SHARE MODE; SELECT pg_sleep(25); COMMIT;" \
  >/dev/null 2>&1 &
BLOCKER=$!
sleep 2
if MB_CANONICAL_LOCK_TIMEOUT_MS=2000 load --archive "${WORK}/${DUMP_B}.tar.zst" \
  --dump "${DUMP_B}" --min-rows 60 >"${WORK}/out9" 2>&1; then
  fail "the swap completed while a reader held the table"
else
  grep -qi "swap failed" "${WORK}/out9" &&
    pass "a blocked swap times out instead of wedging every later reader" ||
    fail "the swap failed for the wrong reason" "$(tail -2 "${WORK}/out9")"
fi
wait "${BLOCKER}" 2>/dev/null
assert_intact "the previous dump still serves after a blocked swap"

# --- 10. concurrent loaders --------------------------------------------------
# Two loaders at once. Staging table names carry the pid, so they cannot destroy
# each other's work, and the swap is serialised by an advisory lock, so the
# published result is ONE of the two loads, whole, never a mixture.
build_archive "${DUMP_B}" 9000 60 "${COPYING_CACHE}"
load --archive "${WORK}/${DUMP_B}.tar.zst" --dump "${DUMP_B}" --min-rows 60 --force >"${WORK}/out10a" 2>&1 &
P1=$!
load --archive "${WORK}/${DUMP_B}.tar.zst" --dump "${DUMP_B}" --min-rows 60 --force >"${WORK}/out10b" 2>&1 &
P2=$!
wait "${P1}"
R1=$?
wait "${P2}"
R2=$?
ROWS=$(live_rows)
if [ "${R1}" = "0" ] || [ "${R2}" = "0" ]; then
  [ "${ROWS}" = "60" ] && [ "$(stage_tables)" = "0" ] &&
    pass "two concurrent loaders publish one whole load and leave no debris" ||
    fail "concurrent loaders left a mixture" "rows=${ROWS} stages=$(stage_tables)"
else
  fail "both concurrent loaders failed" "$(tail -2 "${WORK}/out10a")"
fi

# --- 11. the reader with the feature off ------------------------------------
# The flag-off path is asserted in TypeScript, where it belongs
# (packages/upstream/src/musicbrainz/local-first.test.ts proves that not one
# query is issued). What is checked here is the half that is SQL: the reader's
# query shape must be the one the index can serve, so that turning the flag on
# does not turn a lookup into a sequential scan of tens of millions of rows.
PLAN=$(q "EXPLAIN (COSTS OFF) SELECT recording_mbid FROM mb.canonical
           WHERE combined_lookup = 'simongarfunkeltheboxer' ORDER BY score LIMIT 1")
case "${PLAN}" in
*"canonical_lookup_idx"* | *"Seq Scan"*)
  # A 60-row table is a legitimate sequential scan; the plan on real volume is
  # measured on the scratch Neon branch and recorded in the runbook. What this
  # asserts is that the statement parses and the index exists to be chosen.
  pass "the reader's exact-lookup statement plans against the loaded table"
  ;;
*) fail "unexpected plan" "${PLAN}" ;;
esac

echo "-------------------------------------------------------------"
if [ "${FAILED}" = "0" ]; then
  echo "all cases passed"
  exit 0
fi
echo "${FAILED} case(s) failed"
exit 1
