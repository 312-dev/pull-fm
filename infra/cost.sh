#!/usr/bin/env bash
#
# Pull.fm - run rate and billing-alert check (Gate $).
#
#   make cost              # or: ./infra/cost.sh
#   ./infra/cost.sh --json # machine-readable
#
# Two jobs, and they are not the same job:
#
#   1. Report what the infrastructure currently costs per month, measured from
#      the live Hetzner API rather than from a table in a document that rots.
#   2. ASSERT that the billing alerts are armed. A run rate you have to remember
#      to look at is not a control. The script exits non-zero when a required
#      alert is missing or disabled, so Gate $ is machine-checkable and can be
#      wired into CI the moment a credential is available to it.
#
# What it CANNOT check, stated plainly rather than faked: Hetzner's cost limit
# is console-only. The Hetzner Cloud API (api.hetzner.cloud/v1) exposes no
# billing, usage, budget or alert resource at all - every such path returns
# 404 "api route not found" - and Hetzner's own billing FAQ documents the
# feature only as a page in the console. That control is verified by a human
# reading console.hetzner.com/usage. See docs/RUNBOOK-COST.md.
#
# Credentials: a read-only Cloudflare token (Notifications Read, Billing Read,
# Workers R2 Storage Read) plus the pull-fm Hetzner token. Deliberately unable
# to change anything it reports on.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/credentials.sh
source "${ROOT}/infra/lib/credentials.sh"

readonly CF_ACCOUNT="d463203cc84c2ef8ebd1b8f656ee66db"
readonly CF_API="https://api.cloudflare.com/client/v4"

JSON=false
[[ "${1:-}" == "--json" ]] && JSON=true
readonly JSON

pullfm_load_cost_credentials || exit 1

hcloud_get() {
  curl -sS -H "Authorization: Bearer ${HCLOUD_TOKEN}" "https://api.hetzner.cloud/v1/$1"
}
cf_get() {
  curl -sS -H "Authorization: Bearer ${CLOUDFLARE_COST_TOKEN}" "${CF_API}/$1"
}

servers="$(hcloud_get servers)"
lbs="$(hcloud_get load_balancers)"
volumes="$(hcloud_get volumes)"
primary_ips="$(hcloud_get primary_ips)"
floating_ips="$(hcloud_get floating_ips)"
policies="$(cf_get "accounts/${CF_ACCOUNT}/alerting/v3/policies")"

export PULLFM_JSON="${JSON}"
python3 - "$servers" "$lbs" "$volumes" "$primary_ips" "$floating_ips" "$policies" <<'PY'
import json, os, sys

as_json = os.environ["PULLFM_JSON"] == "true"
servers, lbs, volumes, primary_ips, floating_ips, policies = (
    json.loads(a) for a in sys.argv[1:7]
)

lines, total = [], 0.0


def price(obj, key):
    """Hetzner prices are per-location lists; the project is single-region."""
    p = obj.get(key) or []
    if not p:
        return 0.0
    entry = p[0]
    gross = entry.get("price_monthly") or entry.get("price") or {}
    return float(gross.get("gross", 0.0))


for s in servers.get("servers", []):
    p = price(s["server_type"], "prices")
    if s.get("backup_window"):  # Hetzner backups are +20% of the server price
        p *= 1.20
    lines.append((s["name"], s["server_type"]["name"], p))
    total += p

for l in lbs.get("load_balancers", []):
    p = price(l["load_balancer_type"], "prices")
    lines.append((l["name"], l["load_balancer_type"]["name"], p))
    total += p

for v in volumes.get("volumes", []):
    p = float(v["size"]) * 0.0440  # EUR/GB/month, Hetzner block storage
    lines.append((v["name"], f"volume {v['size']}GB", p))
    total += p

for ip in primary_ips.get("primary_ips", []) + floating_ips.get("floating_ips", []):
    p = price(ip, "prices") if "prices" in ip else 0.0
    if p:
        lines.append((ip.get("name", "ip"), ip.get("type", "ip"), p))
        total += p

# --- billing alert assertions -------------------------------------------
found = policies.get("result") or [] if policies.get("success") else []


def armed(alert_type, predicate=lambda p: True):
    return [
        p for p in found
        if p.get("alert_type") == alert_type and p.get("enabled") and predicate(p)
    ]


budget = armed("billing_budget_alert")
r2 = armed(
    "billing_usage_alert",
    lambda p: "r2_storage" in (p.get("filters", {}).get("product") or []),
)

checks = [
    ("cloudflare.billing_budget_alert", bool(budget),
     "account spend budget alert enabled"),
    ("cloudflare.billing_usage_alert.r2_storage", bool(r2),
     "R2 storage usage alert enabled"),
]
ok = all(c[1] for c in checks)

if as_json:
    print(json.dumps({
        "hetzner": {
            "currency": "EUR",
            "monthly": round(total, 2),
            "hourly": round(total / 730, 4),
            "resources": [
                {"name": n, "type": t, "monthly": round(p, 2)} for n, t, p in lines
            ],
        },
        "cloudflare_alerts": [
            {
                "name": p["name"],
                "type": p["alert_type"],
                "enabled": p["enabled"],
                "filters": p.get("filters"),
            }
            for p in found
            if p.get("alert_type", "").startswith("billing_")
        ],
        "checks": [{"id": i, "pass": v, "description": d} for i, v, d in checks],
        "manual_controls": [
            "hetzner.cost_limit (console-only, console.hetzner.com/usage)"
        ],
        "pass": ok,
    }, indent=2))
    sys.exit(0 if ok else 1)

print("Hetzner run rate (live, project pull-fm)")
if not lines:
    print("  no billable resources; staging is torn down")
for n, t, p in lines:
    print(f"  {n:30s} {t:14s} EUR {p:7.2f}/mo")
print(f"  {'TOTAL':30s} {'':14s} EUR {total:7.2f}/mo  (EUR {total / 730:.4f}/hour)")

print()
print("Cloudflare billing alerts")
billing = [p for p in found if p.get("alert_type", "").startswith("billing_")]
if not billing:
    print("  NONE CONFIGURED")
for p in billing:
    f = p.get("filters") or {}
    detail = ", ".join(f"{k}={'/'.join(v)}" for k, v in sorted(f.items()))
    state = "enabled " if p["enabled"] else "DISABLED"
    print(f"  [{state}] {p['name']}")
    print(f"             {p['alert_type']}  {detail}")

print()
print("Gate $ checks")
for i, v, d in checks:
    print(f"  [{'PASS' if v else 'FAIL'}] {i}: {d}")
print("  [MANUAL] hetzner.cost_limit: no API exists; verify at console.hetzner.com/usage")

print()
print("Cost limits do not cap spend on either vendor. They notify. The only")
print("hard cap on Hetzner spend is tearing the environment down:")
print("  ./infra/staging-env.sh down")

sys.exit(0 if ok else 1)
PY
