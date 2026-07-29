#!/usr/bin/env bash
#
# Drives the three-phase quota-Redis fail-closed gate.
#
# Severing the quota store is done HERE rather than from inside the k6 script.
# k6 cannot run docker commands, and giving a load generator the ability to stop
# infrastructure is a worse idea than typing one line. The scenario asserts;
# this script arranges.
#
# Only the QUOTA Redis is stopped. The cache Redis stays up throughout: the
# whole reason `docker-compose.dev.yml` runs two instances is that a cache
# eviction and a quota outage are different failures, and stopping the wrong one
# tests the boring half.
#
# Restores the container on ANY exit path, including Ctrl-C, because leaving the
# quota store down turns every subsequent scenario into a 503 machine and the
# cause is not obvious an hour later.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/docker-compose.dev.yml"
SERVICE=redis-quota
DURATION="${PHASE_DURATION:-30s}"
VUS="${PHASE_VUS:-20}"

cd "${ROOT}"
mkdir -p k6-results

restore() {
  if ! docker compose -f "${COMPOSE}" ps --status running "${SERVICE}" | grep -q "${SERVICE}"; then
    echo ""
    echo "restoring ${SERVICE}"
    docker compose -f "${COMPOSE}" start "${SERVICE}" >/dev/null
    # Give the BFF's ioredis client time to reconnect before anything else runs.
    sleep 5
  fi
}
trap restore EXIT INT TERM

fail=0
run_phase() {
  local phase="$1"
  echo ""
  echo "=== phase: ${phase} ==========================================="
  if ! PHASE="${phase}" PHASE_DURATION="${DURATION}" PHASE_VUS="${VUS}" \
       k6 run load/scenarios/fail-closed.js; then
    echo "  phase ${phase} FAILED its thresholds"
    fail=1
  fi
}

run_phase healthy

echo ""
echo "stopping ${SERVICE} (cache Redis stays up)"
docker compose -f "${COMPOSE}" stop "${SERVICE}" >/dev/null
sleep 2

run_phase severed

restore

run_phase restored

echo ""
if [[ ${fail} -eq 0 ]]; then
  echo "fail-closed gate: PASS. No request was served without a working limiter."
else
  echo "fail-closed gate: FAIL. See the phase records in k6-results/."
fi
exit ${fail}
