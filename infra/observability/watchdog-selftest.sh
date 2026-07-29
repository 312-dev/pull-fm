#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Synthetic triggers for every condition the watchdog can detect, each one
# proven by reading the resulting notification back off a real ntfy.
#
#   ./infra/observability/watchdog-selftest.sh
#
# This is the Gate 5 evidence generator for the metric-derived rows of
# docs/RUNBOOK-INCIDENT.md section 6. Gate 5's wording is "each of a named list
# of alert conditions FIRES to ntfy within 60 seconds when triggered
# synthetically, evidenced by a timestamped log", and this produces exactly
# that, per condition, with the elapsed time measured rather than assumed.
#
# ---------------------------------------------------------------------------
# WHERE THE FIXTURE COMES FROM, WHICH IS THE POINT
#
# testdata/metrics-sample.txt is not hand-written. It is a REAL scrape captured
# from a real application built by the integration harness, and each case below
# mutates one line of it. That is what makes this a test of the watchdog rather
# than a test of a file somebody typed: if the exporter renames a series, the
# fixture stops containing it, the mutation is a no-op, and the case fails.
#
# The coupling is asserted from the other side too, in
# apps/bff/src/lib/observability.test.ts, which reads the metric names out of
# THIS repository's watchdog script and requires the live application to emit
# every one. Between the two, a rename cannot silently disarm an alert - which
# is the specific way alerting rots.
# ---------------------------------------------------------------------------
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SAMPLE="${HERE}/testdata/metrics-sample.txt"
FAILED=0

pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  FAILED=$((FAILED + 1))
}

echo "pullfm watchdog self-test  $(date -u +%FT%TZ)"
echo "-------------------------------------------------------------"

[ -f "${SAMPLE}" ] || {
  echo "  FAIL  ${SAMPLE} missing. Regenerate it from a real scrape."
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  echo "  SKIP  docker unavailable; cannot start ntfy or the fixture server."
  exit 77
}

WORK=$(mktemp -d)
NTFY="pullfm-wd-ntfy-$$"
NTFY_PORT=${PULLFM_SELFTEST_NTFY_PORT:-18081}
FIX_PORT=${PULLFM_SELFTEST_FIX_PORT:-18082}
TOPIC="pullfm-wd-$$"
FIXPID=""

cleanup() {
  [ -n "${FIXPID}" ] && kill "${FIXPID}" 2>/dev/null
  docker rm -f "${NTFY}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

# --- a real ntfy -----------------------------------------------------------
docker run -d --rm --name "${NTFY}" -p "127.0.0.1:${NTFY_PORT}:80" \
  binwiederhier/ntfy:latest serve --base-url "http://127.0.0.1:${NTFY_PORT}" \
  >/dev/null 2>&1 || {
  echo "  SKIP  could not start ntfy"
  exit 77
}
for _ in $(seq 1 40); do
  curl -fsS --max-time 2 "http://127.0.0.1:${NTFY_PORT}/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
pass "ntfy is serving on ${NTFY_PORT}"

# --- a fixture origin ------------------------------------------------------
# Serves /healthz and /metrics out of ${WORK}, so a case is "rewrite one line
# and run the watchdog".
mkdir -p "${WORK}/www"
printf '{"status":"ok"}' >"${WORK}/www/healthz"
cp "${SAMPLE}" "${WORK}/www/metrics"

python3 - "${WORK}/www" "${FIX_PORT}" <<'PY' &
import http.server, functools, sys, os
d, port = sys.argv[1], int(sys.argv[2])
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def translate_path(self, path):
        return os.path.join(d, path.lstrip("/").split("?")[0] or "metrics")
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory=d)).serve_forever()
PY
FIXPID=$!
for _ in $(seq 1 40); do
  curl -fsS --max-time 2 "http://127.0.0.1:${FIX_PORT}/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS --max-time 2 "http://127.0.0.1:${FIX_PORT}/metrics" >/dev/null 2>&1 ||
  { echo "  SKIP  fixture origin never came up"; exit 77; }
pass "fixture origin is serving a REAL captured scrape"

cat >"${WORK}/alert.env" <<EOF
PULLFM_NTFY_URL=http://127.0.0.1:${NTFY_PORT}/${TOPIC}
PULLFM_NTFY_TOKEN=
PULLFM_ALERT_REPEAT_S=3600
PULLFM_ALERT_ENV_LABEL=selftest
EOF

export PULLFM_ALERT_ENV="${WORK}/alert.env"
export PULLFM_ALERT_SPOOL_DIR="${WORK}/spool"
export PULLFM_ALERT_STATE_DIR="${WORK}/astate"
export PULLFM_ALERT_BIN="${HERE}/pullfm-alert"
export PULLFM_METRICS_URL="http://127.0.0.1:${FIX_PORT}/metrics"
export PULLFM_HEALTHZ_URL="http://127.0.0.1:${FIX_PORT}/healthz"
export PULLFM_READYZ_URL="http://127.0.0.1:${FIX_PORT}/readyz"

# Rewrites one sample in the served scrape. Fails loudly when the series is not
# in the fixture, because a mutation that matches nothing would make the case
# pass by never triggering anything.
set_metric() {
  local key="$1" value="$2" file="${WORK}/www/metrics"
  grep -q "^${key} " "${file}" || return 1
  awk -v k="${key}" -v v="${value}" '
    { i = index($0, " ")
      if (i > 0 && substr($0, 1, i - 1) == k) print k " " v; else print }
  ' "${file}" >"${file}.tmp" && mv "${file}.tmp" "${file}"
}

reset_state() { rm -f "${WORK}/wd.state"; }
export PULLFM_WATCHDOG_STATE="${WORK}/wd.state"

run_wd() { "${HERE}/pullfm-watchdog" >>"${WORK}/wd.log" 2>&1; }

# ntfy's `poll=1` returns the topic's whole retained history, so a naive
# substring match would see the PREVIOUS case's alert and report a positive for
# every case after the first. Every assertion below is therefore scoped to
# messages published at or after a watermark taken immediately before the
# trigger. Getting this wrong is how a negative control silently stops being
# one, which is exactly what happened on the first run of this file.
# The watermark is set to the NEXT second and then waited for, rather than to
# the current one. ntfy timestamps are whole seconds, so a watermark equal to
# "now" still admits a message published earlier in the same second - which is
# exactly the previous case's alert, and it made two negative controls report a
# failure on the second run of this file.
SINCE=0
mark() {
  SINCE=$(($(date -u +%s) + 1))
  while [ "$(date -u +%s)" -lt "${SINCE}" ]; do sleep 0.2; done
}

matched_since() {
  curl -fsS --max-time 3 "http://127.0.0.1:${NTFY_PORT}/${TOPIC}/json?poll=1" 2>/dev/null |
    python3 -c '
import json, sys
needle, since = sys.argv[1], int(sys.argv[2])
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    d = json.loads(line)
    if d.get("event") != "message":
        continue
    if d.get("time", 0) < since:
        continue
    if needle in d.get("title", "") or needle in d.get("message", ""):
        print("MATCH")
        break
' "$1" "${SINCE}"
}

expect_alert() {
  local needle="$1" label="$2" start elapsed
  start=$(date -u +%s)
  for _ in $(seq 1 20); do
    if [ -n "$(matched_since "${needle}")" ]; then
      elapsed=$(($(date -u +%s) - start))
      if [ "${elapsed}" -le 60 ]; then
        pass "${label}  delivered in ${elapsed}s"
      else
        fail "${label}  delivered in ${elapsed}s, over the 60s Gate 5 budget"
      fi
      return 0
    fi
    sleep 1
  done
  fail "${label}  NEVER delivered"
  return 1
}

expect_no_alert() {
  local needle="$1" label="$2"
  sleep 2
  if [ -n "$(matched_since "${needle}")" ]; then
    fail "${label}  fired when it should not have"
  else
    pass "${label}  correctly silent"
  fi
}

# ===========================================================================
# baseline: a healthy scrape must produce NOTHING
#
# Asserted first and deliberately. An alerting system that fires on a healthy
# system is worse than one that does not fire at all, because the operator
# learns to ignore it and then misses the real one.
# ===========================================================================
mark
reset_state
run_wd
sleep 1
run_wd
expect_no_alert "Pull.fm" "healthy baseline"

# ===========================================================================
# A2  a dependency is failing
# ===========================================================================
mark
set_metric 'pullfm_dependency_up{dependency="redis"}' 0 &&
  { run_wd; expect_alert "dependency redis is failing" "A2  dependency down"; } ||
  fail "A2  fixture has no pullfm_dependency_up series"
set_metric 'pullfm_dependency_up{dependency="redis"}' 1

# ===========================================================================
# S3  a fail-closed refusal, which is availability loss with no error
# ===========================================================================
mark
{
  echo 'pullfm_fail_closed_total{store="quota_limiter"} 0'
} >>"${WORK}/www/metrics"
reset_state
run_wd
set_metric 'pullfm_fail_closed_total{store="quota_limiter"}' 7
run_wd
expect_alert "failing closed on the quota_limiter" "S3  quota Redis fail-closed"

# ===========================================================================
# U1  MusicBrainz egress over 1 req/s
# ===========================================================================
mark
reset_state
set_metric pullfm_musicbrainz_pacer_dispatched_total 0
run_wd
sleep 2
set_metric pullfm_musicbrainz_pacer_dispatched_total 500
run_wd
expect_alert "MusicBrainz egress over budget" "U1  MusicBrainz over 1 req/s"

# ===========================================================================
# U1 negative control: paced traffic must NOT alert
# ===========================================================================
mark
reset_state
rm -rf "${WORK}/astate"
set_metric pullfm_musicbrainz_pacer_dispatched_total 0
run_wd
sleep 3
set_metric pullfm_musicbrainz_pacer_dispatched_total 2
run_wd
expect_no_alert "MusicBrainz egress over budget" "U1  paced traffic"

# ===========================================================================
# U3  the Last.fm 100 MB licence cap
# ===========================================================================
mark
reset_state
rm -rf "${WORK}/astate"
set_metric 'pullfm_cache_bytes{provider="lastfm"}' 90000000 &&
  { run_wd; expect_alert "licence cap" "U3  Last.fm cache over 80 MB"; } ||
  fail "U3  fixture has no pullfm_cache_bytes series"
set_metric 'pullfm_cache_bytes{provider="lastfm"}' -1

# ===========================================================================
# U4  a breaker open for longer than fifteen minutes
# ===========================================================================
mark
reset_state
rm -rf "${WORK}/astate"
set_metric 'pullfm_upstream_provider_status{provider="lastfm"}' 1
set_metric 'pullfm_upstream_provider_status_age_seconds{provider="lastfm"}' 1200
run_wd
expect_alert "lastfm breaker open" "U4  breaker open over 15 min"

# U4 negative control: degraded for only a moment must not alert.
mark
reset_state
rm -rf "${WORK}/astate"
set_metric 'pullfm_upstream_provider_status_age_seconds{provider="lastfm"}' 30
run_wd
expect_no_alert "lastfm breaker open" "U4  briefly degraded"
set_metric 'pullfm_upstream_provider_status{provider="lastfm"}' 0

# ===========================================================================
# Gate 7  sustained pool saturation, and only when SUSTAINED
# ===========================================================================
mark
reset_state
rm -rf "${WORK}/astate"
set_metric pullfm_db_pool_waiting 6
run_wd
expect_no_alert "database pool is saturated" "pool  one sample is not exhaustion"
run_wd
run_wd
expect_alert "database pool is saturated" "Gate 7  sustained pool saturation"
set_metric pullfm_db_pool_waiting 0

# ===========================================================================
# The origin is not answering at all
# ===========================================================================
mark
reset_state
rm -rf "${WORK}/astate"
rm -f "${WORK}/www/healthz"
run_wd
expect_no_alert "origin not answering" "healthz  one miss is not an outage"
run_wd
expect_alert "origin not answering" "local origin down (A1 backstop)"
printf '{"status":"ok"}' >"${WORK}/www/healthz"

# ===========================================================================
# /metrics itself unreachable: every other check is now silent, so say so
# ===========================================================================
mark
reset_state
rm -rf "${WORK}/astate"
mv "${WORK}/www/metrics" "${WORK}/metrics.bak"
run_wd
expect_alert "/metrics is not answering" "metrics endpoint unreachable"
mv "${WORK}/metrics.bak" "${WORK}/www/metrics"

# ===========================================================================
# J1-J4 backstop: a job failure whose own alert did not deliver
# ===========================================================================
mark
reset_state
rm -rf "${WORK}/astate"
mkdir -p "${WORK}/spool"
export PULLFM_JOB_SPOOL="${WORK}/spool/job-alerts.jsonl"
echo '{"ts":"x","unit":"pullfm-purge-audit.service","reason":"could-not-run","delivered":true}' >"${PULLFM_JOB_SPOOL}"
run_wd
echo '{"ts":"y","unit":"pullfm-purge-audit.service","reason":"could-not-run","delivered":false}' >>"${PULLFM_JOB_SPOOL}"
run_wd
expect_alert "alert did not send" "J1-J4  undelivered job alert backstop"

# ===========================================================================
# C4  staging left running past twelve hours
# ===========================================================================
if [ -r /proc/uptime ]; then
  mark
  reset_state
  rm -rf "${WORK}/astate"
  PULLFM_ALERT_ENV_LABEL=staging PULLFM_STAGING_MAX_UPTIME_S=1 run_wd
  expect_alert "staging has been up" "C4  staging left running"
else
  echo "  n/a   C4  needs /proc/uptime (Linux); not assertable on this host"
fi

echo "-------------------------------------------------------------"
if [ "${FAILED}" -eq 0 ]; then
  echo "PASS: every synthetic trigger reached ntfy, and the negative controls stayed silent."
else
  echo "FAIL: ${FAILED} check(s) failed. See ${WORK}/wd.log"
  cp "${WORK}/wd.log" ./watchdog-selftest.log 2>/dev/null || true
fi
exit "${FAILED}"
