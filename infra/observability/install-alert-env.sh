#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Write /etc/pullfm/alert.env from 1Password. This is the one command that
# configures the notification channel, and everything in this directory that
# pushes is inert without it.
#
#   ./infra/observability/install-alert-env.sh                 # write it here
#   ./infra/observability/install-alert-env.sh --check         # is it armed?
#   ./infra/observability/install-alert-env.sh --stdout        # write to stdout
#   ./infra/observability/install-alert-env.sh --print-shape   # what would be written, redacted
#
# Run it on the node, or run it locally and pipe the result over ssh:
#
#   ./infra/observability/install-alert-env.sh --stdout | ssh root@NODE \
#     'install -m 0600 -o root -g root /dev/stdin /etc/pullfm/alert.env'
#
# ---------------------------------------------------------------------------
# WHAT CHANGED ON 2026-07-29, AND WHY THIS FILE IS SHAPED THIS WAY NOW
#
# Alerting used to be a single push to an ntfy instance running on the operator's
# personal Hetzner box. Two things were wrong with that and only one of them was
# about confidentiality:
#
#   1. A product depended on personal infrastructure for its operational alerting.
#   2. Worse, and general: an alert channel that traverses infrastructure inside
#      the failure domain it reports on cannot report that domain failing.
#
# So the PRIMARY path is now a pull, not a push. The node emits a content-free
# heartbeat (pullfm-heartbeat); nginx serves it publicly; a scheduled GitHub
# Actions workflow outside every machine we own reads it, probes the public
# origin, and raises an issue when either goes quiet. That path needs NO
# credential on the node at all, which is why it is the primary one: a
# compromised node cannot forge health it does not sign, and cannot suppress an
# alarm it cannot reach. See DECISIONS.md SD-003.
#
# The push sink below is therefore OPTIONAL and secondary. It exists so an
# immediate notification is one 1Password value away, and it is deliberately
# provider-agnostic: point PULLFM_ALERT_SINK_URL at Grafana OnCall, Pushover, a
# Discord webhook or a hosted ntfy and nothing in this repository changes.
#
# ---------------------------------------------------------------------------
# THE ONE RULE THIS SCRIPT ENFORCES
#
# A resolved sink URL is never printed, never logged, never passed as a command
# line argument (where `ps` shows it to every user on the box), and never written
# anywhere except the destination file at mode 0600. For some providers the URL
# IS the entire credential - a Discord or Slack webhook URL is a bearer token
# with a hostname in front of it - so it is handled as one regardless of which
# provider is configured.
#
# `set -o pipefail` matters here specifically. Without it, `op read ... | tee`
# succeeds when `op` fails, and the file is written EMPTY, which produces a node
# that looks armed and delivers nothing. That is the exact failure this whole
# directory exists to remove, so it must not be reintroduced by the installer.
# ---------------------------------------------------------------------------
set -euo pipefail

DEST=${PULLFM_ALERT_ENV:-/etc/pullfm/alert.env}
VAULT=${PULLFM_OP_VAULT:-MCP}
ENV_LABEL=${PULLFM_ALERT_ENV_LABEL:-staging}
REPEAT_S=${PULLFM_ALERT_REPEAT_S:-3600}

# The heartbeat is the primary path and carries no secret, so its location and
# its public URL are plain configuration with real defaults. A default that works
# is the difference between a control that survives a rebuild and one that has to
# be remembered - see PULLFM-RISK-012, which was exactly that mistake.
BEAT_FILE=${PULLFM_HEARTBEAT_FILE:-/var/lib/pullfm/heartbeat/${ENV_LABEL}.json}
case "${ENV_LABEL}" in
  prod | production) BEAT_URL_DEFAULT=https://api.pull.fm/.well-known/pullfm-heartbeat ;;
  *) BEAT_URL_DEFAULT=https://api-staging.pull.fm/.well-known/pullfm-heartbeat ;;
esac
BEAT_URL=${PULLFM_HEARTBEAT_URL:-${BEAT_URL_DEFAULT}}

# THE DESTINATION IS ONE VALUE. Changing where Pull.fm pushes means editing this
# one 1Password item and re-running converge; there is no code change and no
# second place that has to agree. The transport shape is DERIVED from the URL
# rather than stored beside it, because a second field is a second thing to get
# wrong and every provider's URL already identifies it unambiguously.
SINK_ITEM="pull-fm/${ENV_LABEL}/ALERT_SINK_URL"
SINK_TOKEN_ITEM="pull-fm/${ENV_LABEL}/ALERT_SINK_TOKEN"

# The op:// forms below are the canonical references and the ones that belong in
# documentation. They are NOT how the values are resolved, and that is a trap
# this repository has already hit once and recorded in infra/lib/secrets.sh:
# `op read op://vault/item/field` cannot address an item whose TITLE contains a
# slash, and every Pull.fm item title does (`pull-fm/staging/...`). It fails with
# "isn't an item in the vault", which reads like a missing secret rather than a
# parsing limit. `op item get --fields label=` has no such restriction.
SINK_REF="op://${VAULT}/${SINK_ITEM}/password"
SINK_TOKEN_REF="op://${VAULT}/${SINK_TOKEN_ITEM}/password"

opfield() {
  op item get "$1" --vault "${VAULT}" --fields "label=$2" --reveal 2>/dev/null
}

# Derive the wire format from the URL. Explicit table, no guessing: an unknown
# host gets `webhook`, which posts JSON, because a wrong guess that silently
# sends the wrong shape is worse than a generic one that a provider rejects
# loudly.
sink_kind() {
  case "$1" in
    '') echo none ;;
    *discord.com/api/webhooks* | *discordapp.com/api/webhooks*) echo discord ;;
    *hooks.slack.com*) echo slack ;;
    *ntfy* | *://ntfy*) echo ntfy ;;
    *) echo "${PULLFM_ALERT_SINK_KIND:-webhook}" ;;
  esac
}

MODE=write
case "${1:-}" in
  --check) MODE=check ;;
  --stdout) MODE=stdout ;;
  --print-shape) MODE=shape ;;
  "") ;;
  *)
    echo "usage: install-alert-env.sh [--check|--stdout|--print-shape]" >&2
    exit 64
    ;;
esac

if [ "${MODE}" = shape ]; then
  cat <<EOF
# would be written to ${DEST}, mode 0600
PULLFM_ALERT_ENV_LABEL=${ENV_LABEL}
PULLFM_ALERT_REPEAT_S=${REPEAT_S}
PULLFM_HEARTBEAT_FILE=${BEAT_FILE}
PULLFM_HEARTBEAT_URL=${BEAT_URL}
PULLFM_ALERT_SINK_URL=<${SINK_REF}>
PULLFM_ALERT_SINK_TOKEN=<${SINK_TOKEN_REF}>
PULLFM_ALERT_SINK_KIND=<derived from the URL>
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# --check
#
# THIS USED TO BE THE BUG. It reported on the FILE and not on the network, and
# after the endpoint gained authentication it printed ARMED, exited 0, and was
# measurably wrong: the same node was refused 403 on every publish. A green
# arming check that proves nothing is worse than no check, because it is the one
# command whose entire job is to answer "can this node tell anyone anything".
#
# It now asks the network three questions and reports each one separately, in the
# order that matters:
#
#   1. Is the heartbeat being WRITTEN?   (the node's half of the primary path)
#   2. Is the heartbeat READABLE from outside?  (nginx, Cloudflare, the whole
#      chain the external watcher actually traverses)
#   3. If a push sink is configured, will it accept a publish RIGHT NOW?
#
# Question 2 is the one that would have caught the original defect, because it is
# answered by the same chain the watcher uses rather than by a local file.
# ---------------------------------------------------------------------------
if [ "${MODE}" = check ]; then
  rc=0
  if [ ! -f "${DEST}" ]; then
    echo "NOT ARMED: ${DEST} does not exist."
    echo "  The push sink is unconfigured. The heartbeat still has defaults, so check it below."
    rc=1
  else
    # shellcheck disable=SC1090
    . "${DEST}"
    perms=$(stat -c '%a %U' "${DEST}" 2>/dev/null || stat -f '%Lp %Su' "${DEST}")
    echo "env file: ${DEST} (${perms})"
  fi

  BEAT_FILE=${PULLFM_HEARTBEAT_FILE:-${BEAT_FILE}}
  BEAT_URL=${PULLFM_HEARTBEAT_URL:-${BEAT_URL}}
  STALE_S=${PULLFM_HEARTBEAT_STALE_S:-1800}

  # --- 1. is the beat being written ---------------------------------------
  if [ -f "${BEAT_FILE}" ]; then
    beat_epoch=$(sed -n 's/.*"epoch":\([0-9]*\).*/\1/p' "${BEAT_FILE}" 2>/dev/null)
    case "${beat_epoch}" in '' | *[!0-9]*) beat_epoch=0 ;; esac
    age=$(($(date -u +%s) - beat_epoch))
    if [ "${beat_epoch}" -eq 0 ]; then
      echo "NOT ARMED: heartbeat ${BEAT_FILE} exists but carries no epoch. The emitter is broken."
      rc=1
    elif [ "${age}" -gt "${STALE_S}" ]; then
      echo "NOT ARMED: heartbeat ${BEAT_FILE} is ${age}s old (ceiling ${STALE_S}s)."
      echo "  Check: systemctl status pullfm-heartbeat.timer"
      rc=1
    else
      echo "ARMED (local): heartbeat written ${age}s ago, pending=$(sed -n 's/.*"pending":\([0-9]*\).*/\1/p' "${BEAT_FILE}" 2>/dev/null)"
    fi
  else
    echo "NOT ARMED: no heartbeat at ${BEAT_FILE}. Nothing outside this node can tell it is alive."
    echo "  Check: systemctl status pullfm-heartbeat.timer, and that pullfm-heartbeat is installed."
    rc=1
  fi

  # --- 2. is it readable from outside -------------------------------------
  # The whole point. A local file proves the emitter ran; it says nothing about
  # nginx, the origin certificate, or Cloudflare, and the watcher traverses all
  # three. Skipped only when explicitly asked, so "I could not check" can never
  # be mistaken for "I checked and it was fine".
  if [ "${PULLFM_CHECK_SKIP_PUBLIC:-0}" = 1 ]; then
    echo "SKIPPED: public heartbeat reachability (PULLFM_CHECK_SKIP_PUBLIC=1). This is the check that matters."
  else
    pub=$(curl -s --max-time 15 -w '\n%{http_code}' "${BEAT_URL}" 2>/dev/null || printf '\n000')
    pub_code=${pub##*$'\n'}
    pub_body=${pub%$'\n'*}
    case "${pub_code}" in
      200)
        pub_epoch=$(printf '%s' "${pub_body}" | sed -n 's/.*"epoch":\([0-9]*\).*/\1/p')
        case "${pub_epoch}" in '' | *[!0-9]*) pub_epoch=0 ;; esac
        pub_age=$(($(date -u +%s) - pub_epoch))
        if [ "${pub_epoch}" -eq 0 ]; then
          echo "NOT ARMED: ${BEAT_URL} answered 200 but the body is not a heartbeat."
          rc=1
        elif [ "${pub_age}" -gt "${STALE_S}" ]; then
          echo "NOT ARMED: the PUBLIC heartbeat is ${pub_age}s old. The watcher is seeing a stale beat."
          rc=1
        else
          echo "ARMED (public): ${BEAT_URL} -> 200, ${pub_age}s old. The external watcher can see this node."
        fi
        ;;
      404)
        echo "NOT ARMED: ${BEAT_URL} -> 404. nginx is not serving the heartbeat."
        echo "  The location block is in infra/observability/README.md section 3."
        rc=1
        ;;
      000)
        echo "NOT ARMED: ${BEAT_URL} did not answer at all."
        rc=1
        ;;
      *)
        echo "NOT ARMED: ${BEAT_URL} -> ${pub_code}."
        rc=1
        ;;
    esac
  fi

  # --- 3. will the optional push sink accept a publish --------------------
  SINK_URL=${PULLFM_ALERT_SINK_URL:-${PULLFM_NTFY_URL:-}}
  SINK_TOKEN=${PULLFM_ALERT_SINK_TOKEN:-${PULLFM_NTFY_TOKEN:-}}
  if [ -z "${SINK_URL}" ]; then
    echo "sink: none configured. Alerts reach the operator through the heartbeat and the external"
    echo "  watcher only, so notification latency is one watcher interval. Set"
    echo "  ${SINK_REF} for an immediate push."
  else
    kind=$(sink_kind "${SINK_URL}")
    host=$(printf '%s' "${SINK_URL}" | sed -E 's#^(https?://[^/]+)/.*#\1#')
    if [ "${kind}" = ntfy ]; then
      # ntfy has an authorization probe that STORES NOTHING AND WAKES NOBODY: an
      # empty-body POST with Cache: no and Firebase: no. Verified on 2026-07-29
      # by firing it repeatedly and confirming the topic's stored message count
      # did not move. That is what makes it safe to run on every --check.
      probe=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
        -H 'Cache: no' -H 'Firebase: no' -H 'Content-Length: 0' \
        ${SINK_TOKEN:+-H "Authorization: Bearer ${SINK_TOKEN}"} \
        "${SINK_URL}" 2>/dev/null || echo 000)
      case "${probe}" in
        200) echo "sink: ntfy at ${host}, publish AUTHORISED (probe 200)" ;;
        401)
          echo "SINK NOT ARMED: 401. The token is invalid or absent. Re-run the installer."
          rc=1
          ;;
        403)
          echo "SINK NOT ARMED: 403. The credential may not publish to this topic."
          rc=1
          ;;
        *)
          echo "SINK NOT ARMED: endpoint unreachable (curl said '${probe}')."
          rc=1
          ;;
      esac
    else
      # For every other provider there is no side-effect-free probe: a webhook
      # POST delivers a message. So this reports what it actually knows -
      # configuration, not authorisation - and says so in those words rather than
      # printing something that reads like proof.
      echo "sink: ${kind} at ${host}, configured. NOT PROBED: ${kind} has no publish probe that"
      echo "  delivers nothing, so authorisation is unproven here. Prove it with:"
      echo "  ./infra/observability/alert-selftest.sh"
    fi
  fi

  [ "${rc}" -eq 0 ] && echo "RESULT: ARMED" || echo "RESULT: NOT ARMED"
  exit "${rc}"
fi

command -v op >/dev/null 2>&1 || {
  echo "install-alert-env.sh: the 1Password CLI (op) is not installed." >&2
  echo "The channel is deliberately not stored in git; there is no fallback." >&2
  exit 69
}

# The sink is OPTIONAL, and that is a change from the previous version, which
# exited 65 on a missing URL. It is optional because it is no longer the only
# path: a node with no sink at all still reports through the heartbeat and the
# external watcher. Refusing to write the env file in that state would leave the
# node without its heartbeat configuration too, which would break the path that
# does work in order to complain about the one that is merely absent.
SINK_URL=$(opfield "${SINK_ITEM}" password || true)
SINK_TOKEN=$(opfield "${SINK_TOKEN_ITEM}" password || true)
SINK_KIND=$(sink_kind "${SINK_URL}")

# A CONFIGURED SINK WITH NO CREDENTIAL IS REFUSED. This is the guard whose
# absence produced the KNOWN GAP: `op` resolved the token with `|| true`, an
# empty token was written, --check reported ARMED, and every publish was refused
# 403. An ntfy endpoint that needs auth and a webhook URL that carries its own
# secret are different cases, so only the first is guarded, and it is
# overridable for a genuinely anonymous instance rather than being absolute.
if [ "${SINK_KIND}" = ntfy ] && [ -z "${SINK_TOKEN}" ] && [ "${PULLFM_ALLOW_ANONYMOUS_NTFY:-0}" != 1 ]; then
  echo "install-alert-env.sh: ${SINK_TOKEN_REF} resolved to an empty value." >&2
  echo "An ntfy sink with no token writes a node that reads as configured and is refused" >&2
  echo "403 on every publish. Create the item, or set PULLFM_ALLOW_ANONYMOUS_NTFY=1 if the" >&2
  echo "instance really is anonymous - and read DECISIONS.md SD-002 first, because an" >&2
  echo "anonymous ntfy instance grants read and write on every topic it hosts." >&2
  exit 65
fi

render() {
  cat <<EOF
# Written by infra/observability/install-alert-env.sh. Do not edit by hand: the
# next converge overwrites this file, so a hand edit is a change that disappears
# on the next deploy and takes the control with it.
PULLFM_ALERT_ENV_LABEL=${ENV_LABEL}
PULLFM_ALERT_REPEAT_S=${REPEAT_S}

# --- the primary path: pull, no credential ---------------------------------
PULLFM_HEARTBEAT_FILE=${BEAT_FILE}
PULLFM_HEARTBEAT_URL=${BEAT_URL}

# --- the optional secondary path: an immediate push ------------------------
# PULLFM_ALERT_SINK_URL is a credential for most providers. Treat it as one.
PULLFM_ALERT_SINK_KIND=${SINK_KIND}
PULLFM_ALERT_SINK_URL=${SINK_URL}
PULLFM_ALERT_SINK_TOKEN=${SINK_TOKEN}
EOF

  # Compatibility, deliberately narrow. infra/staging/app/pullfm-job-alert reads
  # PULLFM_NTFY_URL directly instead of going through pullfm-alert, so an
  # ntfy-shaped sink is also exported under the old names to keep that path
  # working with no edit to a file this directory does not own. It is emitted
  # ONLY for kind=ntfy: exporting a Discord webhook as PULLFM_NTFY_URL would make
  # that script POST an ntfy-shaped request to an endpoint that rejects it, and a
  # silent 400 is worse than an obviously unconfigured leg.
  if [ "${SINK_KIND}" = ntfy ]; then
    cat <<EOF
PULLFM_NTFY_URL=${SINK_URL}
PULLFM_NTFY_TOKEN=${SINK_TOKEN}
EOF
  fi
}

if [ "${MODE}" = stdout ]; then
  render
  exit 0
fi

mkdir -p "$(dirname "${DEST}")"
chmod 0750 "$(dirname "${DEST}")" 2>/dev/null || true

# umask before the redirect, not chmod after it. A chmod after the write leaves a
# window in which the file exists world-readable, and on a shared node that
# window is all an unprivileged process needs.
(
  umask 077
  render >"${DEST}"
)
chown root:root "${DEST}" 2>/dev/null || true

echo "written: ${DEST}, mode 0600, sink kind=${SINK_KIND}"
echo "verify with: ./infra/observability/install-alert-env.sh --check"
echo "  (that now asks the NETWORK, not the file. A green check on an unreachable"
echo "   heartbeat was the defect this replaced.)"
