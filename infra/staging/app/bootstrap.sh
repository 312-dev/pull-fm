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

install -m 0644 nginx-pullfm.conf /etc/nginx/sites-available/pullfm
ln -sf /etc/nginx/sites-available/pullfm /etc/nginx/sites-enabled/pullfm

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

systemctl daemon-reload
systemctl enable --now pullfm-cf-ranges.timer
systemctl enable --now pullfm-deploy.timer

echo
echo "bootstrap complete. First deploy runs within 60 seconds, or force it with:"
echo "  systemctl start pullfm-deploy.service && journalctl -u pullfm-deploy -n 50"
