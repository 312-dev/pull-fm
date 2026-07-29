#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Proves that infra/staging/app/nginx-pullfm.conf.in renders to a config nginx
# ACCEPTS, on both ingress paths.
#
#   ./infra/scripts/check-origin-config.sh
#
# Why this is worth a script. The origin config has exactly one dangerous
# failure mode and it is invisible to review: a listener whose PROXY-protocol
# setting disagrees with the load balancer answers 400 to every connection, and
# the symptom looks like an application bug. The template exists so that setting
# is derived from one variable, and this check exists so "it renders to valid
# nginx" is a fact rather than a belief. Nothing is deployed, so the only proof
# available without infrastructure is the one nginx itself gives: `nginx -t`.
#
# What it does NOT prove: that the rendered mode matches what Terraform actually
# provisioned. Nothing offline can prove that. It is enforced by both halves
# coming from one variable (enable_load_balancer -> PULLFM_INGRESS) and stated
# in docs/RUNBOOK-DEPLOY.md.
#
# Requires: docker. The nginx image is the same major version Ubuntu 24.04
# ships (1.24), which matters: `http2 on;` is 1.25 syntax and the listen
# parameter form used in the template is what works on both.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TEMPLATE="${ROOT}/infra/staging/app/nginx-pullfm.conf.in"

command -v docker >/dev/null || {
  echo "docker is required" >&2
  exit 1
}

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

# Stub material. nginx -t opens the certificate and key, so they have to exist
# and be parseable; nothing here is ever used to serve anything.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=origin-config-check" \
  -keyout "${WORK}/origin.key" -out "${WORK}/origin.pem" >/dev/null 2>&1
cp "${WORK}/origin.pem" "${WORK}/origin-pull-ca.pem"

# Stands in for what pullfm-cf-ranges generates. The variable name and the
# source variable must match the real generator or the site config will not
# start; keeping the stub honest is the point of asserting on it below.
grep -q 'geo \\\$remote_addr \\\$cloudflare_edge' "${ROOT}/infra/staging/app/pullfm-cf-ranges" || {
  echo "pullfm-cf-ranges no longer keys the allowlist on \$remote_addr." >&2
  echo "The template and the generator have drifted; fix one of them." >&2
  exit 1
}
cat >"${WORK}/cloudflare-allowlist.conf" <<'EOF'
geo $remote_addr $cloudflare_edge {
    default 0;
    103.21.244.0/22 1;
}
EOF

check_mode() {
  local mode=$1 token=$2 realip=$3

  sed -E "/^[[:space:]]*listen /s/@PROXY@/${token}/" "${TEMPLATE}" >"${WORK}/pullfm.conf"

  if grep -qE '^[[:space:]]*listen .*@PROXY@' "${WORK}/pullfm.conf"; then
    echo "FAIL (${mode}): a listen directive still carries the placeholder" >&2
    return 1
  fi

  printf '%s\n' "${realip}" >"${WORK}/00-pullfm-ingress.conf"

  if ! docker run --rm \
    -v "${WORK}/pullfm.conf:/etc/nginx/conf.d/pullfm.conf:ro" \
    -v "${WORK}/cloudflare-allowlist.conf:/etc/nginx/conf.d/zz-allowlist.conf:ro" \
    -v "${WORK}/00-pullfm-ingress.conf:/etc/nginx/conf.d/00-ingress.conf:ro" \
    -v "${WORK}/origin.pem:/etc/ssl/pullfm/origin.pem:ro" \
    -v "${WORK}/origin.key:/etc/ssl/pullfm/origin.key:ro" \
    -v "${WORK}/origin-pull-ca.pem:/etc/ssl/pullfm/origin-pull-ca.pem:ro" \
    --entrypoint nginx nginx:1.24-alpine -t 2>"${WORK}/err"; then
    echo "FAIL (${mode}): nginx rejected the rendered config" >&2
    cat "${WORK}/err" >&2
    return 1
  fi

  echo "  ${mode}: nginx -t accepted the rendered config"
}

# --entrypoint nginx skips the image's docker-entrypoint.d scripts, which mutate
# conf.d and print six lines of noise before doing anything useful. `nginx -t`
# still loads the image's own nginx.conf, which is what makes this a check
# against real nginx rather than against a hand-built minimal config.
echo "checking both ingress paths..."
check_mode "direct       " "" "# no realip on the direct path"
check_mode "load-balancer" "proxy_protocol" "$(
  printf 'set_real_ip_from 10.20.1.0/24;\nreal_ip_header proxy_protocol;\n'
)"

echo
echo "PASS"
