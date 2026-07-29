# shellcheck shell=bash
#
# Pull.fm - staging secret material, rendered from 1Password at apply time.
#
# SOURCE this file. It defines functions and exports nothing by itself.
#
#   source "${ROOT}/infra/lib/secrets.sh"
#   dir="$(pullfm_secret_workdir)"       # 0700; the CALLER owns the cleanup trap
#   trap 'rm -rf "${dir}"' EXIT INT TERM
#   pullfm_render_staging_secrets "${dir}"
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
readonly PULLFM_DB_PRIVATE_IP="${PULLFM_DB_PRIVATE_IP:-10.20.1.21}"
readonly PULLFM_WORKOS_CLIENT_ID="${PULLFM_WORKOS_CLIENT_ID:-client_01KYMZ05X60BJKZKY5RTA5YP8B}"
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
#   db.env              Postgres and Redis passwords (database node)
#   origin.pem          Cloudflare Origin CA certificate
#   origin.key          its private key
#   origin-pull-ca.pem  Cloudflare's origin-pull CA, a PUBLIC certificate
#
# Every file is 0600 before anything is written into it, so there is no window
# in which a partially written credential is world readable.
pullfm_render_staging_secrets() {
  local dir="${1:?usage: pullfm_render_staging_secrets <dir>}"

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

  local postgres_pw redis_cache_pw redis_quota_pw kek kek_id
  local workos_key workos_webhook seatgeek_id seatgeek_secret
  postgres_pw="$(_pullfm_field 'pull-fm/staging/POSTGRES_PASSWORD' 'password')" || return 1
  redis_cache_pw="$(_pullfm_field 'pull-fm/staging/REDIS_CACHE_PASSWORD' 'password')" || return 1
  redis_quota_pw="$(_pullfm_field 'pull-fm/staging/REDIS_QUOTA_PASSWORD' 'password')" || return 1
  kek="$(_pullfm_field 'pull-fm/staging/CREDENTIAL_KEK' 'password')" || return 1
  kek_id="$(_pullfm_field 'pull-fm/staging/CREDENTIAL_KEK' 'kek_id')" || return 1
  workos_key="$(_pullfm_field 'Pull.fm WorkOS Staging API Key' 'password')" || return 1
  workos_webhook="$(_pullfm_field 'pull-fm/staging/WORKOS_WEBHOOK_SECRET' 'credential')" || return 1

  # The SeatGeek client id lives in the item's NOTES ("client id = <35 chars>")
  # and the secret is the password. Optional: without the id the events route
  # answers 501, which is the correct behaviour for a deployment that has no
  # events provider rather than an error.
  seatgeek_id="$(op item get 'Pull FM Seat Geek API Key' \
    --vault "${PULLFM_SECRETS_VAULT}" --fields label=notesPlain --reveal 2>/dev/null |
    grep -oE '[A-Za-z0-9_-]{30,}' | head -n1 || true)"
  seatgeek_secret="$(op item get 'Pull FM Seat Geek API Key' \
    --vault "${PULLFM_SECRETS_VAULT}" --fields label=password --reveal 2>/dev/null || true)"

  # --- database node ---------------------------------------------------------
  install -m 0600 /dev/null "${dir}/db.env"
  cat >"${dir}/db.env" <<EOF
# Rendered by infra/lib/secrets.sh from 1Password. NEVER COMMIT THIS FILE.
POSTGRES_PASSWORD=${postgres_pw}
REDIS_CACHE_PASSWORD=${redis_cache_pw}
REDIS_QUOTA_PASSWORD=${redis_quota_pw}
PRIVATE_IP=${PULLFM_DB_PRIVATE_IP}
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

DATABASE_URL=postgres://pullfm:${postgres_pw}@${PULLFM_DB_PRIVATE_IP}:5432/pullfm
REDIS_URL=redis://:${redis_cache_pw}@${PULLFM_DB_PRIVATE_IP}:6379
REDIS_QUOTA_URL=redis://:${redis_quota_pw}@${PULLFM_DB_PRIVATE_IP}:6380

CREDENTIAL_KEKS=${kek_id}=${kek}
CREDENTIAL_ACTIVE_KEK_ID=${kek_id}

WORKOS_CLIENT_ID=${PULLFM_WORKOS_CLIENT_ID}
WORKOS_API_KEY=${workos_key}
WORKOS_WEBHOOK_SECRET=${workos_webhook}

PUBLIC_BASE_URL=${PULLFM_PUBLIC_BASE_URL}
MUSICBRAINZ_USER_AGENT=${PULLFM_MB_USER_AGENT}
CORS_ORIGINS=https://app-staging.pull.fm
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
