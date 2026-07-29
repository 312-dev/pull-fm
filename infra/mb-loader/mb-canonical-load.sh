#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Loads the MusicBrainz canonical data dump into the `mb` schema.
#
#   DATABASE_URL_DIRECT=postgres://... ./infra/mb-loader/mb-canonical-load.sh
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS: COLD LOOKUPS CURRENTLY RETURN NOTHING
#
# MusicBrainz permits ONE REQUEST PER SECOND for the entire service, per IP, as a
# licence condition. That ceiling is why the request path is not allowed to call
# it, and it does not: every MusicBrainz read in the BFF goes through
# `CachedUpstream.peek`, which reads the cache table and never calls out. Only
# the background warmer fetches, from its own process.
#
# So a peek miss is not slow, it is EMPTY: the item is dropped and the user is
# shown nothing until the warmer happens to reach that MBID. Working through a
# catalogue of tens of millions of recordings at one request per second, the
# warmer can cover a working set and never a catalogue.
#
# The table this script loads turns that miss into an answer. It is not a rate
# limiting fix and must not be described as one - there is nothing on the request
# path to rate limit. It is what makes a cold lookup produce an answer at all,
# and, as a by-product, what makes "is this MBID real" a local index probe.
#
# ---------------------------------------------------------------------------
# CC0, AND WHY IT MUST STAY THAT WAY
#
# The CANONICAL DUMP is CC0 1.0 Universal, verified by extracting COPYING from
# inside the archive rather than read off a web page.
#
# The archive that must never be loaded here is mbdump-derived.tar.bz2 and the
# LIVE DATA FEED, which carry CC BY-NC-SA 3.0 US because they contain the
# supplementary tables - tags, ratings, and the artist-to-genre ASSOCIATIONS.
# Loading either would attach attribution, NonCommercial and ShareAlike
# obligations to this database and to everything derived from it, permanently.
# See docs/compliance/metabrainz-terms-review.md finding F5.
#
# Two precisions, because both are easy to get backwards and this file is where
# somebody will come to check:
#
#   - mbdump.tar.bz2, the core full export, IS CC0. It ships the byte-identical
#     COPYING. It is not loaded here because it is far larger and carries no
#     pre-normalised lookup key, not because of its licence.
#   - GENRES are core CC0 data; "tags (including genre associations)" are
#     supplementary and are not. So the genre VOCABULARY is free and the
#     artist-to-genre ASSOCIATIONS are not, which makes the free half the
#     useless half: knowing "shoegaze" exists tells a discovery product nothing
#     without knowing which artists are shoegaze.
#
# This script never touches musicbrainz.org. It reads data.metabrainz.org, which
# is a static file host and is not the rate-limited web service, so running it
# spends none of the 1 req/s budget it exists to protect. It needs NO ACCESS
# TOKEN: the dumps are served anonymously at HTTP 200. Only the Live Data Feed
# requires one, which is a second reason not to reach for the Feed.
#
# ---------------------------------------------------------------------------
# THE LICENCE IS RE-VERIFIED ON EVERY RUN, BY DIGEST
#
# CC0 is a public-domain DEDICATION rather than a contract, so it cannot be
# revoked for data already obtained. But MetaBrainz can relicense FUTURE dumps,
# and because this job re-fetches fortnightly it is effectively re-consenting
# fortnightly. A silent licence change would be invisible - the archive would
# still download, still parse, and still load, and the database would quietly
# acquire obligations nobody agreed to.
#
# So the archive's own COPYING is extracted and its SHA-256 compared against a
# pinned value on every load, and a mismatch is a hard failure rather than a
# warning. The pin is evidence rather than boilerplate because MetaBrainz applies
# licences SELECTIVELY PER ARCHIVE:
#
#   canonical dump          COPYING 6,390 bytes  75f3c90d...  CC0 1.0
#   mbdump.tar.bz2          COPYING 6,390 bytes  75f3c90d...  CC0 1.0 (identical)
#   mbdump-derived.tar.bz2  COPYING 15,818 bytes 011e1a16...  CC BY-NC-SA 3.0 US
#
# The CC0 file appearing in this archive is therefore a deliberate act by the
# publisher, not a repository-wide default that happens to be inherited.
#
# ---------------------------------------------------------------------------
# WHAT MAKES IT SAFE TO RUN
#
# It NEVER MUTATES THE LIVE TABLE. Everything is built in a staging table
# private to this run, and the live table is replaced by a rename inside ONE
# transaction. A failure at any point before that transaction commits leaves the
# previous data serving, untouched, because nothing before that point wrote to
# it. There is no "midway" to be interrupted in.
#
#   1. discover the newest dump, or take the one named on the command line
#   2. fetch the publisher's .sha256 and reject anything not 64 hex characters
#   3. DECLINE EARLY, exit 0, when mb.load_state already records this dump. One
#      indexed read, and it comes before anything bulk is fetched so that a
#      daily schedule costs a directory listing rather than 32 MiB
#   4. VERIFY THE LICENCE: pull COPYING out of the archive and check its digest
#   5. create mb.canonical_stage_<pid>_<epoch>, private to this run
#   6. stream: curl -> tee(sha256) -> zstd -dc -> tar -xO -> COPY
#      the 7.5 GB CSV is never written to disk; only bytes in flight exist
#   7. VERIFY THE SHA-256 BEFORE THE SWAP. A mismatch aborts with the staging
#      table dropped and the live table untouched
#   8. sanity-check the row count against --min-rows
#   9. build indexes and ANALYZE, on a table nothing is reading
#  10. swap inside one transaction, under an advisory lock and a lock_timeout
#  11. record the outcome, with measured sizes, in mb.load_state
#
# The order of 5 and 6 is a deliberate trade worth being explicit about. The
# alternative - download the whole 2.3 GB archive, verify it, and only then load
# - needs 2.3 GB of scratch disk on the job host and makes the checksum a
# precondition of PARSING. This orders it the other way: untrusted bytes are
# parsed into a staging table no reader can see, and the checksum is a
# precondition of PUBLISHING. Corrupt or substituted data cannot reach a reader
# either way, and the failure costs a dropped table rather than a disk.
# `--archive` restores the stricter order for anyone who prefers it: a local file
# is verified in full before a single row is parsed.
#
# ---------------------------------------------------------------------------
# EXIT CODES, which the refresh job maps straight through
#
#   0  loaded and swapped, or declined because nothing new was published
#   1  could not run and changed nothing. The alert-worthy case.
# ---------------------------------------------------------------------------
set -uo pipefail

BASE_URL="${MB_CANONICAL_BASE_URL:-https://data.metabrainz.org/pub/musicbrainz/canonical_data}"
DUMP_ID=""
ARCHIVE=""
EXPECTED_SHA=""
MAX_ROWS=""
MIN_ROWS="${MB_CANONICAL_MIN_ROWS:-20000000}"
WITH_TRGM=0
FORCE=0
DRY_RUN=0
LOCK_TIMEOUT_MS="${MB_CANONICAL_LOCK_TIMEOUT_MS:-15000}"

usage() {
  cat <<'EOF'
mb-canonical-load.sh - load the MusicBrainz canonical dump into schema mb

  DATABASE_URL_DIRECT=postgres://... ./infra/mb-loader/mb-canonical-load.sh

Options:
  --dump ID          load this dump directory instead of the newest
  --archive PATH     load a local .tar.zst, verified in full before parsing
  --sha256 HEX       expected digest (default: the publisher's .sha256 sibling)
  --base-url URL     override the canonical_data directory
  --max-rows N       stop after N data rows. For size-capped environments and
                     for the self-test; implies --min-rows N
  --min-rows N       fail if fewer rows landed (default 20000000)
  --with-trgm        also build the pg_trgm GIN index on combined_lookup
  --force            reload even when this dump is already loaded
  --dry-run          discover and report, change nothing
  -h, --help         this text
EOF
}

# Never interpolates a connection string. The only values that reach a log line
# are dump ids, digests, row counts and byte sizes.
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# THE REASON IS KEPT, NOT JUST THE EXIT CODE.
#
# The EXIT trap used to write a fixed 'loader exited 1; see job logs' into
# mb.load_state.error, which is what the first real end-to-end attempt against
# staging left behind: one 'failed' row, 29 minutes long, saying nothing about
# what went wrong. The job logs it points at are a systemd journal on one node
# with its own retention, so by the time anybody reads the table the reason is
# routinely gone. `die` therefore stashes its message here and the trap records
# THAT, which makes mb.load_state self-contained: the table that says a load
# failed also says why.
LAST_ERROR=""
die() {
  LAST_ERROR="$*"
  log "FATAL: $*"
  exit 1
}

# Single quotes doubled, and truncated, because this string is interpolated into
# an UPDATE. Nothing in a die message is attacker-controlled today - they are
# built from dump ids, digests and exit codes - but the escape is here so that
# stays true if a future message ever includes a server error string.
sql_lit() { printf '%s' "${1:0:800}" | sed "s/'/''/g"; }

while [ $# -gt 0 ]; do
  case "$1" in
  --dump)
    DUMP_ID="${2:-}"
    shift 2
    ;;
  --archive)
    ARCHIVE="${2:-}"
    shift 2
    ;;
  --sha256)
    EXPECTED_SHA="${2:-}"
    shift 2
    ;;
  --base-url)
    BASE_URL="${2:-}"
    shift 2
    ;;
  --max-rows)
    MAX_ROWS="${2:-}"
    shift 2
    ;;
  --min-rows)
    MIN_ROWS="${2:-}"
    shift 2
    ;;
  --with-trgm)
    WITH_TRGM=1
    shift
    ;;
  --force)
    FORCE=1
    shift
    ;;
  --dry-run)
    DRY_RUN=1
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) die "unknown argument: $1" ;;
  esac
done

[ -n "${MAX_ROWS}" ] && MIN_ROWS="${MAX_ROWS}"

# ---------------------------------------------------------------------------
# Preconditions, checked before anything is created so a missing tool is a clean
# exit 1 rather than a half-built staging table nobody drops.
# ---------------------------------------------------------------------------
DB_URL="${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}"
[ -n "${DB_URL}" ] || die "DATABASE_URL_DIRECT or DATABASE_URL is required"

for tool in psql zstd tar curl awk; do
  command -v "${tool}" >/dev/null 2>&1 || die "${tool} is required and is not on PATH"
done

# macOS ships shasum, Linux ships sha256sum.
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD=(shasum -a 256)
else
  die "sha256sum or shasum is required"
fi

# ---------------------------------------------------------------------------
# The connection, moved OFF THE COMMAND LINE.
#
# `psql "postgres://user:password@host/db"` puts the password in argv, where
# every local user can read it out of `ps` for the whole life of the process,
# and where any error handler that echoes its own invocation discloses it.
# packages/db/scripts/verify-migrations.mjs documents the same class of leak
# from the message side; this closes the argv side. libpq reads all of these
# from the environment, so `psql` is invoked with no connection argument at all.
# ---------------------------------------------------------------------------
parse_conn() {
  local url="$1" rest userinfo hostport
  case "${url}" in
  postgres://* | postgresql://*) ;;
  *) die "DATABASE_URL_DIRECT must be a postgres:// URL" ;;
  esac
  rest="${url#*://}"
  # Query string: only sslmode is honoured, because it is the only one that
  # changes whether the connection is safe. Anything else is passed through
  # untouched via PGOPTIONS-free defaults rather than silently dropped, which is
  # the failure verify-migrations.mjs hit when it ate `?sslmode=require`.
  local query=""
  case "${rest}" in *\?*)
    query="${rest#*\?}"
    rest="${rest%%\?*}"
    ;;
  esac
  local path="${rest#*/}"
  rest="${rest%%/*}"
  if [ "${rest}" != "${rest#*@}" ]; then
    userinfo="${rest%@*}"
    hostport="${rest##*@}"
  else
    userinfo=""
    hostport="${rest}"
  fi
  [ -n "${userinfo}" ] && {
    export PGUSER
    PGUSER=$(printf '%s' "${userinfo%%:*}" | sed 's/%40/@/g')
    case "${userinfo}" in *:*)
      export PGPASSWORD
      PGPASSWORD="${userinfo#*:}"
      ;;
    esac
  }
  export PGHOST="${hostport%%:*}"
  case "${hostport}" in *:*) export PGPORT="${hostport##*:}" ;; esac
  [ -n "${path}" ] && export PGDATABASE="${path}"
  case "${query}" in
  *sslmode=*)
    local m="${query#*sslmode=}"
    export PGSSLMODE="${m%%&*}"
    ;;
  *) export PGSSLMODE="${PGSSLMODE:-require}" ;;
  esac
  # A connection with no ceiling on a scheduled job is a job that never ends.
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
}
parse_conn "${DB_URL}"

# ---------------------------------------------------------------------------
# THE ONE SANCTIONED OPT-OUT FROM THE OWNER'S STATEMENT CEILING.
#
# infra/neon/sql/set-role-timeouts.sql gives neondb_owner a 15-minute
# statement_timeout as a role default, so a wedged maintenance session cannot
# hold locks against the application indefinitely. THIS SCRIPT IS THE ONE THING
# THAT LEGITIMATELY EXCEEDS IT, and it exceeds it in a single statement: step 6
# is one `COPY ... FROM STDIN` that runs for as long as it takes to download
# 2.3 GB and stream 7.5 GB of CSV through it. Under the role default that COPY
# is cancelled partway and the load fails every time, with a message about a
# statement timeout that says nothing about why.
#
# THE ROLE DEFAULT IS LIVE, so this is not a precaution against something that
# might happen later. Read off the staging branch on 2026-07-29:
#
#   neondb_owner   {statement_timeout=15min,idle_in_transaction_session_timeout=5min}
#   pullfm_app     {statement_timeout=30s,idle_in_transaction_session_timeout=60s}
#
# The full 31,554,198-row load ran to completion the same day WITH that default
# in place, which is the evidence that the prelude below actually clears it
# rather than merely appearing to. The COPY itself took 129 seconds, so it would
# have survived the 15-minute ceiling anyway - the ceiling that would have
# killed it is `pullfm_app`'s 30 seconds, and running this as the app role would
# also fail on privileges long before that. Do not "simplify" this by removing
# the prelude because one measured run happened to fit: the margin is a property
# of today's dump size, today's network and today's Neon compute, and all three
# move.
#
# So it is lifted HERE, visibly, for this process only, rather than by weakening
# the role default for everything that connects as the owner. Set
# MB_CANONICAL_STATEMENT_TIMEOUT to put a ceiling back if a particular
# environment wants one; the loader's own bounds are unaffected either way, and
# there are three of them: PGCONNECT_TIMEOUT above, --max-time on every curl,
# and the refresh job's MB_CANONICAL_TIMEOUT_MS around the whole process.
#
# IT IS A `SET` AND NOT `PGOPTIONS`, AND THAT IS NEON-SPECIFIC RATHER THAN
# STYLE. The obvious form, `export PGOPTIONS="-c statement_timeout=0"`, puts the
# value in the `options` field of the libpq StartupMessage, and Neon's proxy
# rejects it OUTRIGHT - on the DIRECT endpoint, not just the pooled one.
# Measured against the staging branch on 2026-07-29:
#
#   psql: error: connection to server ... failed: ERROR:  unsupported startup
#   parameter in options: statement_timeout. Please use unpooled connection or
#   remove this parameter from the startup package.
#
# Note what that error advises, and that following the advice does not help:
# this WAS the unpooled connection. So on Neon the only way to change this
# setting for a session is a SQL `SET` after the connection is established,
# which is what the prelude below is. It is prepended to every psql invocation
# in this file rather than issued once, because each `psql` is its own session.
#
# lock_timeout is deliberately NOT cleared. The swap sets its own (step 10) and
# that one is what stops this job from turning into an outage.
PSQL_PRELUDE="SET statement_timeout = ${MB_CANONICAL_STATEMENT_TIMEOUT:-0};"

# `-q` suppresses the `SET` command tag, so the prelude adds no line to the
# output psql_q parses as a single value. Verified rather than assumed.
psql_q() { psql -v ON_ERROR_STOP=1 -qtAX -c "${PSQL_PRELUDE}" -c "$1"; }
psql_f() {
  { printf '%s\n' "${PSQL_PRELUDE}"; cat; } |
    psql -v ON_ERROR_STOP=1 -qX -f -
}

# ---------------------------------------------------------------------------
# 1. Which dump.
# ---------------------------------------------------------------------------
if [ -n "${ARCHIVE}" ]; then
  [ -f "${ARCHIVE}" ] || die "no such archive: ${ARCHIVE}"
  [ -n "${DUMP_ID}" ] || DUMP_ID=$(basename "${ARCHIVE}" .tar.zst)
elif [ -z "${DUMP_ID}" ]; then
  # ENUMERATE THE DIRECTORY. NEVER CONSTRUCT THE PATH FROM A DATE.
  #
  # MetaBrainz documents the cadence verbatim as "Update frequency: Twice a
  # month, on the 1st and 15th" (metabrainz.org/datasets/derived-dumps). THE
  # PUBLISHED DIRECTORIES DISAGREE: the observed dumps are dated the 3rd and the
  # 17th, a consistent two-day offset. Anything that derives the directory name
  # from the documented schedule 404s on the 1st of every month, and does so
  # silently on a fortnightly job that nobody watches.
  #
  # This is the specific "simplification" a future reader will reach for, since
  # a date is obviously cheaper than an HTTP listing. It is wrong. The listing
  # is the only source of truth for what has actually been published.
  #
  # The index is generated HTML; the directory names are the only strings of
  # this shape on it, and sorting them lexically sorts them by date because the
  # timestamp is the whole name. Only two are ever retained upstream.
  DUMP_ID=$(curl -fsS --max-time 60 "${BASE_URL}/" |
    grep -oE 'musicbrainz-canonical-dump-[0-9]{8}-[0-9]{6}' |
    sort -u | tail -1) || die "could not list the canonical_data directory"
  [ -n "${DUMP_ID}" ] || die "no canonical dump found at the base URL"
fi
log "dump: ${DUMP_ID}"

DUMP_URL="${BASE_URL}/${DUMP_ID}/${DUMP_ID}.tar.zst"
CSV_PATH="${DUMP_ID}/canonical/canonical_musicbrainz_data.csv"

# ---------------------------------------------------------------------------
# 2. The publisher's digest.
#
# The .sha256 sibling is a BARE 64-character digest with no filename and no
# trailing newline, which is not the format `sha256sum -c` expects, so it is
# parsed rather than fed to a checker. Validated as 64 hex characters here: an
# empty digest read from a redirect or an HTML error page would otherwise be
# carried all the way to the comparison, where it would fail for the right
# reason by accident rather than by design.
# ---------------------------------------------------------------------------
if [ -z "${EXPECTED_SHA}" ]; then
  if [ -n "${ARCHIVE}" ] && [ -f "${ARCHIVE}.sha256" ]; then
    EXPECTED_SHA=$(tr -d '[:space:]' <"${ARCHIVE}.sha256" | cut -c1-64)
  else
    EXPECTED_SHA=$(curl -fsS --max-time 60 "${BASE_URL}/${DUMP_ID}/${DUMP_ID}.tar.zst.sha256" |
      tr -d '[:space:]' | cut -c1-64) || die "could not fetch the published sha256"
  fi
fi
printf '%s' "${EXPECTED_SHA}" | grep -qE '^[0-9a-f]{64}$' ||
  die "published sha256 is not 64 hex characters (got ${#EXPECTED_SHA})"
log "expected sha256: ${EXPECTED_SHA}"

# ---------------------------------------------------------------------------
# 3. IS THERE ANYTHING TO DO? Asked FIRST, and the order is load-bearing.
#
# This block used to sit BELOW the licence gate, which meant every run paid the
# gate's 32 MiB ranged download before discovering it had nothing to do. That
# was affordable at a fortnightly schedule and is not at a daily one, and daily
# is what infra/mb-loader/systemd/pullfm-mb-canonical.timer settled on: 32 MiB a
# day is about a gigabyte a month pulled off a charity's file host to learn a
# fact one indexed SELECT already knew. In this order a no-op run costs one
# directory listing, one 64-byte .sha256 and one row read, measured at about a
# second, which is what makes a daily cadence a courtesy rather than an
# imposition.
#
# IT DOES NOT WEAKEN THE LICENCE GATE, and that is the objection to answer. The
# gate exists because a fortnightly RE-FETCH is a fortnightly RE-CONSENT, so it
# has to fire for every dump this database has not already accepted - and it
# still does: the only path that skips it is one where mb.load_state already
# records a SUCCESSFUL load of this exact dump id, which is to say a dump whose
# COPYING was verified when its rows were loaded. Re-verifying the same
# immutable archive daily re-consents to nothing, and if its bytes ever did
# change, the sha256 gate before the swap is what catches that, not this.
#
# Two dumps are retained upstream and they are published fortnightly, so any
# schedule tighter than that will mostly find nothing new. Declining is exit 0:
# a job that reports failure for working as designed teaches an operator to
# ignore it, which is how a real failure goes unnoticed.
# ---------------------------------------------------------------------------
psql_q "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'mb'" |
  grep -q 1 || die "the mb schema does not exist. Run migration 0007 first."

if [ "${FORCE}" != "1" ]; then
  ALREADY=$(psql_q "SELECT 1 FROM mb.load_state
                     WHERE status = 'ok' AND dump_id = '${DUMP_ID}' LIMIT 1") ||
    die "could not read mb.load_state"
  if [ "${ALREADY}" = "1" ]; then
    log "already loaded: ${DUMP_ID}. Nothing to do."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# 4. THE LICENCE GATE.
#
# See the header for why this is checked on every run rather than once, at
# review time: a fortnightly re-fetch is a fortnightly re-consent, and a
# relicensed future dump would otherwise load without a word. `--force
# --dry-run` re-runs it against a dump that is already loaded, which is the way
# to re-check a licence on demand.
#
# The check runs BEFORE the 2.3 GB download, using an HTTP range request for the
# first few megabytes, because a licence change should stop the pipeline before
# it spends the bandwidth rather than after. The archive orders its members
# TIMESTAMP, COPYING, then the CSV, so the prefix contains COPYING whole; zstd
# and tar both complain about the truncated tail and both are expected to, which
# is why their exit statuses are ignored here and only the extracted BYTES are
# trusted.
#
# Not finding COPYING in the prefix is a FAILURE, not a skip. It means the
# archive's layout changed, and an archive we can no longer read the licence out
# of is one we must not load.
# ---------------------------------------------------------------------------
COPYING_SHA256_CC0="75f3c90d6fa833817f19d019b35807687c3ed1c0b858b5f274625e96dda24bea"
COPYING_PREFIX_BYTES="${MB_CANONICAL_COPYING_PREFIX_BYTES:-33554432}"

verify_licence() {
  local copying
  copying=$(mktemp)
  if [ -n "${ARCHIVE}" ]; then
    # The same prefix, taken locally: COPYING is the second member, so reading
    # the whole archive to find it would cost a full decompression pass for a
    # 6 KB file.
    head -c "${COPYING_PREFIX_BYTES}" <"${ARCHIVE}" 2>/dev/null |
      zstd -dc 2>/dev/null |
      tar -xOf - "${DUMP_ID}/COPYING" 2>/dev/null >"${copying}" || true
  else
    curl -fsS --max-time 300 -r "0-$((COPYING_PREFIX_BYTES - 1))" "${DUMP_URL}" 2>/dev/null |
      zstd -dc 2>/dev/null |
      tar -xOf - "${DUMP_ID}/COPYING" 2>/dev/null >"${copying}" || true
  fi

  local actual size
  size=$(wc -c <"${copying}" | tr -d ' ')
  actual=$("${SHA_CMD[@]}" <"${copying}" | cut -d' ' -f1)
  rm -f "${copying}"

  [ "${size}" != "0" ] ||
    die "COPYING is missing from ${DUMP_ID}. The archive layout changed; refusing to load an archive whose licence cannot be read."

  if [ "${actual}" != "${COPYING_SHA256_CC0}" ]; then
    die "LICENCE CHANGED. ${DUMP_ID}/COPYING is ${size} bytes with sha256 ${actual}, expected the CC0 1.0 file ${COPYING_SHA256_CC0}. Loading a relicensed dump would attach its terms to this database permanently. Stopping. Escalate to docs/compliance/metabrainz-terms-review.md before overriding."
  fi
  log "licence verified: COPYING is CC0 1.0 (${actual})"
}
verify_licence

if [ "${DRY_RUN}" = "1" ]; then
  log "dry run: would load ${DUMP_URL}"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. A staging table private to this run.
#
# The name carries the pid and a timestamp rather than being a fixed
# `canonical_next`, so two loaders running at once cannot destroy each other's
# work by colliding on a name. They duplicate effort, which is wasteful and
# harmless; the swap is serialised by an advisory lock, so the published result
# is one of the two loads, whole, and never a mixture of both.
#
# `LIKE mb.canonical` copies the column list and the NOT NULLs and nothing else.
# No primary key and no indexes on purpose: every index is maintained per row
# during a COPY of tens of millions of rows, and building them afterwards on a
# populated table is several times faster.
# ---------------------------------------------------------------------------
STAGE="canonical_stage_$$_$(date +%s)"
LOAD_ID=""
SHA_FILE=$(mktemp)

cleanup() {
  local status=$?
  rm -f "${SHA_FILE}"
  if [ -n "${STAGE}" ]; then
    psql_q "DROP TABLE IF EXISTS mb.\"${STAGE}\"" >/dev/null 2>&1 || true
  fi
  if [ -n "${LOAD_ID}" ] && [ "${status}" != "0" ]; then
    # Best effort. A recorded failure is what turns "the data looks old" into
    # "the load has been failing since the 17th" without reading job logs.
    #
    # LAST_ERROR is empty when the process was KILLED rather than exiting through
    # `die` - a systemd TimeoutStartSec, an OOM kill, an operator's ^C - and that
    # distinction is worth preserving in the table rather than flattening: an
    # exit code with no reason means nothing wrote one, which is itself the
    # diagnosis.
    local reason
    reason=$(sql_lit "${LAST_ERROR:-killed or exited ${status} without a reason; see job logs}")
    psql_q "UPDATE mb.load_state
               SET status = 'failed', finished_at = now(),
                   error  = 'exit ${status}: ${reason}'
             WHERE id = ${LOAD_ID} AND status = 'running'" >/dev/null 2>&1 || true
  fi
  return "${status}"
}
trap cleanup EXIT

LOAD_ID=$(psql_q "INSERT INTO mb.load_state (dump_id, sha256)
                  VALUES ('${DUMP_ID}', '${EXPECTED_SHA}') RETURNING id") ||
  die "could not record the load attempt"

psql_q "CREATE TABLE mb.\"${STAGE}\" (LIKE mb.canonical)" ||
  die "could not create the staging table"

# ---------------------------------------------------------------------------
# 6 and 7. Stream, hash, and load.
#
# `tee` into a process substitution is what lets one pass do both: the bytes go
# to the hasher and to the decompressor simultaneously, so the archive is read
# once and the CSV is never written anywhere.
#
# --max-rows uses an awk record splitter rather than `head`, and the difference
# matters. A CSV field may contain a newline inside quotes - recording titles
# do - so cutting on the Nth LINE can cut a record in half and leave an
# unterminated quote that COPY rejects. The splitter counts quote characters
# and only emits when the count is even, which is exactly RFC 4180's rule
# (a literal quote inside a quoted field is doubled, so it preserves parity).
# ---------------------------------------------------------------------------
COPY_SQL="\\copy mb.\"${STAGE}\" (id, artist_credit_id, artist_mbids, artist_credit_name, release_mbid, release_name, recording_mbid, recording_name, combined_lookup, score) FROM STDIN WITH (FORMAT csv, HEADER true)"

SPLITTER='
BEGIN { open = 0; n = 0; buf = "" }
{
  buf = buf $0 "\n"
  open = (open + gsub(/"/, "&")) % 2
  if (open == 0) { printf "%s", buf; buf = ""; n++; if (n >= LIMIT) exit }
}'

if [ -n "${ARCHIVE}" ]; then
  # Local file: verify in full FIRST, then parse. The stricter order, available
  # because the bytes are already on disk and re-reading them is cheap.
  log "verifying ${ARCHIVE}"
  ACTUAL_SHA=$("${SHA_CMD[@]}" "${ARCHIVE}" | cut -d' ' -f1)
  [ "${ACTUAL_SHA}" = "${EXPECTED_SHA}" ] ||
    die "sha256 mismatch on the archive: expected ${EXPECTED_SHA}, got ${ACTUAL_SHA}"
  log "sha256 verified. Loading."
  SOURCE=(cat "${ARCHIVE}")
else
  log "streaming the archive"
  SOURCE=(curl -fsS --max-time "${MB_CANONICAL_DOWNLOAD_TIMEOUT:-7200}" "${DUMP_URL}")
fi

if [ -n "${MAX_ROWS}" ]; then
  # ---------------------------------------------------------------------------
  # NO `tee` AND NO HASHER ON THIS BRANCH, AND THAT IS A BUG FIX RATHER THAN A
  # TIDY-UP. This branch used to carry the same `tee >(sha256sum)` as the full
  # branch below, and the comment here used to say that everything upstream of
  # the splitter "is expected to die of SIGPIPE the moment the cap is reached".
  # IT DOES NOT, and the reason is the hasher.
  #
  # `tee` writes to two places: the pipe to zstd, and the process substitution
  # holding the hasher. When awk hits the cap and exits, the zstd side collapses
  # - but the HASHER IS STILL READING, so tee still has a live output, keeps
  # draining its stdin to feed it, and curl keeps downloading. The result is
  # that `--max-rows 5` against the published URL still pulls the whole 2.32 GB
  # archive across the network before the process ends. Measured: a five-row
  # capped load ran for over five minutes and was killed, having loaded its five
  # rows in the first second.
  #
  # Removing the hasher is the fix AND it costs nothing, because the digest was
  # already worthless on this branch: the stream is cut short on purpose, so the
  # hash is of a prefix and can never equal the publisher's. The script already
  # says so in the WARNING below. Now SIGPIPE reaches curl directly and the cap
  # bounds the download as well as the row count, which is what anybody passing
  # --max-rows in a size-capped environment assumed it did.
  #
  # SHA_FILE is left empty, which is what the WARNING branch below expects.
  #
  # The header is record 0, so the cap is MAX_ROWS + 1 emitted records.
  # ---------------------------------------------------------------------------
  "${SOURCE[@]}" |
    zstd -dc |
    tar -xOf - "${CSV_PATH}" |
    awk -v LIMIT="$((MAX_ROWS + 1))" "${SPLITTER}" |
    psql -v ON_ERROR_STOP=1 -qX -c "${PSQL_PRELUDE}" -c "${COPY_SQL}"
  STATUSES=("${PIPESTATUS[@]}")
  # Only the COPY's status is decisive. Everything upstream of the splitter DOES
  # now die of SIGPIPE when the cap is reached, and treating that as a failure
  # would make --max-rows unusable. Index 4, not 5, because `tee` is gone.
  [ "${STATUSES[4]}" = "0" ] || die "COPY failed (exit ${STATUSES[4]})"
else
  "${SOURCE[@]}" |
    tee >("${SHA_CMD[@]}" | cut -d' ' -f1 >"${SHA_FILE}") |
    zstd -dc |
    tar -xOf - "${CSV_PATH}" |
    psql -v ON_ERROR_STOP=1 -qX -c "${PSQL_PRELUDE}" -c "${COPY_SQL}"
  STATUSES=("${PIPESTATUS[@]}")
  # Each failure mode lands in a different slot, so all of them are checked:
  # a truncated download is curl or zstd ("unexpected end of stream"), a
  # substituted or reshaped archive is tar, and a malformed row is COPY.
  for i in 0 1 2 3 4; do
    [ "${STATUSES[$i]:-0}" = "0" ] ||
      die "load pipeline stage ${i} failed (exit ${STATUSES[$i]}); the live table is untouched"
  done
fi

# The hasher runs in a process substitution, so its output file is not
# guaranteed to be flushed the instant the pipeline returns.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "${SHA_FILE}" ] && break
  sleep 0.2
done
ACTUAL_SHA=$(tr -d '[:space:]' <"${SHA_FILE}")

if [ -z "${ARCHIVE}" ]; then
  if [ -n "${MAX_ROWS}" ]; then
    # --max-rows closes the pipe early on purpose, so the hasher sees a prefix
    # of the archive and its digest is meaningless. Said out loud rather than
    # silently skipped: a capped load is NOT an authenticated one.
    log "WARNING: sha256 not verified - --max-rows cut the stream short by design"
  else
    # THE GATE. Nothing below this line runs for an archive whose bytes are not
    # the publisher's bytes, and everything above it happened in a table no
    # reader can see.
    [ "${ACTUAL_SHA}" = "${EXPECTED_SHA}" ] ||
      die "sha256 MISMATCH: expected ${EXPECTED_SHA}, got ${ACTUAL_SHA:-<none>}. Nothing was published."
    log "sha256 verified: ${ACTUAL_SHA}"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Did enough arrive?
#
# A download cut inside a zstd frame fails loudly, but one cut exactly on a
# frame boundary does not, and a tar truncated between members simply stops.
# Both produce a short, well-formed table. The row floor turns that silent
# partial success into a failure, and it is the reason a half-loaded table
# cannot be swapped in.
# ---------------------------------------------------------------------------
ROWS=$(psql_q "SELECT count(*) FROM mb.\"${STAGE}\"") || die "could not count staged rows"
log "staged rows: ${ROWS}"
[ "${ROWS}" -ge "${MIN_ROWS}" ] ||
  die "only ${ROWS} rows staged, floor is ${MIN_ROWS}. Refusing to publish a partial load."

# ---------------------------------------------------------------------------
# 9. Indexes, on a table nothing is reading.
#
# canonical_lookup_idx is the one that matters, and its shape is not arbitrary.
# `text_pattern_ops` makes it usable for BYTE-ordered prefix ranges regardless of
# the database collation, which is how an artist is found: the dump's fold is per
# character, so it distributes over the concatenation and a folded artist name is
# exactly a prefix of every one of that artist's combined_lookup values. Under a
# non-C collation an ordinary btree would answer that range with the wrong rows.
# `score` as the second column, ASCENDING, means a lookup gets its rows already
# ordered and never sorts. Ascending is deliberate: score is a rank over releases
# where LOWER IS MORE CANONICAL, not a popularity score, so DESC would order
# every result backwards. A text_pattern_ops btree also serves plain equality, so
# ONE index covers both access paths.
#
# canonical_artist_idx is a GIN index over an EXPRESSION, not over the column,
# and it has to be. 15.2% of rows carry several comma-separated UUIDs in that
# text column (measured over the whole 2026-07-17 dump), so a btree on the raw
# text would only ever match a single-artist credit by exact string. Any query
# that wants to use this index must repeat the expression verbatim.
#
# The pg_trgm GIN index is OFF BY DEFAULT, and that is a measurement rather than
# a preference: see docs/runbooks/mb-canonical-data.md for its measured cost
# against the value it adds over the trigram index that already exists on
# mbid_crosswalk.
# ---------------------------------------------------------------------------
# `\timing on` and the `\echo` labels are not decoration. This block is the
# longest phase of the run after the COPY, and it is five statements deep inside
# one psql invocation, so without them a slow load says only "building indexes"
# for however long it takes and an operator cannot tell a wedged GIN build from
# a slow btree. With them every line of the log is one statement and its
# milliseconds, which is what made the per-index numbers in
# docs/runbooks/mb-canonical-data.md measurements rather than guesses.
log "building indexes"
psql_f <<SQL || die "index build failed; the live table is untouched"
\timing on
SET maintenance_work_mem = '${MB_CANONICAL_MAINTENANCE_WORK_MEM:-256MB}';
\echo 'idx: pkey'
ALTER TABLE mb."${STAGE}" ADD CONSTRAINT "${STAGE}_pkey" PRIMARY KEY (id);
\echo 'idx: lookup (btree text_pattern_ops, score)'
CREATE INDEX "${STAGE}_lookup_idx"    ON mb."${STAGE}" (combined_lookup text_pattern_ops, score);
\echo 'idx: recording (btree)'
CREATE INDEX "${STAGE}_recording_idx" ON mb."${STAGE}" (recording_mbid);
\echo 'idx: release (btree)'
CREATE INDEX "${STAGE}_release_idx"   ON mb."${STAGE}" (release_mbid);
\echo 'idx: artist (gin expression)'
CREATE INDEX "${STAGE}_artist_idx"    ON mb."${STAGE}" USING gin ((string_to_array(artist_mbids, ',')::uuid[]));
$([ "${WITH_TRGM}" = "1" ] && printf "\\\\echo 'idx: trgm (gin pg_trgm)'\nCREATE INDEX \"%s_trgm_idx\" ON mb.\"%s\" USING gin (combined_lookup gin_trgm_ops);" "${STAGE}" "${STAGE}")
\echo 'analyze'
ANALYZE mb."${STAGE}";
SQL

# ---------------------------------------------------------------------------
# 10. The swap. One transaction, so there is no midway to be interrupted in.
#
# DROP then RENAME rather than RENAME-RENAME-DROP: dropping the old table first
# frees its index names inside the same transaction, so the staged indexes can
# take the canonical names without a collision and without a second rename pass.
#
# `pg_advisory_xact_lock` serialises this against another loader. Namespace 7 is
# registered in apps/bff/src/lib/db.ts so two features cannot collide on one key
# space, and the KEY is deliberately different from the refresh job's: the job
# holds a session lock for the whole run and would deadlock against its own
# child if the swap wanted the same one.
#
# `lock_timeout` is what stops this from wedging the application. The DROP needs
# ACCESS EXCLUSIVE on mb.canonical, so a reader mid-query holds it off, and
# without a timeout the swap would queue - and because it is queued for ACCESS
# EXCLUSIVE, every subsequent reader would queue behind IT. That turns a
# maintenance job into an outage. Timing out instead means the swap fails, the
# transaction rolls back, the staging table is dropped, and the previous data
# keeps serving until the next run.
# ---------------------------------------------------------------------------
log "swapping"
psql_f <<SQL || die "swap failed; the previous data is still serving"
BEGIN;
SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms';
-- A DO block rather than a bare SELECT so the lock does not print a result set
-- into a log that is otherwise only dump ids, digests and sizes.
DO \$\$ BEGIN PERFORM pg_advisory_xact_lock(7, hashtext('mb:canonical:swap')); END \$\$;
DROP TABLE IF EXISTS mb.canonical;
ALTER TABLE mb."${STAGE}" RENAME TO canonical;
ALTER INDEX mb."${STAGE}_pkey"          RENAME TO canonical_pkey;
ALTER INDEX mb."${STAGE}_lookup_idx"    RENAME TO canonical_lookup_idx;
ALTER INDEX mb."${STAGE}_recording_idx" RENAME TO canonical_recording_idx;
ALTER INDEX mb."${STAGE}_release_idx"   RENAME TO canonical_release_idx;
ALTER INDEX mb."${STAGE}_artist_idx"    RENAME TO canonical_artist_idx;
$([ "${WITH_TRGM}" = "1" ] && printf 'ALTER INDEX mb."%s_trgm_idx" RENAME TO canonical_trgm_idx;' "${STAGE}")
COMMIT;
SQL

# Published. The cleanup trap must no longer try to drop it under the old name.
STAGE=""

# ---------------------------------------------------------------------------
# 11. Record what actually happened, with MEASURED sizes.
#
# Measured rather than estimated because the footprint of this table is the whole
# reason the schema is excluded from the backups, and a number that lives only in
# a document goes stale the first time the catalogue grows.
# ---------------------------------------------------------------------------
psql_q "UPDATE mb.load_state
           SET status = 'ok', finished_at = now(), rows_loaded = ${ROWS},
               bytes_total   = pg_total_relation_size('mb.canonical'),
               bytes_heap    = pg_table_size('mb.canonical'),
               bytes_indexes = pg_indexes_size('mb.canonical')
         WHERE id = ${LOAD_ID}" >/dev/null ||
  die "loaded and swapped, but could not record it in mb.load_state"
LOAD_ID=""

SUMMARY=$(psql_q "SELECT format('rows=%s heap=%s indexes=%s total=%s',
                                rows_loaded,
                                pg_size_pretty(bytes_heap),
                                pg_size_pretty(bytes_indexes),
                                pg_size_pretty(bytes_total))
                    FROM mb.load_state
                   WHERE dump_id = '${DUMP_ID}' AND status = 'ok'
                   ORDER BY finished_at DESC LIMIT 1")
log "${SUMMARY}"
log "done: ${DUMP_ID}"
exit 0
