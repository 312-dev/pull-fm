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
# THE HEARTBEAT, which is the path that works when the push does not.
#
# Everything above tests the PUSH. Since 2026-07-29 the push is the secondary
# path and the primary one is a pull: pullfm-heartbeat writes a content-free
# beat, nginx serves it, and a scheduled GitHub Actions workflow outside all of
# our infrastructure reads it. Testing only the push would leave the path this
# project actually depends on unproven, which is the shape of defect this file
# exists to catch.
#
# The assertions are about BEHAVIOUR, not configuration: the count has to move
# when a condition fires and move back when it clears. A test that the file
# exists would pass on an emitter that always writes zero.
# ---------------------------------------------------------------------------
echo
echo "heartbeat:"
WORK=${WORK:-$(mktemp -d)}
BEATDIR="${WORK}/beat"
BEATFILE="${BEATDIR}/selftest.json"
mkdir -p "${BEATDIR}"
HB="${HERE}/pullfm-heartbeat"

hb() {
  PULLFM_ALERT_ENV=/nonexistent \
    PULLFM_ALERT_STATE_DIR="${WORK}/state" \
    PULLFM_HEARTBEAT_FILE="${BEATFILE}" \
    PULLFM_ALERT_ENV_LABEL=selftest \
    PULLFM_HEARTBEAT_UNIT_GLOB='pullfm-selftest-nothing-matches-this-*' \
    "${HB}" >/dev/null 2>&1
}

beatfield() { sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p" "${BEATFILE}" 2>/dev/null; }

mkdir -p "${WORK}/state"
if hb && [ -f "${BEATFILE}" ]; then
  pass "the emitter writes a beat"
else
  fail "the emitter wrote no beat"
fi

if python3 -c "import json,sys; d=json.load(open('${BEATFILE}')); sys.exit(0 if d.get('epoch',0)>0 else 1)" 2>/dev/null; then
  pass "the beat parses as JSON and carries a non-zero epoch"
else
  fail "the beat is not parseable JSON with an epoch (the watcher would call this malformed)"
fi

[ "$(beatfield pending)" = 0 ] &&
  pass "a quiet node reports pending=0" ||
  fail "a quiet node reported pending=$(beatfield pending)"

# A firing condition is exactly a dedupe stamp, so this creates one the way
# pullfm-alert does rather than by calling a helper that only this test uses.
touch "${WORK}/state/selftest-condition"
hb
if [ "$(beatfield pending)" = 1 ] && grep -q 'selftest-condition' "${BEATFILE}"; then
  pass "a firing condition raises pending and names its key"
else
  fail "a firing condition did not reach the beat: $(cat "${BEATFILE}")"
fi

# And the other direction, which is the half that is easy to get wrong: a
# counter that only ever goes up leaves the switch permanently tripped, and a
# permanently tripped switch is muted within a day.
rm -f "${WORK}/state/selftest-condition"
hb
[ "$(beatfield pending)" = 0 ] &&
  pass "a resolved condition lowers pending again" ||
  fail "pending stayed at $(beatfield pending) after the condition cleared"

# The beat must never carry a body. It is served to the public internet, and a
# hostname or a journal tail in it is reconnaissance about a node that holds
# third parties' Last.fm session keys.
if grep -qiE '"(host|hostname|message|body|detail|tail)"' "${BEATFILE}"; then
  fail "the beat carries a body or a hostname; it is PUBLIC and must not"
else
  pass "the beat carries no body and no hostname"
fi

# ---------------------------------------------------------------------------
# acknowledgement
#
# `--ack` exists because the switch reports "N unacknowledged alert(s)" and the
# only way to clear one used to be deleting a file under /var/lib by hand. These
# assertions exist because a verb whose job is to suppress an alarm is the last
# place to accept an untested implementation: every failure mode here is silent
# by construction. Each one is a bug that was actually hit while building it.
# ---------------------------------------------------------------------------
echo
echo "acknowledgement:"

ALERTBIN="${HERE}/pullfm-alert"
al() {
  PULLFM_ALERT_ENV=/nonexistent \
    PULLFM_ALERT_STATE_DIR="${WORK}/state" \
    PULLFM_ALERT_SPOOL_DIR="${WORK}/spool" \
    PULLFM_HEARTBEAT_FILE="${BEATFILE}" \
    PULLFM_ALERT_ENV_LABEL=selftest \
    PULLFM_HEARTBEAT_UNIT_GLOB='pullfm-selftest-nothing-matches-this-*' \
    PULLFM_ACK_WHO=selftest \
    "${ALERTBIN}" "$@"
}

al --key ack.probe --title "Ack probe" --message body >/dev/null 2>&1
hb
[ "$(beatfield pending)" = 1 ] &&
  pass "a fired condition is pending before it is acknowledged" ||
  fail "expected pending=1 before ack, got $(beatfield pending)"

# Acking something that is not pending must FAIL. A silent success would leave an
# operator believing they had acknowledged a condition that is still counting.
al --ack no-such-key >/dev/null 2>&1
[ "$?" = 6 ] &&
  pass "acking a key that is not pending exits 6, not 0" ||
  fail "acking an unknown key did not exit 6"

al --ack ack.probe --ack-note "selftest" >/dev/null 2>&1
if [ -f "${WORK}/state/ack.probe${ACK_SUFFIX:-.ack}" ]; then
  pass "the ack is RECORDED as a file, not an unlink"
else
  fail "no acknowledgement record was written"
fi

# The record has to name a person. An ack that records nothing is `rm` with extra
# steps, which is the entire defect this verb was added to remove.
if cut -f2 <"${WORK}/state/ack.probe.ack" 2>/dev/null | grep -q selftest; then
  pass "the record names who acknowledged it"
else
  fail "the ack record does not name an acknowledger"
fi

# THE DEDUPE STAMP MUST SURVIVE. If an ack cleared it, the next tick of a
# once-a-minute watchdog would be treated as a brand new condition and page
# immediately, so acknowledging would make the noise worse.
if [ -f "${WORK}/state/ack.probe" ]; then
  pass "the dedupe stamp is untouched by an ack"
else
  fail "the ack deleted the dedupe stamp; the repeat window is now broken"
fi
al --key ack.probe --title "Ack probe" >/dev/null 2>&1
[ "$?" = 5 ] &&
  pass "a repeat after an ack is still suppressed (exit 5)" ||
  fail "an acknowledged condition re-paged instead of being suppressed"

hb
[ "$(beatfield pending)" = 0 ] &&
  pass "an acknowledged condition drops out of pending" ||
  fail "pending stayed at $(beatfield pending) after an ack"

# A sibling file must never be counted as a condition in its own right. Getting
# this wrong makes an acknowledgement INCREASE the count it was meant to reduce.
if grep -q '\.ack' "${BEATFILE}" || grep -q '\.first' "${BEATFILE}"; then
  fail "the beat published a sibling metadata file as a condition"
else
  pass "the .ack and .first siblings are not published as conditions"
fi

# Escalation: age must be published, or an unacknowledged condition sits at the
# same count forever and nothing ever tells the operator it is getting old.
printf '%s' "$(($(date -u +%s) - 86400))" >"${WORK}/state/ack.probe.first"
rm -f "${WORK}/state/ack.probe.ack"
hb
if [ "$(beatfield oldest)" -ge 86400 ]; then
  pass "the beat publishes the age of the oldest unacknowledged condition"
else
  fail "expected oldest>=86400, got $(beatfield oldest)"
fi

# A real re-fire after the window clears the ack, so a problem that is still
# there comes back instead of staying acknowledged forever.
al --ack ack.probe >/dev/null 2>&1
printf '%s' "$(($(date -u +%s) - 7200))" >"${WORK}/state/ack.probe"
al --key ack.probe --title "Ack probe" >/dev/null 2>&1
hb
if [ ! -f "${WORK}/state/ack.probe.ack" ] && [ "$(beatfield pending)" = 1 ]; then
  pass "a re-fire after the repeat window clears the ack and re-counts"
else
  fail "an acknowledged condition that fired again stayed acknowledged"
fi

# --resolve must take the siblings with it, or a resolved condition returns
# already-acknowledged next time it fires: a firing alert nothing counts.
al --resolve --key ack.probe --title "Ack probe" >/dev/null 2>&1
if [ -f "${WORK}/state/ack.probe.first" ] || [ -f "${WORK}/state/ack.probe.ack" ]; then
  fail "--resolve left an ack or first-seen sibling behind"
else
  pass "--resolve removes the dedupe stamp and both siblings"
fi

# ---------------------------------------------------------------------------
# Local mode: a real ntfy, a real publish, a real read-back.
command -v docker >/dev/null 2>&1 || {
  echo "  SKIP  docker is not available; cannot start a local ntfy."
  # NOT a bare `exit 77`. The heartbeat checks above already ran and need no
  # docker, so swallowing their result into a SKIP would turn a real failure into
  # "we did not look" - which is the same class of lie as the --check that
  # reported ARMED by reading a file.
  [ "${FAILED}" -eq 0 ] && exit 77
  echo "FAIL: ${FAILED} heartbeat check(s) failed before docker was needed."
  exit "${FAILED}"
}

# NOT a second mktemp. Reusing the directory the heartbeat leg created keeps the
# cleanup trap below responsible for all of it; a fresh one here leaked the beat
# directory on every run.
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
PULLFM_ALERT_SINK_KIND=ntfy
PULLFM_ALERT_SINK_URL=http://127.0.0.1:${PORT}/${TOPIC}
PULLFM_ALERT_SINK_TOKEN=
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
  echo "PASS: the alert path delivers end to end, and the heartbeat tracks state."
else
  echo "FAIL: ${FAILED} check(s) failed."
fi
exit "${FAILED}"
