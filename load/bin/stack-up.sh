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

stop_pidfile() {
  local name="$1"
  local f="${RUN_DIR}/${name}.pid"
  if [[ -f "${f}" ]]; then
    local pid
    pid="$(cat "${f}")"
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      echo "  stopped ${name} (pid ${pid})"
    fi
    rm -f "${f}"
  fi
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
