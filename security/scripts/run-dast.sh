#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pull.fm - run a ZAP scan. One command, from a bare checkout.
#
#   security/scripts/run-dast.sh baseline https://api-staging.pull.fm
#   security/scripts/run-dast.sh active   https://api-staging.pull.fm
#
# The token comes from PULLFM_ZAP_TOKEN, or from 1Password when
# PULLFM_TOKEN_OP_REF is set. It is never written to disk and never printed.
#
# WHAT THIS SCRIPT IS FOR
#
# Before it existed, security/zap/ was four carefully argued configuration files
# that had never been executed. security/AUDIT-2026-07-29.md F19: "There is no
# DAST job in any workflow. security/zap/ is written, tested by hand, and wired
# to nothing." A scan you have to reconstruct from a README at 2am is a scan
# that does not run.
#
# THE CONSTRAINT THAT SHAPES EVERYTHING BELOW
#
# MusicBrainz permits 1 request per second GLOBALLY per IP and revokes without
# appeal. iTunes is roughly 20 per minute. docs/PLAN.md section 8 calls
# exceeding either product-ending. A DAST crawler sends garbage identifiers by
# construction and every garbage identifier is a guaranteed cache miss, so the
# scanner is the single most dangerous client this API will ever have.
#
# Three controls, in order of strength:
#
#   1. The scanned spec has provider-reaching operations REMOVED, by
#      security/zap/scripts/scope-upstream.mjs against an explicit register.
#      ZAP never learns those routes exist. There is no spider, so it cannot
#      find them another way.
#   2. The scan subject is proved to hold ZERO provider connections before any
#      subject-gated route is scanned. Proved on the wire, not assumed.
#   3. Provider status and (where reachable) the MusicBrainz pacer counters are
#      snapshotted before and after, and a rise is reported.
#
# See security/DAST-RUNBOOK.md for what to do with the output.
# ---------------------------------------------------------------------------
set -euo pipefail

# Pinned by digest, not by `:stable`. Gate 8 requires pinned tool versions, and
# a mutable tag on the scanner means a green result is only as trustworthy as
# whoever last pushed it. ZAP 2.17.0.
ZAP_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# security/.gitignore already ignores `zap/work/`, and its comment says exactly
# why: the reports can contain request and response bodies from a scan against
# staging, and this repository is public. Writing anywhere else would put an
# authenticated scan transcript one `git add -A` away from being published.
# Note the root .gitignore's `*.sarif` does NOT cover `zap-baseline.sarif.json`,
# which is the name ZAP actually produces, so the directory ignore is the one
# doing the work.
OUT_DIR="${PULLFM_DAST_OUT:-$REPO_ROOT/security/zap/work}"

die() {
  printf 'FAIL    %s\n' "$*" >&2
  exit 1
}
note() { printf '        %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

PLAN_NAME="${1:-}"
TARGET="${2:-${PULLFM_ZAP_TARGET:-}}"

case "$PLAN_NAME" in
baseline | active) ;;
*)
  cat >&2 <<'USAGE'
Usage: security/scripts/run-dast.sh <baseline|active> <target-url>

  baseline  Passive only. Sends no attack payloads. This is the Gate 8 plan.
  active    Sends attack payloads. Staging only. Read the plan header first.

Environment:
  PULLFM_ZAP_TOKEN      bearer token for the DAST subject (required)
  PULLFM_TOKEN_OP_REF   1Password secret reference, used when the above is unset
  PULLFM_METRICS_URL    reachable /metrics, to watch the MusicBrainz pacer
  PULLFM_METRICS_TOKEN  bearer for the above
  PULLFM_DAST_OUT       report directory (default security/zap/work, gitignored)
  ZAP_IMAGE             pinned ZAP image, digest form
USAGE
  exit 2
  ;;
esac

[ -n "$TARGET" ] || die "no target. Pass one, or set PULLFM_ZAP_TARGET."
TARGET="${TARGET%/}"

# The plan grades findings and exits non-zero on High. Everything before that
# point must fail loudly rather than degrade, because a scan that ran against
# the wrong thing still produces a report someone will cite.
command -v docker >/dev/null 2>&1 || die "docker is required."
command -v node >/dev/null 2>&1 || die "node is required."

if [ -z "${PULLFM_ZAP_TOKEN:-}" ] && [ -n "${PULLFM_TOKEN_OP_REF:-}" ]; then
  command -v op >/dev/null 2>&1 ||
    die "PULLFM_TOKEN_OP_REF is set but the 1Password CLI is not installed."
  PULLFM_ZAP_TOKEN="$(op read "$PULLFM_TOKEN_OP_REF")"
  export PULLFM_ZAP_TOKEN
fi
[ -n "${PULLFM_ZAP_TOKEN:-}" ] ||
  die "PULLFM_ZAP_TOKEN is unset. An unauthenticated scan of an API whose entire
        surface requires auth tests the 401 handler and nothing else."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

# ---------------------------------------------------------------------------
# Preflight. Every assertion here is one that, if false, turns the scan into a
# green tick over an empty result.
# ---------------------------------------------------------------------------
step "Preflight against $TARGET"

health_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$TARGET/healthz" || echo 000)"
[ "$health_code" = "200" ] ||
  die "GET /healthz answered $health_code. The origin is not serving; a scan now
        would grade a Cloudflare error page."
note "GET /healthz 200"

me_body="$WORK/me.json"
me_code="$(curl -sS -o "$me_body" -w '%{http_code}' --max-time 20 \
  -H "Authorization: Bearer $PULLFM_ZAP_TOKEN" "$TARGET/v1/me" || echo 000)"
[ "$me_code" = "200" ] ||
  die "GET /v1/me answered $me_code with the supplied token. Every subsequent
        request would 401 and the scan would find nothing while exiting 0."
note "GET /v1/me 200, token is live"

# The subject-gated routes (/v1/feed, /v1/recommendations, /v1/stations*) egress
# to ListenBrainz only when the CALLING SUBJECT has a stored credential. That is
# a property of the account, not of the configuration, so it is measured here
# rather than assumed. A scan subject that later gains a connection silently
# turns four safe routes into four egress routes; this is what notices.
CONNECTIONS="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(d.connectionCount ?? "unknown"));
' "$me_body")"

ALLOW_GATED=()
if [ "$CONNECTIONS" = "0" ]; then
  ALLOW_GATED=(--allow-subject-gated)
  note "scan subject holds 0 provider connections, so subject-gated routes cannot egress"
else
  note "scan subject holds $CONNECTIONS provider connection(s): subject-gated routes EXCLUDED"
fi

# ---------------------------------------------------------------------------
# Provider and pacer baseline.
# ---------------------------------------------------------------------------
step "Upstream baseline"
curl -sS --max-time 20 "$TARGET/v1/config" -o "$OUT_DIR/providers-before.json" ||
  die "could not read /v1/config for a provider baseline."
note "provider status recorded -> $OUT_DIR/providers-before.json"

read_metrics() {
  local dest="$1"
  [ -n "${PULLFM_METRICS_URL:-}" ] || return 1
  local auth=()
  [ -n "${PULLFM_METRICS_TOKEN:-}" ] &&
    auth=(-H "Authorization: Bearer $PULLFM_METRICS_TOKEN")
  curl -sSf --max-time 20 "${auth[@]}" "$PULLFM_METRICS_URL" -o "$dest"
}

METRICS_AVAILABLE=0
if [ -n "${PULLFM_METRICS_URL:-}" ]; then
  read_metrics "$OUT_DIR/metrics-before.txt" ||
    die "PULLFM_METRICS_URL is set but unreadable. Refusing to run: asking for
        the pacer counters and not getting them must not look the same as the
        counters being flat."
  METRICS_AVAILABLE=1
  note "pacer baseline captured -> $OUT_DIR/metrics-before.txt"
else
  note "PULLFM_METRICS_URL unset: pacer counters will NOT be observed directly."
  note "  /metrics is loopback-or-METRICS_TOKEN only and denied at nginx, so it"
  note "  is not reachable from the public edge by design. The scan is still"
  note "  MusicBrainz-safe by construction (no HTTP route reaches the"
  note "  MusicBrainz client; see security/zap/upstream-scope.tsv), but that is"
  note "  an argument from code rather than a measurement. Set METRICS_TOKEN on"
  note "  the node to upgrade it to a measurement."
fi

# ---------------------------------------------------------------------------
# Build the spec ZAP is allowed to see. Two filters, two different questions.
# ---------------------------------------------------------------------------
step "Building the DAST-safe spec"
RAW="$WORK/openapi-raw.json"
if [ -n "${PULLFM_SPEC_FILE:-}" ]; then
  cp "$PULLFM_SPEC_FILE" "$RAW"
  note "spec from $PULLFM_SPEC_FILE"
else
  curl -sSf --max-time 30 "$TARGET/openapi.json" -o "$RAW" ||
    die "could not fetch $TARGET/openapi.json. Set PULLFM_SPEC_FILE to scan
        against a spec built locally instead."
  note "spec from $TARGET/openapi.json"
fi

# Order matters. scope-upstream runs on the RAW document so its reconciliation
# covers every operation the API declares, including the ones prune removes; a
# register that only had to cover the pruned subset could not detect a new
# destructive-and-egressing route.
node "$REPO_ROOT/security/zap/scripts/scope-upstream.mjs" \
  "$RAW" "$WORK/scoped.json" "${ALLOW_GATED[@]+"${ALLOW_GATED[@]}"}"
node "$REPO_ROOT/security/zap/scripts/prune-openapi.mjs" \
  "$WORK/scoped.json" "$WORK/dast-safe.json"

cp "$WORK/dast-safe.json" "$OUT_DIR/dast-safe-spec.json"

OPS="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const M = ["get","put","post","delete","options","head","patch","trace"];
  let n = 0;
  for (const item of Object.values(d.paths)) for (const m of M) if (item[m]) n++;
  process.stdout.write(String(n));
' "$WORK/dast-safe.json")"
[ "$OPS" -gt 0 ] || die "the DAST-safe spec has zero operations."
note "$OPS operation(s) will be scanned"

# ---------------------------------------------------------------------------
# Run it.
# ---------------------------------------------------------------------------
step "Running the $PLAN_NAME plan"
RUN="$WORK/wrk"
mkdir -p "$RUN/reports"
cp "$WORK/dast-safe.json" "$RUN/dast-safe.json"

PLAN_SRC="$REPO_ROOT/security/zap/plans/$PLAN_NAME.yaml"

# The plan hands the credential to ZAP through the `replacer` job, and that job
# is the ONE place the Automation Framework does not expand ${...}. Proved in
# the pinned 2.17.0 image against a local echo server: a literal
# `replacementString` arrives as `Authorization: Bearer <literal>`, while
# `${PULLFM_ZAP_TOKEN}` arrives verbatim, so every request 401s. Neither an OS
# environment variable nor one declared in `env.vars` is expanded there.
#
# So the substitution happens here, once, into an ephemeral copy that lives in a
# 0700 mktemp directory removed on exit. The checked-in plan keeps the
# `${PULLFM_ZAP_TOKEN}` marker, which is what keeps the credential out of a
# public repository. Nothing else in the plan is rewritten: the file ZAP runs is
# byte-identical to the file in git apart from that one value, so "read the file
# that actually ran" still holds.
umask 077
node -e '
  const fs = require("node:fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  const marker = "${PULLFM_ZAP_TOKEN}";
  if (!src.includes(marker)) {
    process.stderr.write(
      "FAIL    the plan no longer contains " + marker + ", so this script cannot " +
      "tell where to put the credential. A plan that runs unauthenticated " +
      "reports clean over 401s.\n");
    process.exit(1);
  }
  fs.writeFileSync(process.argv[2], src.split(marker).join(process.env.PULLFM_ZAP_TOKEN), { mode: 0o600 });
' "$PLAN_SRC" "$RUN/plan.yaml"

# The replacer `url` is a static allowlist of hosts the token may be handed to
# (see the plan). An unlisted target would scan unauthenticated, and the plan's
# own sanity check would catch it a minute later; catching it here costs nothing
# and says why.
TARGET_HOST="$(printf '%s' "$TARGET" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##; s#:[0-9]+$##')"
# The plan writes the host regex-escaped, and YAML doubles the backslashes, so
# the file holds `api-staging\\.pull\\.fm`. Comparing against the plain hostname
# means stripping backslashes from the plan first; matching on the escaped form
# instead would make this check depend on how many layers of quoting the plan
# happens to use, which is how a guard ends up silently never matching.
tr -d '\\' <"$PLAN_SRC" | grep -qF "$TARGET_HOST" || die "\
$TARGET_HOST is not in the replacer host allowlist in
        $PLAN_SRC. Add it there deliberately. Scanning a host the plan will not
        authenticate against tests the 401 handler and nothing else."

set +e
docker run --rm \
  -v "$RUN:/zap/wrk:rw" \
  -e "PULLFM_ZAP_TARGET=$TARGET" \
  -e "PULLFM_ZAP_OPENAPI=/zap/wrk/dast-safe.json" \
  -e "PULLFM_ZAP_TOKEN=$PULLFM_ZAP_TOKEN" \
  "$ZAP_IMAGE" \
  zap.sh -cmd -autorun /zap/wrk/plan.yaml
ZAP_EXIT=$?
set -e

cp -f "$RUN/reports/"* "$OUT_DIR/" 2>/dev/null || true
note "reports -> $OUT_DIR"

# ---------------------------------------------------------------------------
# Post-flight. Did we hurt anyone upstream?
# ---------------------------------------------------------------------------
step "Upstream post-flight"
curl -sS --max-time 20 "$TARGET/v1/config" -o "$OUT_DIR/providers-after.json" || true
node "$REPO_ROOT/security/scripts/compare-upstream.mjs" \
  "$OUT_DIR/providers-before.json" "$OUT_DIR/providers-after.json" \
  ${METRICS_AVAILABLE:+--metrics-before "$OUT_DIR/metrics-before.txt"} \
  || UPSTREAM_REGRESSED=1

if [ "$METRICS_AVAILABLE" = "1" ]; then
  read_metrics "$OUT_DIR/metrics-after.txt" ||
    die "could not re-read /metrics after the scan."
  node "$REPO_ROOT/security/scripts/compare-upstream.mjs" \
    "$OUT_DIR/providers-before.json" "$OUT_DIR/providers-after.json" \
    --metrics-before "$OUT_DIR/metrics-before.txt" \
    --metrics-after "$OUT_DIR/metrics-after.txt" || UPSTREAM_REGRESSED=1
fi

step "Summary"
node "$REPO_ROOT/security/scripts/summarise-zap.mjs" \
  "$OUT_DIR/zap-$PLAN_NAME.sarif" || true

if [ "${UPSTREAM_REGRESSED:-0}" = "1" ]; then
  die "the scan moved upstream provider counters. Investigate before running
        again: security/zap/upstream-scope.tsv is supposed to make that
        impossible, so a rise means the register is wrong."
fi

exit "$ZAP_EXIT"
