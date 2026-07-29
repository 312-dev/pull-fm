# shellcheck shell=bash
#
# Pull.fm - staging secret material, rendered from 1Password at apply time.
#
# SOURCE this file. It defines functions and exports nothing by itself.
#
#   source "${ROOT}/infra/lib/secrets.sh"
#   dir="$(pullfm_secret_workdir)"       # 0700; the CALLER owns the cleanup trap
#   trap 'rm -rf "${dir}"' EXIT INT TERM
#   pullfm_render_staging_secrets "${dir}" "${redis_host}"
#
# ---------------------------------------------------------------------------
# The rules this file exists to keep
# ---------------------------------------------------------------------------
#
#   1. NOTHING RENDERED HERE MAY EVER BE COMMITTED. The repository is public
#      and gitleaks blocks CI. Every file this writes goes into a 0700
#      directory under the system temporary directory, which the caller removes
#      with an EXIT trap even when it fails partway.
#
#   2. NOTHING RENDERED HERE MAY REACH TERRAFORM STATE. `user_data` is
#      persisted in state and readable from the Hetzner API for the life of the
#      server, so none of this is passed to Terraform. It travels over SSH,
#      after the node exists.
#
#   3. NOTHING RENDERED HERE MAY BE BAKED INTO AN IMAGE. The container is
#      configured entirely through an env file placed on the node at 0600 by
#      root, exactly as `infra/staging/app/docker-compose.yml` expects.
#
# The values are read with `op item get --fields`, not `op read`, because every
# item title contains slashes (pull-fm/staging/...) and `op://vault/item/field`
# cannot address an item whose title contains one.
# ---------------------------------------------------------------------------

readonly PULLFM_SECRETS_VAULT="${PULLFM_OP_VAULT:-MCP}"

# Public, non-secret facts. Here rather than in the env file template so that a
# reader can see at a glance that they are NOT credentials.
#
# THE REDIS ADDRESS IS A PARAMETER, NOT A CONSTANT, and this is the correction
# that made the co-located shape work at all. Pre-launch there is one node with
# Redis bound to its loopback, and `cache/bootstrap.sh` already took PRIVATE_IP
# for exactly that reason - but this file hardcoded the cache node's address, so
# every rendered bff.env pointed REDIS_URL at 10.20.1.21, a host that is not
# created. The BFF then started, answered /healthz, and failed /readyz on a
# Redis it could never reach. Both halves now come from the same terraform
# output (`redis_host`), passed in by the caller.
readonly PULLFM_CACHE_PRIVATE_IP_DEFAULT="${PULLFM_CACHE_PRIVATE_IP:-10.20.1.21}"
# THE CLIENT ID AND THE API KEY ARE ONE PAIR AND THEY WERE MISMATCHED.
#
# The 1Password vault holds two WorkOS staging keys whose titles differ by a
# prefix - `Pull.fm WorkOS Staging API Key` and `WorkOS Staging API Key` - and
# they belong to two different WorkOS APPLICATIONS inside the same environment.
# This file paired the client id of one with the API key of the other. That
# combination authenticates successfully, which is what made it survive review
# and every test: `POST /v1/auth/verify` returned 200 and a real access token.
#
# The token was then rejected by our own auth plugin on every subsequent
# request, with the deliberately uniform 401 that says nothing about why.
#
# The reason is that WorkOS issues `iss` PER ENVIRONMENT and serves JWKS PER
# APPLICATION. Its own discovery document is unambiguous, and it is the check
# worth re-running if this ever moves:
#
#   GET https://api.workos.com/user_management/<any client in the env>/.well-known/openid-configuration
#     issuer   -> https://api.workos.com/user_management/client_01KYMWRZ8BA37K6H268J4ZSVQD
#     jwks_uri -> https://api.workos.com/sso/jwks/<that same client>
#
# So the issuer names ONE client whatever you ask with, and apps/bff derives its
# expected issuer from WORKOS_CLIENT_ID. Only the application that WorkOS names
# in `iss` can therefore be configured here, and its key is the item read below.
# Both halves are addressed BY ITEM ID rather than by title, because the titles
# differ by one word and picking the wrong one costs a working sign-in.
readonly PULLFM_WORKOS_CLIENT_ID="${PULLFM_WORKOS_CLIENT_ID:-client_01KYMWRZ8BA37K6H268J4ZSVQD}"

# `WorkOS Staging API Key`, the key belonging to the client id above.
readonly PULLFM_WORKOS_OP_ITEM="${PULLFM_WORKOS_OP_ITEM:-qr6sfpfzskhpqtzbehw7kdheti}"
readonly PULLFM_PUBLIC_BASE_URL="${PULLFM_PUBLIC_BASE_URL:-https://api-staging.pull.fm}"
readonly PULLFM_MB_USER_AGENT="${PULLFM_MB_USER_AGENT:-PullFM/0.1.0 (ope@312.dev)}"

_pullfm_secret_die() { printf '\033[31m%s\033[0m\n' "$*" >&2; return 1; }

_pullfm_field() {
  local item="$1" field="$2" value
  value="$(op item get "${item}" --vault "${PULLFM_SECRETS_VAULT}" \
    --fields "label=${field}" --reveal 2>/dev/null)" ||
    _pullfm_secret_die "1Password: cannot read '${field}' from '${item}'" || return 1
  [[ -n "${value}" ]] ||
    _pullfm_secret_die "1Password: '${field}' on '${item}' is empty" || return 1
  printf '%s' "${value}"
}

_pullfm_document() {
  local item="$1" out="$2"
  op document get "${item}" --vault "${PULLFM_SECRETS_VAULT}" --out-file "${out}" \
    --force >/dev/null 2>&1 ||
    _pullfm_secret_die "1Password: cannot read document '${item}'" || return 1
  [[ -s "${out}" ]] ||
    _pullfm_secret_die "1Password: document '${item}' is empty" || return 1
}

# A 0700 scratch directory for rendered plaintext.
#
# It does NOT install its own cleanup trap, and that is a correction rather than
# an omission. A trap set here runs when the COMMAND SUBSTITUTION that captured
# the path exits, which is immediately, so the directory was deleted before a
# single byte could be written into it. The caller owns the trap because the
# caller is the shell that has to still be alive when the files are used:
#
#   secrets="$(pullfm_secret_workdir)"
#   trap 'rm -rf "${secrets}"' EXIT INT TERM
#
# `pullfm_render_staging_secrets` refuses to run against a directory that is not
# 0700, so a caller who invents their own path cannot accidentally render
# credentials somewhere world readable.
pullfm_secret_workdir() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/pullfm-secrets.XXXXXXXX")" || return 1
  chmod 0700 "${dir}"
  printf '%s' "${dir}"
}

# Renders every file a staging node needs into "${1}".
#
#   bff.env             application configuration and secrets (app node)
#   cache.env           Redis passwords (cache node)
#   origin.pem          Cloudflare Origin CA certificate
#   origin.key          its private key
#   origin-pull-ca.pem  Cloudflare's origin-pull CA, a PUBLIC certificate
#
# The second argument is the Redis host, and it comes from the `redis_host`
# terraform output rather than from a default here. Both shapes are legal and
# they differ only in that address, so hardcoding it meant one of the two was
# always wrong: the co-located shape rendered REDIS_URL pointing at a cache node
# that is not created.
#
# Every file is 0600 before anything is written into it, so there is no window
# in which a partially written credential is world readable.
pullfm_render_staging_secrets() {
  local dir="${1:?usage: pullfm_render_staging_secrets <dir> [redis_host]}"
  local redis_host="${2:-${PULLFM_CACHE_PRIVATE_IP_DEFAULT}}"

  command -v op >/dev/null ||
    _pullfm_secret_die "1Password CLI (op) not found" || return 1

  # Fail loudly rather than writing plaintext into a directory that does not
  # exist or that other users can read. The first version of this file lost the
  # directory to a trap and every write failed one line at a time; a single
  # check up front turns that into one legible error.
  [[ -d "${dir}" ]] ||
    _pullfm_secret_die "secret directory '${dir}' does not exist" || return 1
  local mode
  mode="$(stat -f '%Lp' "${dir}" 2>/dev/null || stat -c '%a' "${dir}" 2>/dev/null)"
  [[ "${mode}" == "700" ]] ||
    _pullfm_secret_die "secret directory '${dir}' is mode ${mode}, refusing to render credentials into it" ||
    return 1

  local database_url database_url_direct redis_cache_pw redis_quota_pw kek kek_id
  local workos_key workos_webhook seatgeek_id seatgeek_secret metrics_token

  # THE DATABASE CREDENTIAL IS NO LONGER A PASSWORD WE COMPOSE A URL FROM.
  # Neon issues the whole connection string, and there are two of them because
  # the pooled and direct endpoints are different hosts. Both are copied out of
  # `terraform -chdir=infra/neon output` into 1Password by the cutover runbook
  # (docs/runbooks/neon-migration.md); this function never talks to the Neon API.
  #
  # POOLED is what the application uses. DIRECT is what the migration runner
  # uses, because it takes a session-level advisory lock and a transaction
  # pooler silently breaks session-scoped locks rather than failing loudly.
  database_url="$(_pullfm_field 'pull-fm/staging/DATABASE_URL' 'credential')" || return 1
  database_url_direct="$(_pullfm_field 'pull-fm/staging/DATABASE_URL_DIRECT' 'credential')" || return 1
  redis_cache_pw="$(_pullfm_field 'pull-fm/staging/REDIS_CACHE_PASSWORD' 'password')" || return 1
  redis_quota_pw="$(_pullfm_field 'pull-fm/staging/REDIS_QUOTA_PASSWORD' 'password')" || return 1
  kek="$(_pullfm_field 'pull-fm/staging/CREDENTIAL_KEK' 'password')" || return 1
  kek_id="$(_pullfm_field 'pull-fm/staging/CREDENTIAL_KEK' 'kek_id')" || return 1
  workos_key="$(_pullfm_field "${PULLFM_WORKOS_OP_ITEM}" 'password')" || return 1
  workos_webhook="$(_pullfm_field 'pull-fm/staging/WORKOS_WEBHOOK_SECRET' 'credential')" || return 1

  # THE WATCHDOG CANNOT SCRAPE /metrics WITHOUT THIS, and the reason is the
  # container boundary rather than anything about the token.
  #
  # The route admits two callers: a TCP peer that is loopback, or a bearer token
  # equal to METRICS_TOKEN. The loopback path is the one the watchdog was
  # designed around - "it runs ON the node, so it scrapes with no credential" -
  # and it cannot work in this deployment. The BFF runs under Compose on a
  # bridge network with `ports: 127.0.0.1:3000:3000`, so a request from the node
  # to its own loopback is DNATed into the container and arrives with the bridge
  # gateway as its peer address, never 127.0.0.1. Nothing running on the host
  # can present as loopback to a bridged container, so on this shape the token
  # is not the fallback, it is the only way in.
  #
  # Measured before it was set: `curl http://127.0.0.1:3000/metrics` on the node
  # returned 404, which is the route's deliberate "no" and is indistinguishable
  # from the route not existing. A watchdog reading that 404 reports the metrics
  # endpoint as unreachable and every condition it derives goes unevaluated.
  metrics_token="$(_pullfm_field 'pull-fm/staging/METRICS_TOKEN' 'password')" || return 1

  # The SeatGeek client id lives in the item's NOTES ("client id = <35 chars>")
  # and the secret is the password. Optional: without the id the events route
  # answers 501, which is the correct behaviour for a deployment that has no
  # events provider rather than an error.
  seatgeek_id="$(op item get 'Pull FM Seat Geek API Key' \
    --vault "${PULLFM_SECRETS_VAULT}" --fields label=notesPlain --reveal 2>/dev/null |
    grep -oE '[A-Za-z0-9_-]{30,}' | head -n1 || true)"
  seatgeek_secret="$(op item get 'Pull FM Seat Geek API Key' \
    --vault "${PULLFM_SECRETS_VAULT}" --fields label=password --reveal 2>/dev/null || true)"

  # --- cache node ------------------------------------------------------------
  install -m 0600 /dev/null "${dir}/cache.env"
  cat >"${dir}/cache.env" <<EOF
# Rendered by infra/lib/secrets.sh from 1Password. NEVER COMMIT THIS FILE.
REDIS_CACHE_PASSWORD=${redis_cache_pw}
REDIS_QUOTA_PASSWORD=${redis_quota_pw}
PRIVATE_IP=${redis_host}
EOF

  # --- application node ------------------------------------------------------
  # The two Redis URLs point at two INSTANCES, not two databases on one. Policy
  # in Redis is per instance, so counters sharing an allkeys-lru instance with
  # the cache are evicted by any cache fill and every rate limit then fails
  # open, with no error and no alert (THREAT-MODEL T11).
  install -m 0600 /dev/null "${dir}/bff.env"
  cat >"${dir}/bff.env" <<EOF
# Rendered by infra/lib/secrets.sh from 1Password. NEVER COMMIT THIS FILE.
NODE_ENV=production
DEPLOY_ENV=staging
LOG_LEVEL=info
HOST=0.0.0.0
PORT=3000

DATABASE_URL=${database_url}
DATABASE_URL_DIRECT=${database_url_direct}
REDIS_URL=redis://:${redis_cache_pw}@${redis_host}:6379
REDIS_QUOTA_URL=redis://:${redis_quota_pw}@${redis_host}:6380

CREDENTIAL_KEKS=${kek_id}=${kek}
CREDENTIAL_ACTIVE_KEK_ID=${kek_id}

WORKOS_CLIENT_ID=${PULLFM_WORKOS_CLIENT_ID}
WORKOS_API_KEY=${workos_key}
WORKOS_WEBHOOK_SECRET=${workos_webhook}

PUBLIC_BASE_URL=${PULLFM_PUBLIC_BASE_URL}
MUSICBRAINZ_USER_AGENT=${PULLFM_MB_USER_AGENT}
CORS_ORIGINS=https://app-staging.pull.fm

METRICS_TOKEN=${metrics_token}

# The file lever, and the path is the CONTAINER'S. The node's copy is
# /etc/pullfm/flags/maintenance, bind-mounted read-only at the same path by
# infra/staging/app/docker-compose.yml. It is a dedicated directory rather than
# /etc/pullfm because that directory holds every secret on the node and the
# container has no business reading it to find a zero-byte marker.
#
#   sudo touch /etc/pullfm/flags/maintenance     # 503 within MAINTENANCE_POLL_MS
#   sudo rm    /etc/pullfm/flags/maintenance     # back to 200
MAINTENANCE_FLAG_FILE=/etc/pullfm/flags/maintenance
EOF

  # --- watchdog scrape configuration -----------------------------------------
  # Read by /etc/systemd/system/pullfm-watchdog.service.d/10-pullfm-metrics.conf,
  # which bootstrap.sh installs. A drop-in rather than an edit to the unit,
  # because the unit belongs to infra/observability and this is deployment shape
  # rather than a change to what the watchdog does.
  #
  # BOTH OVERRIDES ARE CORRECTIONS, not preferences. The watchdog defaults to
  # port 8080, which on this node is nginx's health-check listener: it serves
  # exactly `location = /healthz` and returns 404 for everything else, so both
  # /metrics and /readyz were being read as "not answering". The BFF's own
  # published port answers all three.
  install -m 0600 /dev/null "${dir}/metrics.env"
  cat >"${dir}/metrics.env" <<EOF
# Rendered by infra/lib/secrets.sh from 1Password. NEVER COMMIT THIS FILE.
PULLFM_METRICS_URL=http://127.0.0.1:3000/metrics
PULLFM_READYZ_URL=http://127.0.0.1:3000/readyz
PULLFM_HEALTHZ_URL=http://127.0.0.1:3000/healthz
PULLFM_METRICS_TOKEN=${metrics_token}
EOF

  if [[ -n "${seatgeek_id}" ]]; then
    {
      printf 'SEATGEEK_CLIENT_ID=%s\n' "${seatgeek_id}"
      [[ -n "${seatgeek_secret}" ]] &&
        printf 'SEATGEEK_CLIENT_SECRET=%s\n' "${seatgeek_secret}"
      printf 'SEATGEEK_ENABLED=true\n'
    } >>"${dir}/bff.env"
  fi

  # --- TLS -------------------------------------------------------------------
  _pullfm_document 'pull-fm/staging/ORIGIN_CA_CERTIFICATE' "${dir}/origin.pem" || return 1
  _pullfm_document 'pull-fm/staging/ORIGIN_CA_PRIVATE_KEY' "${dir}/origin.key" || return 1
  chmod 0600 "${dir}/origin.pem" "${dir}/origin.key"

  # Cloudflare's origin-pull CA is a PUBLIC certificate, published by
  # Cloudflare, and is fetched rather than stored: keeping a copy in 1Password
  # would create a rotation obligation for something that is not a secret.
  # nginx refuses the handshake without it, so a failure here is fatal.
  curl -fsS -o "${dir}/origin-pull-ca.pem" \
    https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem ||
    _pullfm_secret_die "could not fetch Cloudflare's origin-pull CA" || return 1
  chmod 0644 "${dir}/origin-pull-ca.pem"
}
