#!/usr/bin/env bash
#
# Bring up everything a load run needs, in the order that makes the SAFE path
# the default one.
#
# The ordering is not cosmetic. The BFF is started LAST and only ever through
# `--import ../safety/upstream-guard.mjs`, because a BFF started any other way
# calls MusicBrainz, iTunes, Last.fm, Deezer and ListenBrainz for real: the
# provider origins are hardcoded module constants in packages/upstream and
# apps/bff never passes a baseUrl override. MusicBrainz permits one request per
# second globally per IP and revokes without appeal. See
# docs/RUNBOOK-SCALE.md and load/safety/upstream-guard.mjs.
#
# Usage:
#   load/bin/stack-up.sh              # start everything, seed 200 subjects
#   load/bin/stack-up.sh --count 50   # fewer subjects
#   load/bin/stack-up.sh --down       # stop what this script started
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="${ROOT}/load/.run"
COUNT=200

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --down) DOWN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "${RUN_DIR}"

# STOPPING MUST WAIT FOR THE PROCESS TO ACTUALLY BE GONE.
#
# `kill` only DELIVERS a signal; it does not wait for the target to act on it.
# A version of this that signalled and moved on left the old listener holding
# the port for as long as it took to drain, and the next start then raced it.
# See the header of `assert_port_free` for what that race produced.
stop_pidfile() {
  local name="$1"
  local f="${RUN_DIR}/${name}.pid"
  [[ -f "${f}" ]] || return 0

  local pid
  pid="$(cat "${f}")"
  rm -f "${f}"

  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  kill "${pid}" 2>/dev/null || true
  local tries=100 # 10 seconds
  while kill -0 "${pid}" 2>/dev/null; do
    tries=$((tries - 1))
    if [[ ${tries} -le 0 ]]; then
      echo "  ${name} (pid ${pid}) ignored SIGTERM, sending SIGKILL" >&2
      kill -9 "${pid}" 2>/dev/null || true
      sleep 0.5
      break
    fi
    sleep 0.1
  done
  echo "  stopped ${name} (pid ${pid})"
}

# Which pid is listening on a TCP port, or empty if nothing is.
#
# Two implementations because there is no portable one: lsof is what macOS has,
# `ss` is what a stock Linux runner has. If neither exists the caller degrades
# to a warning rather than a false guarantee - saying nothing is better than
# saying "clear" without having looked.
port_pid() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -1
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :${port}" 2>/dev/null |
      grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
  else
    echo "__unknown__"
  fi
}

# THE CHECK THIS SCRIPT WAS MISSING, AND WHAT IT COST.
#
# Every service here is started and then confirmed with `wait_for`, which polls
# an HTTP health endpoint. A health endpoint answers whoever is bound to the
# port; it does not answer "the process I just started". So when a previous
# stack was still running - a --down that was never issued, a terminal closed on
# a foreground run, a pidfile removed by hand - the sequence was:
#
#   1. start a new BFF on :3000, which fails instantly with EADDRINUSE
#   2. poll http://127.0.0.1:3000/healthz
#   3. THE OLD PROCESS ANSWERS IT
#   4. print "bff up" and run the scenarios
#
# Every step reports success and the measurement is of the PREVIOUS BUILD. Two
# load runs were invalidated by exactly this before it was noticed, and the only
# symptom was a result that did not move after a change that should have moved
# it. A rebuild appeared to deploy and did not.
#
# So a listener that is not ours is a HARD STOP, before anything is started and
# before any health check can paper over it. The pidfiles are cleared first, so
# reaching this with a live listener means the process is one this script cannot
# account for, and guessing at it is exactly the behaviour being removed.
assert_port_free() {
  local port="$1" name="$2"
  local pid
  pid="$(port_pid "${port}")"

  if [[ "${pid}" == "__unknown__" ]]; then
    echo "  WARNING: neither lsof nor ss is available, so a stale ${name} on" >&2
    echo "  port ${port} cannot be detected. A health check that passes below" >&2
    echo "  may be answered by a previous process. Install lsof." >&2
    return 0
  fi

  [[ -z "${pid}" ]] && return 0

  local cmd
  cmd="$(ps -o command= -p "${pid}" 2>/dev/null || echo "unknown")"
  cat >&2 <<EOF

REFUSING TO START: port ${port} (${name}) is already in use.

  pid      ${pid}
  command  ${cmd}

This script had already stopped everything it knows about, so that process is
not one of ours. Starting on top of it does not fail loudly - the new process
dies with EADDRINUSE and the health check below is then answered by THE OLD
ONE, so the run reports success and measures the previous build.

Stop it and try again:

  load/bin/stack-up.sh --down    # if it is a stack this script started
  kill ${pid}                    # if it is not, and you know what it is

EOF
  exit 1
}

if [[ "${DOWN:-0}" == "1" ]]; then
  echo "stopping load stack"
  stop_pidfile bff
  stop_pidfile idp
  stop_pidfile mock
  exit 0
fi

# --- environment ------------------------------------------------------------
# Sourced rather than baked in, so credentials never live in a tracked file.
# load/.env.load is gitignored; .env.load.example documents every variable.
if [[ -f "${ROOT}/load/.env.load" ]]; then
  # shellcheck disable=SC1091
  set -a; source "${ROOT}/load/.env.load"; set +a
else
  echo "load/.env.load not found. Copy load/.env.load.example and fill it in." >&2
  exit 1
fi

: "${MOCK_URL:=http://127.0.0.1:8787}"
: "${GUARD_URL:=http://127.0.0.1:8788}"
: "${IDP_URL:=http://127.0.0.1:8789}"
: "${BASE_URL:=http://127.0.0.1:3000}"
export MOCK_URL GUARD_URL IDP_URL BASE_URL

port_of() { echo "${1##*:}"; }

# --- make the starting state the same every time ----------------------------
#
# Stop whatever a previous invocation left running BEFORE starting anything, so
# that "the port is busy" below can only mean a process this script cannot
# account for. Doing it in this order is what makes the error message in
# assert_port_free true.
echo "0/5 clearing any previous stack"
stop_pidfile bff
stop_pidfile idp
stop_pidfile mock

assert_port_free "$(port_of "${BASE_URL}")" "bff"
assert_port_free "$(port_of "${IDP_URL}")" "idp"
assert_port_free "$(port_of "${MOCK_URL}")" "mock"
assert_port_free "$(port_of "${GUARD_URL}")" "egress guard"
echo "  clear"

wait_for() {
  local url="$1" name="$2" tries=60
  until curl -sf "${url}" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [[ ${tries} -le 0 ]]; then
      echo "  ${name} did not come up at ${url}" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "  ${name} up"
}

echo "1/5 mock upstreams"
node "${ROOT}/load/mock-upstreams/server.js" >"${RUN_DIR}/mock.log" 2>&1 &
echo $! > "${RUN_DIR}/mock.pid"
wait_for "${MOCK_URL}/__admin/health" "mock"

echo "2/5 load-test identity provider"
node "${ROOT}/load/auth/idp.mjs" >"${RUN_DIR}/idp.log" 2>&1 &
echo $! > "${RUN_DIR}/idp.pid"
wait_for "${IDP_URL}/__idp/health" "idp"

echo "3/5 migrations"
node "${ROOT}/packages/db/scripts/migrate.mjs" >"${RUN_DIR}/migrate.log" 2>&1 \
  || { echo "  migrations failed, see ${RUN_DIR}/migrate.log" >&2; exit 1; }
echo "  applied"

echo "4/5 BFF, behind the egress guard"
# THE LINE THAT MATTERS. Never start the BFF without --import.
#
# RATE_LIMIT_MAX is raised because the global limiter is per-IP and in-process
# (an LRU, not Redis), so a load generator on one host shares ONE bucket. At the
# 300/minute default the whole run is capped at 5 req/s and the measurement is
# of the limiter rather than of the system. Raising it is a load-test
# configuration and is recorded in every run record.
(
  cd "${ROOT}"
  RATE_LIMIT_MAX="${RATE_LIMIT_MAX:-1000000}" \
  WORKOS_API_BASE_URL="${IDP_URL}" \
  WORKOS_JWKS_URL="${IDP_URL}/jwks.json" \
  node --import ./load/safety/upstream-guard.mjs apps/bff/dist/index.js \
    >"${RUN_DIR}/bff.log" 2>&1 &
  echo $! > "${RUN_DIR}/bff.pid"
)
wait_for "${BASE_URL}/healthz" "bff"

# THE HEALTH CHECK ABOVE PROVES SOMETHING IS SERVING, NOT THAT IT IS OURS.
# assert_port_free made that very hard to get wrong, but the two facts are still
# independent, and this is the one the measurement depends on: every k6 result
# is attributed to the build in apps/bff/dist. Cheap to assert, so assert it.
bff_pid="$(cat "${RUN_DIR}/bff.pid")"
listening_pid="$(port_pid "$(port_of "${BASE_URL}")")"
if [[ "${listening_pid}" != "__unknown__" && -n "${listening_pid}" &&
  "${listening_pid}" != "${bff_pid}" ]]; then
  echo "  THE BFF ANSWERING ${BASE_URL} IS NOT THE ONE THIS SCRIPT STARTED." >&2
  echo "  started pid ${bff_pid}, listening pid ${listening_pid}." >&2
  echo "  Whatever is measured now is not the build in apps/bff/dist." >&2
  exit 1
fi

wait_for "${GUARD_URL}/__guard/health" "guard"

# Belt and braces: the scenarios preflight this too, but failing here is a
# clearer error than failing 30 seconds into a run.
if ! curl -s "${GUARD_URL}/__guard/health" | grep -q '"safe":true'; then
  echo "  GUARD IS NOT IN SAFE MODE. Refusing to continue." >&2
  exit 1
fi
echo "  guard active, provider egress -> ${MOCK_URL}"

echo "5/5 subjects"
node "${ROOT}/load/auth/seed-subjects.mjs" --count "${COUNT}" \
  --out "${ROOT}/load/.subjects.json"

cat <<EOF

ready.

  BASE_URL=${BASE_URL}
  guard    ${GUARD_URL}/__guard/stats
  mock     ${MOCK_URL}/__admin/stats
  logs     ${RUN_DIR}/

run a gate:

  k6 run load/scenarios/coalescing.js
  k6 run load/scenarios/steady-10k.js

stop:

  load/bin/stack-up.sh --down
EOF
