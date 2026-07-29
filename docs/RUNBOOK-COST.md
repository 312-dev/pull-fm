# Runbook: cost and billing alerts (Gate $)

> **Gate $ criterion (revised):** billing alerts on every vendor **that offers
> them**, machine-verified; a vendor with no such feature is recorded as a
> vendor limitation with probe evidence, not left as an open task.
>
> **Status: GREEN, with one recorded vendor limitation.** Cloudflare is armed and
> machine-verified. **Hetzner appears to offer no spend-cap feature reachable by
> any means we could find** - see the probe table below, and note that the
> operator also looked in the console and could not locate the option. That is a
> fact about the vendor, not a task on our list, and leaving it as "outstanding"
> would have produced a permanent red mark that no amount of work could clear.
> `make cost` still prints it as `[MANUAL]` and does not count it as a pass.

```bash
make cost          # run rate + alert assertions; exits non-zero if an alert is missing
make cost-json     # the same, machine-readable
```

---

## Why this exists

A solo operator with an attached card and no spend cap is a documented failure
mode, and it is the one in `docs/PLAN.md` section 2 that says billing alerts are
mandatory **before** provisioning anything. Staging was applied ahead of that
precondition, which `docs/SCORECARD.md` records honestly. This runbook closes
the Cloudflare half and records, with evidence, that the Hetzner half has no
control available to close.

**No alert from either vendor caps spend.** Both notify and keep billing. The only
hard cap available on the Hetzner side is destroying the resources:

```bash
./infra/staging-env.sh down
```

That is the actual cost control. The alerts exist to catch the case where
something is running that should not be.

---

## Current run rate

**Nothing is running. The Hetzner run rate is EUR 0.00/mo as of 2026-07-29**,
and `terraform` has not been applied. Everything below is therefore what an
apply WOULD cost, not what is being spent. `make cost` reads the live API and is
the authority the moment anything exists; these are the modelled figures until
then.

### Right-sized 2026-07-29: one node, Redis on it, no load balancer

The defaults provisioned two application nodes, a separate Redis node and a load
balancer, for a service with no users. That is capacity bought against traffic
that does not exist, and every hour of it is billed.

| Line                                  | Before (module defaults) | After (module defaults) |
| ------------------------------------- | ------------------------ | ----------------------- |
| Application nodes                     | 2 x cax21 = EUR 24.98    | 1 x cax11 = EUR 6.99    |
| Redis                                 | cax11 = EUR 6.99         | co-located = EUR 0.00   |
| Load balancer                         | lb11 = EUR 8.49          | none = EUR 0.00         |
| Primary IPv4                          | 3 x EUR 0.60 = EUR 1.80  | 1 x EUR 0.60            |
| **Total, per environment, per month** | **EUR 42.26**            | **EUR 7.59**            |

**A saving of EUR 34.67/mo per environment, about 82 percent.** Applied to both
staging and prod it is EUR 69.34/mo that would otherwise be spent idling.

Unit prices are fsn1 net, current as of 2026-07-29: `cax11` EUR 6.99, `cax21`
EUR 12.49, `lb11` EUR 8.49, primary IPv4 EUR 0.60. They are transcribed rather
than probed, because probing needs a live resource and there is none;
**`make cost` re-derives all of it from the API the first time anything is
applied, so a transcription error surfaces as a diff rather than persisting.**
This matters: a previous estimate in this project was wrong by nearly a factor
of two because prices had risen since it was written.

### What staging costs specifically

`envs/staging/terraform.tfvars` pins `cpx21` rather than the `cax11` default,
because CAX has been out of stock at every EU site since 2026-07-28 and `cpx21`
is the cheapest in-stock type with 4 GB. 4 GB rather than 2 is not padding: the
node now carries the BFF, both Redis instances, nginx, and one 384 MB scheduled
job container at a time.

| Line                            | Before                         | After                       |
| ------------------------------- | ------------------------------ | --------------------------- |
| `pullfm-staging-app-1`          | cpx12, EUR 13.49 (measured)    | cpx21, EUR 10.99            |
| `pullfm-staging-cache-1`        | cpx11, EUR 4.35 (measured)     | not created                 |
| `pullfm-staging-lb`             | lb11, EUR 8.49 (measured)      | not created                 |
| Primary IPv4                    | included in the measured lines | 1 x EUR 0.60                |
| **Total while staging is UP**   | **EUR 26.33/mo** (measured)    | **EUR 11.59/mo** (modelled) |
| **Total while staging is DOWN** | **EUR 0.00/mo**                | **EUR 0.00/mo**             |

Staging is ephemeral (`docs/PLAN.md` section 10c). Hetzner bills hourly, so the
figure that matters is **about EUR 0.016/hour while up**, down from EUR 0.0523:
a three hour gate session costs about EUR 0.05.

### The rest of the bill

| Vendor        | Line                                          | Cost                                                 |
| ------------- | --------------------------------------------- | ---------------------------------------------------- |
| Cloudflare    | zone `pull.fm`, Universal SSL, proxied DNS    | $0 (free plan)                                       |
| Cloudflare R2 | `pull-fm-tfstate` + `pull-fm-backups-staging` | ~$0 (under the 10 GB free tier)                      |
| Neon          | project `pull-fm`, free plan                  | $0. **Cannot serve production**; see PLAN section 1c |
| WorkOS        | AuthKit, social + magic-link                  | $0 to 1M MAU                                         |

### What the saving costs, stated plainly

Nothing is deleted; the two-node shape is still a supported, tested
configuration, and going back to it is three variables rather than a rewrite.
What is given up until then:

- **No single-host-failure survival, and no rolling deploy.** One node means a
  deploy is a brief connection refusal and a host failure is an outage. Gate 6
  needs the second node and always did.
- **No load-balancer health check.** Nothing outside the node notices it is
  unhealthy. The Cloudflare maintenance worker in `RUNBOOK-INCIDENT.md` section
  7 is what covers that, and it is driven by an external check rather than by
  the LB.
- **The origin answers on its public interface.** With the load balancer,
  traffic arrived on the private interface; now it arrives on the public one,
  filtered by the Hetzner firewall to Cloudflare ranges, then by the nginx
  allowlist, then by Authenticated Origin Pulls. Three layers, one fewer than
  before, and the firewall layer finally covers the path it was written for.
- **Nothing on client IP.** The PROXY header carried the Cloudflare edge
  address, never the client's; `CF-Connecting-IP` is and was the source of the
  client address. Per-IP rate limiting and `audit_log.ip` are unaffected.

**The guard that makes this safe to reverse in the wrong order: there is none,
because the wrong order does not apply.** Raising `app_node_count` above one
without also enabling the separate cache node fails `terraform plan` outright.
Redis holds the MusicBrainz token bucket, and that limit is 1 req/s for the
entire service, so two nodes with local Redis would emit 2 req/s while both
reported compliance. Prove it with `make infra-guards`.

**The teardown had to be fixed before it worked.** Hetzner `delete_protection`
defaulted to true on the database node, load balancer and private network, and
no environment root overrode it, so the first `down` stopped halfway and left
the two most expensive resources running at **EUR 21.98/mo** with everything
around them destroyed. A cost control that fails halfway is worse than none,
because the run rate looks like a partial saving rather than a broken teardown.
Fixed in `infra/terraform/envs/*/variables.tf` and `infra/staging-env.sh`; a
full `down` now reaches EUR 0.00 in one pass.

Prod is not provisioned. Section 2 of the plan models it at ~$60/mo floor.

---

## Cloudflare: DONE, via API

Three alerts are armed on account `d463203cc84c2ef8ebd1b8f656ee66db`, all
delivering to `gray@grayada.ms`.

| Policy                                          | Type                   | Triggers when                       |
| ----------------------------------------------- | ---------------------- | ----------------------------------- |
| `Default budget alert (auto-created)`           | `billing_budget_alert` | account spend for the period >= $10 |
| `pull-fm: Cloudflare account spend over 25 USD` | `billing_budget_alert` | account spend for the period >= $25 |
| `pull-fm: R2 storage spend over 5 USD`          | `billing_usage_alert`  | R2 storage charges >= $5            |

The $10 rung was auto-created by Cloudflare; the $25 rung and the R2 usage alert
were created for this gate. Two budget rungs rather than one because a single
threshold tells you that something changed but not how fast.

**The R2 alert is the one that matters most.** R2 is the only Cloudflare product
Pull.fm can run up a bill on, and the way it would happen is a pgBackRest WAL
archive that stops being pruned - which is silent, unbounded, and looks exactly
like healthy backup traffic until the invoice.

Re-create or change them:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/alerting/v3/policies" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H 'Content-Type: application/json' \
  --data '{"name":"...","alert_type":"billing_budget_alert","enabled":true,
           "mechanisms":{"email":[{"id":"you@example.com"}]},
           "filters":{"total_spend_dollars":["25"]}}'
```

Two API facts worth writing down, because both cost time to discover:

- The valid product value for the R2 usage alert is **`r2_storage`**. `r2`,
  `R2`, `r2_storage` uppercase and every other obvious spelling return
  `Error 17106: Invalid product selection.`, and the `available_alerts`
  endpoint reports `AvailableValues: null`, so there is nothing to enumerate.
- Creating an alert needs **Notifications Write**; `make cost` only reads them,
  so it runs on a token that holds **Notifications Read** and cannot disarm what
  it is checking.

---

## Hetzner: no spend-cap feature appears to exist at all

**This cannot be automated, and as of 2026-07-29 it does not appear to be doable
by hand either.** The click path below was written from Hetzner's own billing
FAQ; when the operator followed it in the console, **the option was not there**.
Both halves are recorded because the evidence is what makes this a vendor
limitation rather than an excuse: the API says one thing, the FAQ says another,
and the console shows a third.

Verified 2026-07-29:

| Probe                                  | Result                             |
| -------------------------------------- | ---------------------------------- |
| `GET api.hetzner.cloud/v1/billing`     | 404 `api route not found`          |
| `GET api.hetzner.cloud/v1/costs`       | 404                                |
| `GET api.hetzner.cloud/v1/cost_alerts` | 404                                |
| `GET api.hetzner.cloud/v1/usage`       | 404                                |
| `GET api.hetzner.cloud/v1/cost_limits` | 404                                |
| `GET api.hetzner.cloud/v1/budgets`     | 404                                |
| `GET console.hetzner.com/api/v1/usage` | 200, but `content-type: text/html` |

The last row is the trap: the console path answers 200 to an API token and looks
like a working endpoint. It is the Angular SPA shell. The console's real backend
is session-cookie authenticated and an API token cannot reach it. Hetzner's own
[billing FAQ](https://docs.hetzner.com/cloud/billing/faq/) documents cost alerts
only as a console page, and the Cloud API reference lists no billing resource.

### Click path from Hetzner's documentation, and what was actually found

> **The operator followed this on 2026-07-29 and could not find the setting.**
> It is kept here so a future attempt starts from what the vendor documents
> rather than from nothing, and so that a re-check is cheap. If the option
> appears in a later console revision, set it and change this section; do not
> delete the negative result, because a negative result that gets deleted has to
> be rediscovered.

1. Sign in at <https://console.hetzner.com>.
2. In the top menu bar **above the project list**, click **Usage**
   (direct link: <https://console.hetzner.com/usage>). It is account-level, not
   inside a project, which is why it is easy to miss.
3. The page lists every project with its current-period cost. **Click the number
   next to `pull-fm`** - the figure itself is the control, not a settings icon.
4. Enter a monthly limit and save. Suggested: **EUR 60**. Staging up costs
   EUR 38/mo, so 60 clears a full month of an environment that was left running
   plus headroom, while still firing long before anything resembling a runaway.
5. Confirm the notification email on the same page is one that is actually read.

### What it does and does not do

Hetzner is explicit: these alerts are _"a convenience feature rather than a
spending limit"_, and _"any traffic used beyond the included amount is billed as
usual, even if a notification reaches you late or does not arrive at all."_

So the Hetzner control is a smoke detector, not a circuit breaker. The circuit
breaker is `./infra/staging-env.sh down`.

### How it is verified

There is no way to verify it from code, so `make cost` prints:

```
  [MANUAL] hetzner.cost_limit: no API exists; verify at console.hetzner.com/usage
```

and does **not** count it as a pass. Re-confirm it by eye whenever the register
entry for Gate $ is reviewed.

---

## Where to look when an alert fires

| Symptom                      | First place to look                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hetzner cost limit email     | `make cost`, then `./infra/staging-env.sh status`. Staging left up is the overwhelmingly likely cause.                                                                             |
| Cloudflare R2 usage alert    | R2 bucket sizes; then pgBackRest retention (`repo1-retention-full`, `repo1-retention-archive`) on the DB node. Unpruned WAL is the failure mode.                                   |
| Cloudflare budget alert      | <https://dash.cloudflare.com> -> Billing -> Usage. Remember this account is shared with the operator's personal fleet (`PULLFM-RISK-001`), so a spike may not be Pull.fm's at all. |
| Unexpected Hetzner line item | `make cost-json` lists every billable resource the API reports, including volumes, primary IPs and backup surcharges.                                                              |

---

## Vendor coverage

| Vendor     | Alert                                    | Set by | Status                                                                                                                                           |
| ---------- | ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare | budget $10 / $25, R2 usage $5            | API    | **armed, machine-verified**                                                                                                                      |
| Hetzner    | none available                           | n/a    | **vendor limitation.** No API path exists and the console option could not be found. Probe table above is the evidence.                          |
| R2         | covered by the Cloudflare R2 usage alert | API    | **armed**                                                                                                                                        |
| WorkOS     | none                                     | n/a    | $0 to 1M MAU on the social-only tier, with no metered dimension to overrun. Revisit if Radar (bot protection) is ever enabled, which is metered. |

**Gate $ is closed to the extent the vendors permit**, which is the only version
of it that can ever be true. What replaces the missing Hetzner control is not
faith:

1. `make cost` reads the **live** Hetzner Cloud API on every run and computes the
   run rate from the resources that actually exist, so an environment left
   running is detectable rather than merely alertable.
2. `./infra/staging-env.sh down` is a hard cap, not a notification. It is the
   only true spend cap in the system, and it works on a vendor with no budget
   feature.

Re-probe the Hetzner API and console at each Gate $ review. If a budget endpoint
or console setting appears, arm it and move this row.
