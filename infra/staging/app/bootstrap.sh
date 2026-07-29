#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Bootstraps the Pull.fm staging application node.
#
# Idempotent: safe to re-run. Run as root ON THE NODE, from a directory holding
# this repository's infra/staging/app contents, with these already placed:
#
#   /etc/pullfm/bff.env              application configuration and secrets
#   /etc/ssl/pullfm/origin.pem       Cloudflare Origin CA certificate
#   /etc/ssl/pullfm/origin.key       its private key
#   /etc/ssl/pullfm/origin-pull-ca.pem   Cloudflare's origin-pull CA
#
# None of those four are in git and none ever will be.
# ---------------------------------------------------------------------------
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

for f in /etc/pullfm/bff.env /etc/ssl/pullfm/origin.pem /etc/ssl/pullfm/origin.key /etc/ssl/pullfm/origin-pull-ca.pem; do
  [ -f "$f" ] || {
    echo "missing $f" >&2
    exit 1
  }
done

# /etc/pullfm/alert.env is NOT in that list, and the asymmetry is deliberate.
# The four files above are ones the node cannot serve traffic without, so a
# missing one must stop the bootstrap. The alert channel is one the node can
# serve traffic without, so refusing to bootstrap over it would trade a working
# origin for a notification channel. It is still a real gap, so it is loud
# rather than fatal: an unarmed node runs its timers and tells nobody when they
# fail, which is the exact defect this environment exists to stop shipping.
if [ ! -f /etc/pullfm/alert.env ]; then
  echo "WARNING: /etc/pullfm/alert.env is missing. The watchdog and the four" >&2
  echo "job timers will run and will NOT be able to notify anyone." >&2
  echo "Arm it with: infra/observability/install-alert-env.sh --stdout | ssh ..." >&2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 nginx
systemctl enable --now docker

# --- permissions on material that must not be world readable ---------------
chmod 0750 /etc/pullfm
chmod 0600 /etc/pullfm/bff.env
chmod 0750 /etc/ssl/pullfm
chmod 0640 /etc/ssl/pullfm/origin.key
chown -R root:www-data /etc/ssl/pullfm

# --- nginx -----------------------------------------------------------------
# Ubuntu's stock default site is a catch-all on port 80 without proxy_protocol,
# which would answer the load balancer's health check before our own server
# block ever sees it, and answer it with a 400.
rm -f /etc/nginx/sites-enabled/default

# --- ingress mode ----------------------------------------------------------
# Two supported paths, and the listener must match the one Terraform actually
# provisioned. Getting this wrong is not subtle in its effect and is very subtle
# in its appearance: a listener that does not expect a PROXY header reads it as
# the first line of an HTTP request and answers 400 to EVERY connection, which
# looks exactly like an application bug.
#
#   direct  (default)  Cloudflare talks straight to this node. Matches
#                      enable_load_balancer = false, which is the pre-launch
#                      shape: one application node, no EUR 8.49/mo load balancer
#                      round-robining across a single target.
#   lb                 A Hetzner load balancer fronts the node with TCP
#                      passthrough and proxyprotocol = true. Matches
#                      enable_load_balancer = true, which is required for more
#                      than one application node.
#
# Client IP is unaffected by the choice. The PROXY header carries the CLOUDFLARE
# EDGE address, never the client's; the client address comes from
# CF-Connecting-IP and is forwarded to the BFF either way. Per-IP rate limiting
# and audit_log.ip see the same values on both paths.
PULLFM_INGRESS=${PULLFM_INGRESS:-direct}

case "${PULLFM_INGRESS}" in
  direct) PROXY_TOKEN="" ;;
  lb) PROXY_TOKEN="proxy_protocol" ;;
  *)
    echo "PULLFM_INGRESS must be 'direct' or 'lb', got '${PULLFM_INGRESS}'" >&2
    exit 1
    ;;
esac

# Substitution is restricted to `listen` lines so the placeholder survives in
# the template's own documentation. The count assertions are the point of doing
# it this way: a future edit that adds a listener and forgets the placeholder,
# or renames it, fails the bootstrap instead of producing a config that starts
# and rejects every request.
EXPECTED_LISTENERS=4
found=$(grep -cE '^[[:space:]]*listen .*@PROXY@' nginx-pullfm.conf.in || true)
if [ "${found}" -ne "${EXPECTED_LISTENERS}" ]; then
  echo "expected ${EXPECTED_LISTENERS} templated listen directives, found ${found}" >&2
  exit 1
fi

sed -E "/^[[:space:]]*listen /s/@PROXY@/${PROXY_TOKEN}/" \
  nginx-pullfm.conf.in >/tmp/pullfm-nginx.rendered

if grep -qE '^[[:space:]]*listen .*@PROXY@' /tmp/pullfm-nginx.rendered; then
  echo "a listen directive still carries the placeholder after rendering" >&2
  exit 1
fi

install -m 0644 /tmp/pullfm-nginx.rendered /etc/nginx/sites-available/pullfm
rm -f /tmp/pullfm-nginx.rendered
ln -sf /etc/nginx/sites-available/pullfm /etc/nginx/sites-enabled/pullfm

# The other half of the same decision, written in the same step so the two
# cannot be edited apart. On the load-balancer path realip rewrites $remote_addr
# from the PROXY header to the Cloudflare edge address; on the direct path
# $remote_addr is already that address and any realip rule here would be wrong.
# Either way the allowlist reads $remote_addr, which is what lets one template
# serve both paths.
if [ "${PULLFM_INGRESS}" = "lb" ]; then
  cat >/etc/nginx/conf.d/00-pullfm-ingress.conf <<'INGRESS'
# Generated by bootstrap.sh for PULLFM_INGRESS=lb. Do not edit.
set_real_ip_from 10.20.1.0/24;
real_ip_header proxy_protocol;
INGRESS
else
  cat >/etc/nginx/conf.d/00-pullfm-ingress.conf <<'INGRESS'
# Generated by bootstrap.sh for PULLFM_INGRESS=direct. Do not edit.
# No realip rule: Cloudflare is the L3 peer, so $remote_addr is already the
# edge address the allowlist checks. Adding a CF-Connecting-IP realip rule here
# would rewrite $remote_addr to the CLIENT address and the allowlist would then
# 403 every real user.
INGRESS
fi
chmod 0644 /etc/nginx/conf.d/00-pullfm-ingress.conf

install -m 0755 pullfm-cf-ranges /usr/local/bin/pullfm-cf-ranges
# Must run before the first `nginx -t`: the allowlist file defines the
# $cloudflare_edge variable the site config references, and nginx refuses to
# start with an undefined variable.
/usr/local/bin/pullfm-cf-ranges || {
  echo "could not build the Cloudflare allowlist" >&2
  exit 1
}

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# --- application -----------------------------------------------------------
install -d -m 0755 /opt/pullfm
install -m 0644 docker-compose.yml /opt/pullfm/docker-compose.yml
install -m 0755 pullfm-deploy /usr/local/bin/pullfm-deploy

install -m 0644 systemd/pullfm-deploy.service /etc/systemd/system/
install -m 0644 systemd/pullfm-deploy.timer /etc/systemd/system/
install -m 0644 systemd/pullfm-cf-ranges.service /etc/systemd/system/
install -m 0644 systemd/pullfm-cf-ranges.timer /etc/systemd/system/

# --- scheduled background jobs ---------------------------------------------
# Four jobs that bound something: two retention windows the privacy policy
# states, one unconsented-record window with no lawful basis to exceed, and the
# cache warm that keeps the request path from spending a global 1 req/s provider
# budget on a page render. Each is a COMMAND, run in a one-shot container built
# from the digest that is currently serving, never an in-process timer. The
# reasoning, the cadences and the exit-code contract are in docs/RUNBOOK-JOBS.md
# and in the header of each entrypoint under apps/bff/src/scripts/.
#
# The timers are installed on every application node rather than pinned to one.
# That is safe because each job takes a Postgres advisory lock on a pinned
# connection and a second invocation DECLINES rather than racing, and it is the
# only arrangement that survives a node being replaced. Pre-launch there is one
# application node, so the lock is a belt on a second node that does not exist
# yet; see infra/terraform/envs/*/main.tf for the guard that keeps it that way.
install -m 0755 pullfm-job /usr/local/bin/pullfm-job
install -m 0755 pullfm-job-alert /usr/local/bin/pullfm-job-alert

install -m 0644 systemd/pullfm-job-alert@.service /etc/systemd/system/
for job in warm-cache sweep-expired purge-audit reap-unverified; do
  install -m 0644 "systemd/pullfm-${job}.service" /etc/systemd/system/
  install -m 0644 "systemd/pullfm-${job}.timer" /etc/systemd/system/
done

# --- notification channel and watchdog -------------------------------------
# Shipped from infra/observability/, which converge places alongside this
# directory as ./observability. The alert sender is installed even when
# alert.env is absent: the four job units above name pullfm-job-alert@ in their
# OnFailure, and a missing /usr/local/bin/pullfm-alert would turn a job failure
# into a second, more confusing failure of the thing meant to report it.
#
# The watchdog is what turns a metric CONDITION into a notification, so without
# it the four timers can only report their own exit codes and nothing reports a
# limiter that stopped pacing or a container that stopped answering.
if [ -d observability ]; then
  install -m 0755 observability/pullfm-alert /usr/local/bin/pullfm-alert
  install -m 0755 observability/pullfm-watchdog /usr/local/bin/pullfm-watchdog
  install -m 0644 observability/systemd/pullfm-watchdog.service /etc/systemd/system/
  install -m 0644 observability/systemd/pullfm-watchdog.timer /etc/systemd/system/
  # ReadWritePaths= in the watchdog unit names both of these, and a unit whose
  # ReadWritePaths does not exist fails to start rather than creating it.
  install -d -m 0755 /var/lib/pullfm /var/log/pullfm
else
  echo "WARNING: observability/ was not shipped; no watchdog will be installed" >&2
fi

systemctl daemon-reload
systemctl enable --now pullfm-cf-ranges.timer
systemctl enable --now pullfm-deploy.timer

if [ -x /usr/local/bin/pullfm-watchdog ]; then
  systemctl enable --now pullfm-watchdog.timer
fi

# `enable --now` on a timer, never on the .service. Starting the service here
# would run every job once during bootstrap, before the first deploy has put an
# image on the node, which is the case ConditionPathExists is there to skip.
systemctl enable --now pullfm-warm-cache.timer
systemctl enable --now pullfm-sweep-expired.timer
systemctl enable --now pullfm-purge-audit.timer
systemctl enable --now pullfm-reap-unverified.timer

echo
echo "bootstrap complete. First deploy runs within 60 seconds, or force it with:"
echo "  systemctl start pullfm-deploy.service && journalctl -u pullfm-deploy -n 50"
echo
echo "scheduled jobs (they skip until the first deploy pins an image):"
echo "  systemctl list-timers 'pullfm-*'"
