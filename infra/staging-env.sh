#!/usr/bin/env bash
#
# Ephemeral staging: bring the environment up for a gate run, tear it down after.
#
# Staging exists to run gates, not to serve traffic. Hetzner bills by the hour,
# so the current one-node shape costs USD 23.59 a month to sit idle while a
# three hour gate session costs about USD 0.10. (Dollars, not euros: this
# account's /v1/pricing reports currency USD and vat_rate 0, and every "EUR"
# figure written in this repository before 2026-07-29 was a dollar figure
# wearing the wrong symbol. `cost` reads the currency now rather than assuming
# it.) Rebuilding from IaC is already
# a Gate 4 requirement, so tearing down exercises the thing we have to prove
# anyway rather than avoiding it.
#
#   ./infra/staging-env.sh up        provision, converge, and verify. One step.
#   ./infra/staging-env.sh converge  re-apply configuration to running nodes
#   ./infra/staging-env.sh verify    poll the PUBLIC url until it serves 200
#   ./infra/staging-env.sh down      destroy compute, KEEP the backup bucket
#   ./infra/staging-env.sh status    what is running and what it costs
#   ./infra/staging-env.sh cost      current monthly run rate
#
# `up` PRODUCES A SERVING NODE, AND IT DID NOT USED TO.
#
# A rebuild drill on 2026-07-29 measured what `up` actually produced: a booted
# node in 45 seconds, HTTP 525 for five minutes, and no way in - no inbound rule
# for port 22 and no Tailscale, because `tailscale_auth_key` was empty in every
# committed configuration. nginx, the origin certificate, the container and the
# deploy timer had all been applied by hand over SSH during Gate 0 and existed
# nowhere else. That is a Gate 4 blocker: the infrastructure half rebuilt in
# under a minute and the half that makes it serve traffic was an untimed manual
# runbook.
#
# `up` now runs terraform, waits for the nodes to reach the tailnet, ships the
# secrets from 1Password over SSH, runs the committed bootstrap scripts, and
# polls the public URL until it answers 200. No human step, and no secret in
# the repository, in Terraform state, or in a container image:
#
#   cloud-init  (in state, therefore PUBLIC facts only) packages, docker,
#               nginx, the tailnet, the directory layout
#   converge    (over SSH, therefore secrets) bff.env, cache.env, backup.env,
#               metrics.env, mb-canonical.env, alert.env, the origin certificate
#               and key, the observability/backup/mb-loader/lib trees, then
#               `bash bootstrap.sh`
#
# The one secret cloud-init carries is a Tailscale auth key, and it is minted
# fresh per apply, single use, and ephemeral - spent the moment the node joins,
# so the copy left in state authorises nothing.
#
# CREDENTIALS: per-environment scoped tokens only, loaded from 1Password by
# infra/lib/credentials.sh. The Cloudflare global API key is bootstrap-only and
# this script refuses to start when CLOUDFLARE_API_KEY or CLOUDFLARE_EMAIL are
# present in the environment. Both tokens are then checked against what they can
# actually see: Hetzner must not enumerate the personal fleet, and Cloudflare
# must not enumerate a zone other than pull.fm.
#
# WHAT SURVIVES A TEARDOWN, and why:
#   - The R2 backup bucket. It holds the only copy of anything worth keeping,
#     and it is free at this size. Destroying it would make the Gate 4 restore
#     drill meaningless.
#   - Terraform state.
#
# WHAT DOES NOT SURVIVE: servers, the load balancer, the private network, the
# DNS records, and the contents of the staging Redis instances. That is the
# point. If a teardown loses something you needed, it belonged in R2.
#
# STAGING POSTGRES DATA IS NO LONGER ON THIS LIST, and that is the whole shape
# of the Neon migration. The staging database is a Neon BRANCH (infra/neon), it
# is not built by this script, and `down` does not touch it. A branch that costs
# nothing while its compute is suspended has no reason to be destroyed on a
# schedule; when staging data does need discarding, the operation is a branch
# reset from `main`, which is instant. See docs/runbooks/neon-migration.md.
#
# DNS USED TO BE ON THE SURVIVES LIST AND THAT WAS WRONG. Measured 2026-07-29:
# `terraform destroy -target=...` destroys the targets AND everything that
# depends on them, and each DNS record's content is the load balancer address.
# The record cannot outlive the address it publishes, so a keep-list entry for
# module.dns did nothing except make the header untrue. `up` recreates all four
# records from IaC, which costs one Cloudflare propagation and nothing else.
#
# THE SECOND LOCK HAS TO BE UNLOCKED FIRST. Hetzner's delete_protection is
# enforced by the API, so it survives `terraform destroy` and fails it halfway:
# the app node, firewalls and DNS go, while the cache node and load balancer
# stay up and keep billing. The staging root now defaults both flags to false
# (docs/PLAN.md section 10c always said staging should), but a live resource
# created before that change still carries the flag in Hetzner, and the
# Terraform graph that would clear it is already half destroyed by then. So
# clear_delete_protection() clears it over the API, and only for a project that
# has already passed the personal-fleet refusal above.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_DIR="${ROOT}/infra/terraform/envs/staging"

# Per-environment scoped credentials. The Cloudflare global API key is a
# bootstrap credential for minting tokens and is refused here; see the header
# of infra/lib/credentials.sh.
# shellcheck source=lib/credentials.sh
source "${ROOT}/infra/lib/credentials.sh"
# Staging secret material, rendered from 1Password into a self-deleting 0700
# directory. Nothing it produces is ever committed or passed to Terraform.
# shellcheck source=lib/secrets.sh
source "${ROOT}/infra/lib/secrets.sh"

# Resources deliberately excluded from teardown. See the header.
#
# module.dns is NOT here, despite being free to keep, because a keep-list cannot
# protect a resource that depends on a target: the records publish the load
# balancer address and go with it. Listing it would document a guarantee the
# mechanism cannot make.
readonly KEEP=(
  "module.backup_storage"
)

log()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

load_credentials() {
  pullfm_load_credentials staging || die "could not load staging credentials"
}

# Both tokens are checked against what they can actually see rather than
# against how they were named: Hetzner must not enumerate the personal fleet,
# and Cloudflare must not enumerate a second zone.
assert_correct_project() {
  pullfm_assert_hetzner_project || exit 1
  pullfm_assert_cloudflare_scope || exit 1
}

readonly API_HOSTNAME="${PULLFM_API_HOSTNAME:-api-staging.pull.fm}"
readonly APP_NODE="pullfm-staging-app-1"
readonly CACHE_NODE="pullfm-staging-cache-1"
readonly SSH_USER="${PULLFM_SSH_USER:-pullfm}"
readonly SSH_KEY="${PULLFM_SSH_KEY:-${HOME}/.ssh/id_ed25519}"

# StrictHostKeyChecking=accept-new rather than `no`: a freshly built node has no
# known host key and refusing to learn one would make an unattended rebuild
# impossible, but silently accepting a CHANGED key would hide a real
# man-in-the-middle. accept-new learns once and refuses a change afterwards.
ssh_node() {
  local host="$1"; shift
  ssh -i "${SSH_KEY}" \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="${HOME}/.ssh/known_hosts" \
    -o ConnectTimeout=10 \
    -o BatchMode=yes \
    "${SSH_USER}@${host}" "$@"
}

# Tailnet address for a node, by the hostname cloud-init set.
#
# Resolved from `tailscale status` rather than trusting MagicDNS, because
# MagicDNS resolution depends on the operator's own DNS configuration and a
# rebuild must not fail on how somebody's laptop is set up.
#
# ONLINE PEERS WIN, AND THAT IS NOT A TIE-BREAK - IT IS THE WHOLE FUNCTION.
# Tailscale dedups the DNS name of a second device claiming a taken hostname
# (`pullfm-staging-app-1-1`) but leaves `HostName` identical on both. A rebuild
# therefore sees the previous, dead node and the new one under the same name
# until the ephemeral reaper catches up, which took well over fifteen minutes in
# a measured drill. Matching on HostName alone picked whichever the JSON
# happened to list first, so the rebuild spent ten minutes SSHing to a machine
# that no longer existed and then failed. Preferring an online peer makes it
# deterministic; accepting the `-N` suffix makes it find the new node at all.
tailnet_ip() {
  local name="$1"
  tailscale status --json 2>/dev/null | python3 -c "
import json, re, sys

want = sys.argv[1]
# The dedup suffix Tailscale appends when a hostname is already claimed.
pattern = re.compile(r'^' + re.escape(want) + r'(-\d+)?$')
peers = (json.load(sys.stdin).get('Peer') or {}).values()

matches = [
    p for p in peers
    if p.get('HostName') == want
    or pattern.match((p.get('DNSName') or '').split('.')[0])
]
# Online first. A dead peer with the right name is the trap this exists to
# avoid, and there is no useful thing to do with its address.
matches.sort(key=lambda p: not p.get('Online', False))
for peer in matches:
    ips = peer.get('TailscaleIPs') or []
    if ips and peer.get('Online', False):
        print(ips[0])
        break
" "${name}"
}

# Removes staging devices left behind by a previous environment.
#
# Ephemeral keys are supposed to make this unnecessary and eventually do, but
# the reaper is not prompt enough to rely on inside a rebuild: a measured drill
# still saw the previous pair fifteen minutes after they were destroyed. Purging
# up front turns a race into a precondition. Only ever touches devices whose
# hostname starts with the staging prefix, so a stray match cannot reach the
# personal fleet.
purge_stale_tailnet_devices() {
  local token
  token="$(op item get 'Tailscale API' --vault "${PULLFM_SECRETS_VAULT}" \
    --fields label=password --reveal 2>/dev/null)" || return 0

  curl -sS -H "Authorization: Bearer ${token}" \
    'https://api.tailscale.com/api/v2/tailnet/-/devices' |
    python3 -c "
import json, sys
prefix = sys.argv[1]
for d in json.load(sys.stdin).get('devices', []):
    if (d.get('hostname') or '').startswith(prefix):
        print(d['nodeId'])
" "pullfm-staging" |
    while read -r node_id; do
      [[ -z "${node_id}" ]] && continue
      warn "removing stale tailnet device ${node_id}"
      curl -sS -o /dev/null -X DELETE \
        -H "Authorization: Bearer ${token}" \
        "https://api.tailscale.com/api/v2/device/${node_id}" || true
    done
}

# Mints a single-use, pre-authorised, EPHEMERAL Tailscale auth key.
#
# All three properties matter and none is decoration:
#   single use    the key is spent by the first node that claims it, so the
#                 copy persisted in Terraform state authorises nothing
#                 afterwards. A fresh one is minted per apply.
#   pre-authorised the node must be usable the moment it boots; waiting for a
#                 human to approve a device is exactly the manual step this
#                 whole change exists to remove.
#   ephemeral     staging is destroyed after every gate run. Without this, each
#                 drill leaves two dead nodes in the tailnet forever.
#
# Reusable is on ONLY because two nodes boot from one apply; the one hour expiry
# is what bounds that.
mint_tailscale_key() {
  local token response
  token="$(op item get 'Tailscale API' --vault "${PULLFM_SECRETS_VAULT}" \
    --fields label=password --reveal 2>/dev/null)" ||
    die "could not read the Tailscale API token from 1Password"

  # `Authorization: Bearer` rather than curl's `-u`, for the same reason
  # infra/lib/credentials.sh uses it: the basic-auth form is a credential in a
  # command line, which lands in a process list and in shell history.
  response="$(curl -sS \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    --data '{"capabilities":{"devices":{"create":{"reusable":true,"ephemeral":true,"preauthorized":true,"tags":[]}}},"expirySeconds":3600,"description":"pull-fm staging bootstrap"}' \
    'https://api.tailscale.com/api/v2/tailnet/-/keys')" ||
    die "Tailscale API refused the key request"

  printf '%s' "${response}" | python3 -c "
import json, sys
body = json.load(sys.stdin)
key = body.get('key')
if not key:
    sys.exit('Tailscale did not return a key: ' + json.dumps(body)[:200])
print(key)
"
}

# Waits for cloud-init to finish. It writes a marker rather than us sleeping,
# because apt on a fresh node takes anywhere from 40 seconds to four minutes and
# a fixed sleep is either flaky or slow.
wait_for_node() {
  local name="$1" deadline=$((SECONDS + 600)) ip=""
  # STDERR, not stdout. This function's stdout IS its return value - the caller
  # captures it with a command substitution - so a progress line printed there
  # is concatenated onto the address and the next SSH fails with "hostname
  # contains invalid characters".
  log "  waiting for ${name} to reach the tailnet" >&2
  while ((SECONDS < deadline)); do
    ip="$(tailnet_ip "${name}")"
    if [[ -n "${ip}" ]] && ssh_node "${ip}" \
      "test -f /var/lib/pullfm/cloud-init-done" 2>/dev/null; then
      printf '%s' "${ip}"
      return 0
    fi
    sleep 10
  done
  die "${name} did not finish cloud-init within 10 minutes"
}

# Ships a directory and the secrets it needs, then runs its bootstrap script.
#
# tar over ssh rather than rsync: rsync is not guaranteed present on a minimal
# cloud image, and installing it to copy six files is a dependency bought for
# nothing.
converge_node() {
  local ip="$1" src="$2" secrets_dir="$3" env_name="$4"
  shift 4

  ssh_node "${ip}" "rm -rf /tmp/pullfm-config && mkdir -p /tmp/pullfm-config"
  tar czf - -C "${src}" . | ssh_node "${ip}" "tar xzf - -C /tmp/pullfm-config"

  # Secrets go to a private staging path, are installed root-owned 0600, and
  # the copy in /tmp is removed in the same command. There is no window in
  # which the plaintext sits in a world-readable place.
  ssh_node "${ip}" "install -d -m 0700 /tmp/pullfm-secrets"
  scp -q -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$@" "${SSH_USER}@${ip}:/tmp/pullfm-secrets/"

  ssh_node "${ip}" "sudo install -d -m 0751 /etc/pullfm \
    && sudo install -m 0600 -o root -g root /tmp/pullfm-secrets/${env_name} /etc/pullfm/${env_name} \
    && rm -rf /tmp/pullfm-secrets"
}

# Reads one terraform output, or echoes the fallback when the root has no state
# yet. The fallbacks are the module defaults, so a converge against a
# not-yet-applied root configures the shape the next apply would create rather
# than failing on a missing output.
tf_output() {
  local name="$1" fallback="$2" value
  value="$(terraform -chdir="${ENV_DIR}" output -raw "${name}" 2>/dev/null || true)"
  [[ -n "${value}" ]] && printf '%s' "${value}" || printf '%s' "${fallback}"
}

cmd_converge() {
  local app_ip cache_ip secrets ingress_mode redis_host cache_private_ip colocated

  # THE SHAPE COMES FROM TERRAFORM, NOT FROM THIS SCRIPT. Pre-launch the
  # environment is one application node with Redis co-located on it and no load
  # balancer; the two-node shape with a separate cache node and a load balancer
  # is the documented scale step. Both are supported here, and which one is
  # configured is read from the state rather than assumed, because the two sides
  # of the PROXY-protocol decision disagreeing answers 400 to every connection.
  ingress_mode="$(tf_output ingress_mode direct)"
  cache_private_ip="$(tf_output cache_private_ip 10.20.1.21)"
  redis_host="$(tf_output redis_host 10.20.1.11)"

  # CO-LOCATION IS DECIDED BY WHETHER REDIS LIVES AT THE CACHE NODE'S ADDRESS,
  # not by whether it lives at the loopback. It used to be the latter, and that
  # stopped being a valid test the moment the co-located shape moved off the
  # loopback onto the application node's own private address - which it had to,
  # because the BFF runs on a bridge network and cannot reach a service
  # published on the host's loopback. The cache node's address is reserved
  # whether or not the node exists, so this comparison is stable either way.
  colocated=true
  [[ "${redis_host}" == "${cache_private_ip}" ]] && colocated=false

  app_ip="${1:-$(tailnet_ip "${APP_NODE}")}"
  [[ -n "${app_ip}" ]] ||
    die "the staging application node must be on the tailnet before converging (run 'up')"

  cache_ip="${2:-}"
  if [[ "${colocated}" == false ]]; then
    cache_ip="${cache_ip:-$(tailnet_ip "${CACHE_NODE}")}"
    [[ -n "${cache_ip}" ]] ||
      die "enable_cache_node is set, so ${CACHE_NODE} must be on the tailnet before converging"
  fi

  log "rendering secrets from 1Password"
  secrets="$(pullfm_secret_workdir)" || die "could not create a secret directory"
  # The trap belongs HERE, not inside the helper: set there it would run when
  # the command substitution above exits, which is before anything is written.
  # shellcheck disable=SC2064
  trap "rm -rf '${secrets}'" EXIT INT TERM
  # The Redis address is passed, never defaulted: the rendered REDIS_URL and the
  # address the Redis containers publish on have to be the same value, and the
  # only place that value is decided is the terraform output above.
  pullfm_render_staging_secrets "${secrets}" "${redis_host}" || die "could not render secrets"

  # Redis first, wherever it lives. Ordering matters less than it did when this
  # node held Postgres and the app node ran migrations against it on first
  # deploy, but the BFF still reads REDIS_URL at startup, so bringing Redis up
  # first keeps a rebuild from logging a wave of connection errors it will only
  # recover from on retry.
  #
  # PRIVATE_IP is what the Redis instances bind to, and it is the whole
  # difference between the two shapes: the cache node's private address when
  # there is a cache node, the application node's own private address when Redis
  # rides on the application node. Never the public interface and never 0.0.0.0
  # on a node that has one.
  if [[ "${colocated}" == true ]]; then
    log "converging Redis onto ${APP_NODE} (${app_ip}), co-located"
    converge_node "${app_ip}" "${ROOT}/infra/staging/cache" "${secrets}" "cache.env" \
      "${secrets}/cache.env"
    ssh_node "${app_ip}" "cd /tmp/pullfm-config && sudo PRIVATE_IP=${redis_host} bash bootstrap.sh"
  else
    log "converging ${CACHE_NODE} (${cache_ip})"
    converge_node "${cache_ip}" "${ROOT}/infra/staging/cache" "${secrets}" "cache.env" \
      "${secrets}/cache.env"
    ssh_node "${cache_ip}" "cd /tmp/pullfm-config && sudo PRIVATE_IP=${redis_host} bash bootstrap.sh"
  fi

  log "converging ${APP_NODE} (${app_ip})"
  converge_node "${app_ip}" "${ROOT}/infra/staging/app" "${secrets}" "bff.env" \
    "${secrets}/bff.env" "${secrets}/origin.pem" "${secrets}/origin.key" \
    "${secrets}/origin-pull-ca.pem"

  # The watchdog's scrape configuration carries METRICS_TOKEN, so it travels the
  # same way bff.env does and lands root-owned 0600.
  scp -q -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "${secrets}/metrics.env" "${SSH_USER}@${app_ip}:/tmp/metrics.env"
  ssh_node "${app_ip}" "sudo install -m 0600 -o root -g root /tmp/metrics.env /etc/pullfm/metrics.env \
    && rm -f /tmp/metrics.env"

  # infra/observability ships alongside the app directory rather than inside it,
  # so it is sent as a second tar into the same working directory. bootstrap.sh
  # installs from ./observability if it is there.
  #
  # `backup` AND `lib` TRAVEL TOO, AND LEAVING THEM OUT WAS SILENT.
  #
  # bootstrap.sh installs the scheduled dump from ./backup and takes an `else`
  # branch with a warning when the directory is absent. Converge sent only
  # `observability`, so every converge produced a node with no backup timer and
  # said so in one line nobody was reading. The first install was done by hand
  # over this same SSH path, which is exactly the state this function exists to
  # make unnecessary: a node rebuilt from scratch came back WITHOUT the control,
  # and nothing failed.
  #
  # That matters more than it looks, because the node is disposable ON PURPOSE.
  # The database is Neon and the node holds nothing, so "rebuild it" is the
  # documented answer to a whole class of problem. A control that does not
  # survive a rebuild is a control that disappears on the day it is most likely
  # to be needed.
  #
  # `lib` is not optional decoration: infra/backup/pullfm-backup.sh sources
  # infra/lib/backup-common.sh, so shipping `backup` alone installs a unit that
  # fails on its first run rather than one that works.
  #
  # `mb-loader` WAS THE SAME GAP, FOUND THE SAME WAY AND ONE DAY LATER.
  # infra/mb-loader/systemd/ held a correct service and timer that nothing
  # installed, so `mb.canonical` sat at 0 rows against a migrated schema while
  # the repository read as though a daily refresh was scheduled. It ships here,
  # for the same reason `backup` does, and bootstrap.sh gates on ./mb-loader
  # exactly as it gates on ./backup.
  #
  # IT MUST RUN FROM THE NODE AND NOT FROM A WORKSTATION, which is the whole
  # reason it is worth wiring into this path rather than leaving it a manual
  # step. The load is 2.32 GB in and 31.5M rows out. Measured from a residential
  # workstation: 0.5 MB/s, upload bound, about 5.5 hours. Measured from this
  # node: minutes. Distance to data.metabrainz.org and to the database is the
  # entire cost of this job.
  tar czf - -C "${ROOT}/infra" observability backup mb-loader lib |
    ssh_node "${app_ip}" "tar xzf - -C /tmp/pullfm-config"

  # The scheduled dump's credentials: the bucket-scoped R2 pair and the dump
  # cipher material. Same treatment as metrics.env, and for the same reason.
  #
  # It is a SEPARATE file from bff.env rather than more lines in it because the
  # two are read by different things with different lifetimes: bff.env is
  # bind-mounted into the application container, and a container that can read
  # the backup cipher key can decrypt every dump in the bucket. The split is the
  # only thing keeping the dump key out of the internet-facing process.
  #
  # Non-fatal for the same reason the alert channel is: a missing backup
  # credential must not stop the environment coming up with a serving origin.
  # bootstrap.sh reports it, and the timer fails loudly on its first run rather
  # than silently producing nothing.
  if [[ -f "${secrets}/backup.env" ]]; then
    scp -q -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "${secrets}/backup.env" "${SSH_USER}@${app_ip}:/tmp/backup.env"
    ssh_node "${app_ip}" "sudo install -m 0600 -o root -g root /tmp/backup.env /etc/pullfm/backup.env \
      && rm -f /tmp/backup.env"
    log "  backup credentials installed"
  else
    warn "  no backup.env was rendered; the scheduled dump will fail on its first run"
  fi

  # The MusicBrainz loader's DSN. Same treatment, and the failure mode if it is
  # missing is QUIETER than the backup's rather than louder, which is why it is
  # worth a line of its own here: pullfm-mb-canonical.service carries
  # ConditionPathExists= for this file, so an absent file makes every daily run a
  # SKIP. A skip does not reach OnFailure and pages nobody, so the node would
  # report a healthy timer with a real NEXT and load nothing, forever.
  if [[ -f "${secrets}/mb-canonical.env" ]]; then
    scp -q -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "${secrets}/mb-canonical.env" "${SSH_USER}@${app_ip}:/tmp/mb-canonical.env"
    ssh_node "${app_ip}" "sudo install -m 0600 -o root -g root /tmp/mb-canonical.env /etc/pullfm/mb-canonical.env \
      && rm -f /tmp/mb-canonical.env"
    log "  MusicBrainz loader DSN installed"
  else
    warn "  no mb-canonical.env was rendered; the canonical refresh will SKIP every run and alert nobody"
  fi

  # THE ALERT URL IS A CREDENTIAL AND TRAVELS LIKE ONE. On ntfy the topic name
  # is the entire access control, so a URL in a log or an argv is a channel
  # anyone can read and forge into. install-alert-env.sh --stdout resolves it
  # from 1Password and writes it to stdout and nowhere else; it is piped
  # straight into a root-owned 0600 file over the same SSH channel the other
  # secrets use, and never through Terraform user_data, which is persisted in
  # state and readable from the Hetzner API for the life of the server.
  #
  # Non-fatal. An unarmed channel is a real gap and bootstrap.sh says so loudly,
  # but it is not a reason to leave the environment without a serving origin.
  if "${ROOT}/infra/observability/install-alert-env.sh" --stdout 2>/dev/null |
    ssh_node "${app_ip}" \
      "sudo install -m 0600 -o root -g root /dev/stdin /etc/pullfm/alert.env"; then
    log "  alert channel armed from 1Password"
  else
    warn "  could not arm /etc/pullfm/alert.env; the node will run its timers and notify nobody"
  fi

  # The TLS material is placed separately: it is group readable by www-data
  # rather than root-only, which is a different mode from the env file and
  # collapsing the two would loosen one of them.
  ssh_node "${app_ip}" "sudo install -d -m 0750 -o root -g www-data /etc/ssl/pullfm"
  scp -q -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "${secrets}/origin.pem" "${secrets}/origin.key" "${secrets}/origin-pull-ca.pem" \
    "${SSH_USER}@${app_ip}:/tmp/"
  ssh_node "${app_ip}" "sudo install -m 0644 -o root -g www-data /tmp/origin.pem /etc/ssl/pullfm/origin.pem \
    && sudo install -m 0640 -o root -g www-data /tmp/origin.key /etc/ssl/pullfm/origin.key \
    && sudo install -m 0644 -o root -g www-data /tmp/origin-pull-ca.pem /etc/ssl/pullfm/origin-pull-ca.pem \
    && rm -f /tmp/origin.pem /tmp/origin.key /tmp/origin-pull-ca.pem"

  # PULLFM_INGRESS decides whether nginx parses a PROXY header, and it is read
  # from the same terraform state that decided whether a load balancer exists.
  # Passing it rather than defaulting it is what stops the two from drifting.
  ssh_node "${app_ip}" "cd /tmp/pullfm-config && sudo PULLFM_INGRESS=$([[ ${ingress_mode} == load-balancer ]] && echo lb || echo direct) bash bootstrap.sh"
  # The deploy timer fires within 60 seconds anyway; forcing it here removes a
  # minute of avoidable waiting from every rebuild.
  ssh_node "${app_ip}" "sudo systemctl start pullfm-deploy.service" || true

  log "converged"
}

# Proves the environment serves traffic FROM THE PUBLIC URL.
#
# Not from the node, and not from the deployer's own exit code. A job that
# connects to a box and reports success proves the deployer ran. Polling
# https://api-staging.pull.fm/healthz proves the commit is serving real traffic
# through Cloudflare, the load balancer, nginx and the container - which is the
# only claim Gate 0 and Gate 4 are actually interested in.
cmd_verify() {
  local expected deadline body actual
  expected="${1:-$(git -C "${ROOT}" rev-parse HEAD)}"
  deadline=$((SECONDS + 900))

  log "polling https://${API_HOSTNAME}/healthz for ${expected:0:12}"
  while ((SECONDS < deadline)); do
    body="$(curl -sf --max-time 10 "https://${API_HOSTNAME}/healthz" || true)"
    actual="$(printf '%s' "${body}" |
      python3 -c 'import json,sys;
try: print(json.load(sys.stdin).get("version",""))
except Exception: print("")' 2>/dev/null || true)"
    if [[ -n "${actual}" ]]; then
      if [[ "${actual}" == "${expected}" ]]; then
        log "healthy on ${actual}"
        return 0
      fi
      printf '  serving %s, waiting for %s\n' "${actual:0:12}" "${expected:0:12}"
    fi
    sleep 10
  done
  die "https://${API_HOSTNAME}/healthz never reported ${expected:0:12} within 15 minutes"
}

cmd_up() {
  load_credentials
  assert_correct_project

  # Minted per apply. A key already spent by a previous boot would leave a
  # rebuilt node off the tailnet and therefore unreachable, which is the exact
  # failure this whole command exists to prevent.
  # Before the key is minted, not after: a node that boots into a tailnet still
  # holding its predecessor's registration inherits a deduped DNS name and is
  # then indistinguishable from the corpse by hostname alone.
  log "purging stale staging devices from the tailnet"
  purge_stale_tailnet_devices

  log "minting a single-use ephemeral Tailscale key"
  TF_VAR_tailscale_auth_key="$(mint_tailscale_key)" || exit 1
  export TF_VAR_tailscale_auth_key

  log "provisioning staging..."
  terraform -chdir="${ENV_DIR}" apply -input=false -auto-approve

  echo
  log "endpoints"
  terraform -chdir="${ENV_DIR}" output 2>/dev/null | grep -E "hostname|ipv4|bucket" || true

  echo
  log "waiting for cloud-init"
  local app_ip cache_ip=""
  # Only when one was provisioned. Waiting ten minutes for a node the
  # configuration no longer creates is how a rebuild becomes a support call -
  # and it is exactly what happened when the co-located Redis address stopped
  # being the loopback and this test still asked whether it was. The question
  # "is Redis somewhere other than the loopback" was never the question; "is
  # Redis at the CACHE NODE'S address" is, and that address is reserved whether
  # or not the node exists, so the comparison holds in both shapes.
  if [[ "$(tf_output redis_host 10.20.1.11)" == "$(tf_output cache_private_ip 10.20.1.21)" ]]; then
    cache_ip="$(wait_for_node "${CACHE_NODE}")"
  fi
  app_ip="$(wait_for_node "${APP_NODE}")"

  echo
  cmd_converge "${app_ip}" "${cache_ip}"

  echo
  cmd_verify "$(git -C "${ROOT}" rev-parse HEAD)"

  echo
  warn "The meter is running. Tear down with: ./infra/staging-env.sh down"
}

# Hetzner delete/rebuild protection is enforced by the API and therefore
# survives terraform. Clearing it here rather than through terraform is
# deliberate: by the time a targeted destroy hits the protected resource, the
# network and firewall it depends on may already be gone, so the apply that
# would flip the flag cannot be planned. Only ever reached after
# pullfm_assert_hetzner_project has confirmed this is not the personal fleet.
clear_delete_protection() {
  local id kind
  # networks last in the list but first in the failure order: a protected
  # network blocks the FINAL step of a teardown, after every server it contained
  # is already gone, which is the most expensive place for a destroy to stop.
  for kind in servers load_balancers networks volumes; do
    while read -r id; do
      [[ -z "${id}" ]] && continue
      warn "clearing delete protection on ${kind}/${id}"
      curl -sS -o /dev/null -X POST \
        -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
        -H 'Content-Type: application/json' \
        --data '{"delete":false,"rebuild":false}' \
        "https://api.hetzner.cloud/v1/${kind}/${id}/actions/change_protection" || true
    done < <(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
      "https://api.hetzner.cloud/v1/${kind}" |
      python3 -c "
import json,sys
for x in json.load(sys.stdin).get('${kind}', []):
    if any((x.get('protection') or {}).values()):
        print(x['id'])
")
  done
}

cmd_down() {
  load_credentials
  assert_correct_project
  clear_delete_protection

  log "destroying staging compute (the R2 backup bucket is preserved)..."

  # Build a target list of everything EXCEPT the keep-list. Terraform has no
  # "destroy all but these" flag, so the exclusion is computed from state.
  local targets=()
  while read -r addr; do
    [[ -z "${addr}" ]] && continue
    local keep=false
    for k in "${KEEP[@]}"; do
      [[ "${addr}" == "${k}"* ]] && keep=true && break
    done
    [[ "${keep}" == false ]] && targets+=("-target=${addr}")
  done < <(terraform -chdir="${ENV_DIR}" state list 2>/dev/null || true)

  if [[ ${#targets[@]} -eq 0 ]]; then
    log "nothing to destroy"
    return 0
  fi

  terraform -chdir="${ENV_DIR}" destroy -input=false -auto-approve "${targets[@]}"
  echo
  log "staging destroyed. The R2 backup bucket remains; DNS is rebuilt by 'up'."
  cmd_cost
}

cmd_status() {
  load_credentials
  # The escaping here is deliberate: an f-string cannot contain a backslash
  # before Python 3.12, so the JSON keys are lifted into locals first and the
  # program is fed on stdin rather than through -c.
  local servers
  servers="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    https://api.hetzner.cloud/v1/servers)"
  python3 - "${servers}" <<'PY'
import json, sys

srv = json.loads(sys.argv[1]).get("servers", [])
if not srv:
    print("  no servers running (staging is torn down)")
for x in srv:
    ip = (x.get("public_net", {}).get("ipv4") or {}).get("ip", "-")
    name, kind, state = x["name"], x["server_type"]["name"], x["status"]
    print(f"  {name:26s} {kind:7s} {state:9s} {ip}")
PY
}

# THE CURRENCY IS READ, NOT ASSUMED. This printed "EUR" against an account that
# Hetzner bills in USD, so every cost figure this repository quoted was a dollar
# figure wearing the wrong symbol, and the two are far enough apart to matter in
# a budget. /v1/pricing states the currency and the VAT rate; the gross price
# already includes any VAT, so no arithmetic is done here.
#
# The primary IPv4 is counted too. It is only 0.60 a month, but it is billed
# separately from the server, and an unassigned address left behind by a
# teardown still costs while this report called the environment free.
#
# Prices are taken at each resource's OWN location rather than from the first
# entry in the list, which happened to be right only because every price in the
# eu-central locations is currently identical.
cmd_cost() {
  load_credentials
  local servers lbs ips pricing
  servers="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" https://api.hetzner.cloud/v1/servers)"
  lbs="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" https://api.hetzner.cloud/v1/load_balancers)"
  ips="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" https://api.hetzner.cloud/v1/primary_ips)"
  pricing="$(curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" https://api.hetzner.cloud/v1/pricing)"
  python3 - "$servers" "$lbs" "$ips" "$pricing" <<'PYEOF'
import json, sys

srv = json.loads(sys.argv[1]).get("servers", [])
lbs = json.loads(sys.argv[2]).get("load_balancers", [])
ips = json.loads(sys.argv[3]).get("primary_ips", [])
pricing = json.loads(sys.argv[4]).get("pricing", {})

cur = pricing.get("currency", "???")
ipprice = {
    p["type"]: {x["location"]: float(x["price_monthly"]["gross"]) for x in p["prices"]}
    for p in pricing.get("primary_ips", [])
}


def at(prices, loc):
    """The price in this resource's own location, not whichever came first."""
    match = [p for p in prices if p.get("location") == loc]
    return float((match or prices)[0]["price_monthly"]["gross"])


total = 0.0
for x in srv:
    loc = x.get("datacenter", {}).get("location", {}).get("name", "")
    p = at(x["server_type"]["prices"], loc)
    total += p
    print(f"  {x['name']:26s} {cur} {p:7.2f}/mo  {x['server_type']['name']}")
for l in lbs:
    loc = l.get("location", {}).get("name", "")
    p = at(l["load_balancer_type"]["prices"], loc)
    total += p
    print(f"  {l['name']:26s} {cur} {p:7.2f}/mo")
for i in ips:
    # A primary IP reports `location` as a bare string and carries no
    # `datacenter`, unlike every other resource here. Reading it the same way as
    # a server silently priced every address at zero.
    loc = i.get("location") or ""
    if isinstance(loc, dict):
        loc = loc.get("name", "")
    p = ipprice.get(i["type"], {}).get(loc, 0.0)
    total += p
    print(f"  {i['name'][:26]:26s} {cur} {p:7.2f}/mo  {i['type']}")
print(f"  {'TOTAL':26s} {cur} {total:7.2f}/mo  ({cur} {total/730:.4f}/hour, {cur} {total/730*24:.2f}/day)")
if total == 0:
    print("  staging is fully torn down; only free-tier resources remain")
PYEOF
}

case "${1:-}" in
  up)       cmd_up ;;
  converge) cmd_converge ;;
  verify)   shift; cmd_verify "$@" ;;
  down)     cmd_down ;;
  status)   cmd_status ;;
  cost)     cmd_cost ;;
  *)        die "usage: $0 {up|converge|verify|down|status|cost}" ;;
esac
