# Cloudflare API token needed to apply this module

Nothing in this module has been applied, and it cannot be applied with any credential this project
holds. `security/AUDIT-2026-07-29.md` F11 recorded the reason: the staging token returns
`Authentication error` on both the `/rulesets` and the `/rate_limits` endpoints, because it was
scoped for DNS, zone settings and certificates and never for the firewall.

The module is written, `terraform fmt` clean and `terraform validate` clean. What is missing is a
token. Do not work around this by widening an existing token beyond the list below, and do not reach
for the account-wide Global API Key: `infra/lib/credentials.sh` already refuses to run when
`CLOUDFLARE_API_KEY` is set, and that refusal is correct.

## Mint the token

Cloudflare dashboard -> My Profile -> API Tokens -> Create Token -> Create Custom Token.

### Permissions

| Scope | Permission group     | Level    | Why                                                                                                                                                                           |
| ----- | -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone  | **Zone WAF**         | **Edit** | **The missing one.** Creates and updates the `http_ratelimit` and `http_request_firewall_custom` rulesets. Both phases are governed by this single group in the Rulesets API. |
| Zone  | Zone                 | Read     | The provider resolves and reads zone metadata on every plan. Without it the plan fails before it reaches a rule.                                                              |
| Zone  | Zone Settings        | Edit     | Already held. Required by the `zone-settings` module in the same root (`ssl`, `min_tls_version`, `security_header`, `tls_client_auth`).                                       |
| Zone  | SSL and Certificates | Edit     | Already held. Required by the same root.                                                                                                                                      |
| Zone  | DNS                  | Edit     | Already held. Required by the per-environment roots, not by this one.                                                                                                         |

### Zone resources

Include -> Specific zone -> **pull.fm**. Not "All zones from an account": this token can write
firewall policy, and a firewall token that reaches zones it does not manage is a blast radius with no
upside.

### Client IP address filtering and TTL

Optional and both worth setting. A TTL means a forgotten token expires instead of accumulating; IP
filtering means a leaked token is only useful from where you apply from.

## Things that look required and are not

- **Zone -> Firewall Services -> Edit** is for the LEGACY rate limiting API (`/zones/{id}/rate_limits`),
  which this module does not use. The audit probed that endpoint too, which is why it appears in the
  finding; adding this permission would not help and would grant more than is needed.
- **Account -> Account Rulesets** is for ACCOUNT-scoped rulesets. Everything here is `kind = "zone"`.
- **Account -> Workers R2 Storage -> Edit** is needed by the roots that keep state in R2. The
  `envs/shared` root still keeps state locally (its `backend "s3"` block is commented out), so this
  token does not need it today. It will if that root is migrated.

## Verify the token before planning

```bash
# 1. The token is alive at all.
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify

# 2. It can actually read rulesets on this zone. This is the call that fails
#    today with "Authentication error", so it is the one that proves the fix.
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets"
```

Both must return `"success": true`. The second returning an authentication error means the Zone WAF
grant did not land, whatever the token editor showed.

## Then, in order

```bash
cd infra/terraform/envs/shared
terraform init
terraform plan     # REQUIRED. See the warning below.
terraform apply
```

**`terraform validate` does not check the filter expressions.** It checks HCL and the provider
schema, and nothing more. Cloudflare parses `http.host eq "..."`, `starts_with(...)` and the rest
server side, so a malformed expression surfaces for the first time during plan or apply. Plan before
applying, and apply to staging before production.

## Plan constraints that will fail an apply rather than a plan

- `period_seconds` may only be `10` or `60` below an Enterprise plan. `120`, `300`, `600` and `3600`
  are Enterprise-only. The variable validation lists all six because they are all valid values of the
  API field; the plan is what decides which of them your zone may use.
- The NUMBER of rate limiting rules is plan-bound: Free 1, Pro 2, Business 5, Enterprise far more.
  Every rule in this module is individually toggleable for exactly this reason. If only one is
  affordable, keep `enable_edge_catalogue_rule`: it is the rule that matches the demonstrated abuse.

## Rollback

The rulesets are the only things this module creates and they are pure edge configuration, so
`terraform destroy -target=module.edge_rate_limit` removes them with no origin impact. Do not delete
them in the dashboard instead: the next apply would recreate them and the drift would be invisible
until then.
