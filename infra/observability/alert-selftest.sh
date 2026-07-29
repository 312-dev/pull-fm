#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# End-to-end proof that the alert path delivers. Not that it is configured:
# that it DELIVERS, verified by reading the message back off the other side.
#
#   ./infra/observability/alert-selftest.sh            # against a local ntfy
#   ./infra/observability/alert-selftest.sh --live     # against the real channel
#
# ---------------------------------------------------------------------------
# WHY THIS FILE EXISTS AT ALL
#
# docs/RUNBOOK-INCIDENT.md section 10 records that this project has twice
# shipped a control that looked configured and was absent. An alert channel
# nobody has fired is the same defect as a backup nobody has restored, and it
# fails the same way: silently, at the exact moment it was supposed to help.
#
# So the default mode does not need any credential, any network egress, or any
# deployed infrastructure. It starts a real ntfy server in a container, arms a
# throwaway alert.env against it, sends through the SAME `pullfm-alert` binary
# the watchdog and the job handler use, then polls ntfy's own JSON API until the
# message comes back. If the message does not come back, the test fails. There
# is no assertion anywhere in here about a file existing or a variable being
# set, because that class of assertion is what produced the defect.
#
# --live does the same against whatever /etc/pullfm/alert.env points at. It
# cannot read the message back (a write-only publish token is the correct
# posture and cannot subscribe), so it proves delivery to the extent the
# transport allows: an accepted publish, plus a message the operator confirms by
# hand. That difference is stated in the output rather than glossed, because
# "the server accepted it" and "a human saw it" are not the same claim.
# ---------------------------------------------------------------------------
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SENDER="${HERE}/pullfm-alert"
MODE=local
[ "${1:-}" = "--live" ] && MODE=live

pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  FAILED=$((FAILED + 1))
}
FAILED=0

echo "pullfm alert self-test  (${MODE})  $(date -u +%FT%TZ)"
echo "-------------------------------------------------------------"

# ---------------------------------------------------------------------------
if [ "${MODE}" = live ]; then
  ENVFILE=${PULLFM_ALERT_ENV:-/etc/pullfm/alert.env}
  [ -f "${ENVFILE}" ] || {
    echo "  FAIL  ${ENVFILE} does not exist. The channel is not armed."
    exit 1
  }
  MARK="live-selftest-$(date -u +%s)"
  if PULLFM_ALERT_ENV="${ENVFILE}" "${SENDER}" \
    --key "${MARK}" \
    --title "Pull.fm alert self-test" \
    --priority default \
    --tags white_check_mark \
    --message "Live channel test. If you are reading this, the channel works. Marker ${MARK}." \
    --runbook "https://github.com/312-dev/pull-fm/blob/main/docs/RUNBOOK-INCIDENT.md"; then
    pass "publish accepted by the configured endpoint"
    echo
    echo "  Delivery to the SERVER is proven. Delivery to a HUMAN is not, and"
    echo "  cannot be proven from here. Confirm the notification arrived on the"
    echo "  subscribed device and record the marker ${MARK} in the runbook."
  else
    fail "publish rejected (exit $?). See ${PULLFM_ALERT_SPOOL_DIR:-/var/log/pullfm}/alerts.jsonl"
  fi
  exit "${FAILED}"
fi

# ---------------------------------------------------------------------------
# Local mode: a real ntfy, a real publish, a real read-back.
command -v docker >/dev/null 2>&1 || {
  echo "  SKIP  docker is not available; cannot start a local ntfy."
  exit 77
}

WORK=$(mktemp -d)
CONTAINER="pullfm-ntfy-selftest-$$"
PORT=${PULLFM_SELFTEST_PORT:-18080}
TOPIC="pullfm-selftest-$$"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

echo "starting a local ntfy on :${PORT}"
docker run -d --rm --name "${CONTAINER}" \
  -p "127.0.0.1:${PORT}:80" \
  binwiederhier/ntfy:latest serve \
  --base-url "http://127.0.0.1:${PORT}" >/dev/null 2>&1 || {
  echo "  SKIP  could not start binwiederhier/ntfy (no image, no network?)"
  exit 77
}

for _ in $(seq 1 40); do
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1 || {
  echo "  SKIP  local ntfy never became healthy"
  exit 77
}
pass "local ntfy is serving"

cat >"${WORK}/alert.env" <<EOF
PULLFM_NTFY_URL=http://127.0.0.1:${PORT}/${TOPIC}
PULLFM_NTFY_TOKEN=
PULLFM_ALERT_REPEAT_S=3600
PULLFM_ALERT_ENV_LABEL=selftest
EOF

export PULLFM_ALERT_ENV="${WORK}/alert.env"
export PULLFM_ALERT_SPOOL_DIR="${WORK}/spool"
export PULLFM_ALERT_STATE_DIR="${WORK}/state"

MARK="marker-$$-$(date -u +%s)"
START=$(date -u +%s)

# --- 1. it delivers --------------------------------------------------------
"${SENDER}" \
  --key "selftest-primary" \
  --title "Pull.fm alert self-test" \
  --priority high \
  --message "synthetic condition, ${MARK}" \
  --runbook "https://github.com/312-dev/pull-fm/blob/main/docs/RUNBOOK-INCIDENT.md" \
  >"${WORK}/send.log" 2>&1
SEND_RC=$?
[ "${SEND_RC}" -eq 0 ] && pass "sender exited 0 (delivered)" || fail "sender exited ${SEND_RC}"

# ntfy's JSON poll endpoint. `poll=1` returns the retained messages and closes
# instead of holding the stream open, which is what makes this assertable in a
# script rather than a manual eyeball.
FOUND=""
for _ in $(seq 1 30); do
  BODY=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/${TOPIC}/json?poll=1" 2>/dev/null || true)
  case "${BODY}" in *"${MARK}"*) FOUND=${BODY}; break ;; esac
  sleep 1
done
END=$(date -u +%s)
ELAPSED=$((END - START))

if [ -n "${FOUND}" ]; then
  pass "message read back off ntfy in ${ELAPSED}s (Gate 5 budget: 60s)"
  [ "${ELAPSED}" -le 60 ] || fail "delivery took ${ELAPSED}s, over the 60s Gate 5 budget"
  case "${FOUND}" in
    *"Pull.fm alert self-test"*) pass "title survived the transport" ;;
    *) fail "title missing from the delivered message" ;;
  esac
  case "${FOUND}" in
    *"RUNBOOK-INCIDENT"*) pass "runbook link survived the transport" ;;
    *) fail "runbook link missing from the delivered message" ;;
  esac
else
  fail "message NEVER arrived. The channel does not deliver."
fi

# --- 2. it deduplicates ----------------------------------------------------
"${SENDER}" --key "selftest-primary" --title "Pull.fm alert self-test" \
  --message "second copy, ${MARK}" >/dev/null 2>&1
[ $? -eq 5 ] && pass "a repeat inside the window is suppressed (exit 5)" ||
  fail "duplicate was not suppressed; the channel will flood and be muted"

# --- 3. it resolves --------------------------------------------------------
"${SENDER}" --key "selftest-primary" --title "Pull.fm alert self-test" \
  --resolve --message "cleared" >/dev/null 2>&1
RESOLVE_RC=$?
[ "${RESOLVE_RC}" -eq 0 ] && pass "resolve notice delivered (exit 0)" ||
  fail "resolve notice failed (exit ${RESOLVE_RC})"

BODY=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/${TOPIC}/json?poll=1" 2>/dev/null || true)
case "${BODY}" in
  *"RESOLVED"*) pass "the resolve notice is distinguishable from the alert" ;;
  *) fail "no RESOLVED message on the topic" ;;
esac

# A resolve with no prior firing must stay silent, or every watchdog tick sends
# an all-clear for a condition that was never true.
"${SENDER}" --key "never-fired-$$" --title "x" --resolve >/dev/null 2>&1
[ $? -eq 0 ] && pass "resolve with nothing outstanding is silent" ||
  fail "resolve with nothing outstanding was not silent"

# --- 4. it records the truth when there is no channel ----------------------
cat >"${WORK}/empty.env" <<'EOF'
PULLFM_NTFY_URL=
EOF
PULLFM_ALERT_ENV="${WORK}/empty.env" "${SENDER}" \
  --key "selftest-unarmed" --title "unarmed" --message "x" >/dev/null 2>&1
[ $? -eq 3 ] && pass "an unconfigured channel reports exit 3, not success" ||
  fail "an unconfigured channel did not report itself"

# --- 5. the spool is a complete, parseable record -------------------------
SPOOLFILE="${PULLFM_ALERT_SPOOL_DIR}/alerts.jsonl"
if [ -f "${SPOOLFILE}" ]; then
  LINES=$(wc -l <"${SPOOLFILE}" | tr -d ' ')
  if python3 -c "
import json
ok = 0
for line in open('${SPOOLFILE}'):
    line = line.strip()
    if not line:
        continue
    json.loads(line)
    ok += 1
print(ok)
" >"${WORK}/parsed" 2>/dev/null; then
    pass "spool has ${LINES} lines and every one parses as JSON"
  else
    fail "spool contains a line that is not valid JSON"
  fi
  grep -q '"delivered":false' "${SPOOLFILE}" &&
    pass "an undelivered alert is recorded as undelivered" ||
    fail "the spool does not record non-delivery"
else
  fail "no spool was written at ${SPOOLFILE}"
fi

echo "-------------------------------------------------------------"
if [ "${FAILED}" -eq 0 ]; then
  echo "PASS: the alert path delivers end to end."
else
  echo "FAIL: ${FAILED} check(s) failed."
fi
exit "${FAILED}"
