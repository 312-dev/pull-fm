#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Write /etc/pullfm/alert.env from 1Password. This is the one command that arms
# the notification channel, and everything else in this directory is inert
# without it.
#
#   ./infra/observability/install-alert-env.sh                 # write it here
#   ./infra/observability/install-alert-env.sh --check         # is it armed?
#   ./infra/observability/install-alert-env.sh --print-shape   # what would be written, redacted
#
# Run it on the node, or run it locally and pipe the result over ssh:
#
#   ./infra/observability/install-alert-env.sh --stdout | ssh root@NODE \
#     'install -m 0600 -o root -g root /dev/stdin /etc/pullfm/alert.env'
#
# ---------------------------------------------------------------------------
# THE ONE RULE THIS SCRIPT ENFORCES
#
# The resolved URL is never printed, never logged, never passed as a command
# line argument (where it would be visible in `ps` to every user on the box),
# and never written anywhere except the destination file at mode 0600. It is a
# credential: on ntfy the topic name is the whole access control, so a URL in a
# log is a channel anyone can read and forge into.
#
# `set -o pipefail` matters here specifically. Without it, `op read ... | tee`
# succeeds when `op` fails, and the file is written EMPTY, which produces a node
# that looks armed and delivers nothing. That is the exact failure this whole
# phase exists to remove, so it must not be reintroduced by the installer.
# ---------------------------------------------------------------------------
set -euo pipefail

DEST=${PULLFM_ALERT_ENV:-/etc/pullfm/alert.env}
VAULT=${PULLFM_OP_VAULT:-MCP}
ENV_LABEL=${PULLFM_ALERT_ENV_LABEL:-staging}
REPEAT_S=${PULLFM_ALERT_REPEAT_S:-3600}

URL_ITEM="pull-fm/${ENV_LABEL}/ALERT_NTFY_URL"
TOKEN_ITEM="pull-fm/${ENV_LABEL}/ALERT_NTFY_TOKEN"

# The op:// forms below are the canonical references and the ones that belong in
# documentation. They are NOT how the values are resolved, and that is a trap
# this repository has already hit once and recorded in infra/lib/secrets.sh:
# `op read op://vault/item/field` cannot address an item whose TITLE contains a
# slash, and every Pull.fm item title does (`pull-fm/staging/...`). It fails
# with "isn't an item in the vault", which reads like a missing secret rather
# than a parsing limit. `op item get --fields label=` has no such restriction.
URL_REF="op://${VAULT}/${URL_ITEM}/password"
TOKEN_REF="op://${VAULT}/${TOKEN_ITEM}/password"

opfield() {
  op item get "$1" --vault "${VAULT}" --fields "label=$2" --reveal 2>/dev/null
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
PULLFM_NTFY_URL=<${URL_REF}>
PULLFM_NTFY_TOKEN=<${TOKEN_REF}>
PULLFM_ALERT_REPEAT_S=${REPEAT_S}
PULLFM_ALERT_ENV_LABEL=${ENV_LABEL}
EOF
  exit 0
fi

if [ "${MODE}" = check ]; then
  # Deliberately reports on the FILE, not on 1Password. "Can the operator's
  # laptop reach the vault" and "is this node able to tell anyone anything" are
  # different questions and only the second one matters at 3am.
  if [ ! -f "${DEST}" ]; then
    echo "NOT ARMED: ${DEST} does not exist. Nothing on this node can notify anyone."
    exit 1
  fi
  # shellcheck disable=SC1090
  . "${DEST}"
  if [ -z "${PULLFM_NTFY_URL:-}" ]; then
    echo "NOT ARMED: ${DEST} exists but sets no PULLFM_NTFY_URL."
    exit 1
  fi
  perms=$(stat -c '%a %U' "${DEST}" 2>/dev/null || stat -f '%Lp %Su' "${DEST}")
  echo "ARMED: ${DEST} (${perms}), endpoint host $(printf '%s' "${PULLFM_NTFY_URL}" | sed -E 's#^(https?://[^/]+)/.*#\1#')"
  # The host is safe to print. The TOPIC is not, and is what the sed strips.
  exit 0
fi

command -v op >/dev/null 2>&1 || {
  echo "install-alert-env.sh: the 1Password CLI (op) is not installed." >&2
  echo "The channel is deliberately not stored in git; there is no fallback." >&2
  exit 69
}

URL=$(opfield "${URL_ITEM}" password || true)
[ -n "${URL}" ] || {
  echo "install-alert-env.sh: ${URL_REF} resolved to an empty value." >&2
  echo "Create the item, or set PULLFM_ALERT_ENV_LABEL to the right environment." >&2
  exit 65
}

# A missing token is legitimate rather than an error: an anonymous public
# instance needs none, and the staging channel is deliberately one of those. A
# self-hosted instance with auth on needs it, so its absence must not be
# converted into a silent empty string on a node that requires one - which is
# why --check reports the endpoint host, and why the self-test publishes for
# real instead of trusting this file.
TOKEN=$(opfield "${TOKEN_ITEM}" password || true)

render() {
  cat <<EOF
# Written by infra/observability/install-alert-env.sh. Do not edit by hand and
# do not copy anywhere: PULLFM_NTFY_URL is a credential.
PULLFM_NTFY_URL=${URL}
PULLFM_NTFY_TOKEN=${TOKEN}
PULLFM_ALERT_REPEAT_S=${REPEAT_S}
PULLFM_ALERT_ENV_LABEL=${ENV_LABEL}
EOF
}

if [ "${MODE}" = stdout ]; then
  render
  exit 0
fi

mkdir -p "$(dirname "${DEST}")"
chmod 0750 "$(dirname "${DEST}")" 2>/dev/null || true

# umask before the redirect, not chmod after it. A chmod after the write leaves
# a window in which the file exists world-readable, and on a shared node that
# window is all an unprivileged process needs.
(
  umask 077
  render >"${DEST}"
)
chown root:root "${DEST}" 2>/dev/null || true

echo "armed: ${DEST} written, mode 0600"
echo "verify with: ./infra/observability/install-alert-env.sh --check"
echo "prove with:  /usr/local/bin/pullfm-alert --key install-test --title 'Pull.fm channel test' --message 'armed at $(date -u +%FT%TZ)'"
