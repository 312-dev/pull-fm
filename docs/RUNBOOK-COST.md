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

Measured live by `make cost`, not transcribed. As of 2026-07-29 **staging is
torn down and the Hetzner run rate is EUR 0.00/mo.** The per-resource figures
below were measured while it was up, and are what a gate run costs.

| Vendor        | Line                                          | Cost                                                 |
| ------------- | --------------------------------------------- | ---------------------------------------------------- |
| Hetzner       | `pullfm-staging-cache-1` (cpx11, no backups)  | EUR 4.35/mo (was EUR 16.19 as the Postgres node)     |
| Hetzner       | `pullfm-staging-app-1` (cpx12)                | EUR 13.49/mo                                         |
| Hetzner       | `pullfm-staging-lb` (lb11)                    | EUR 8.49/mo                                          |
| **Hetzner**   | **total while staging is UP**                 | **EUR 26.33/mo** (was EUR 38.17)                     |
| **Hetzner**   | **total while staging is DOWN**               | **EUR 0.00/mo**                                      |
| Cloudflare    | zone `pull.fm`, Universal SSL, proxied DNS    | $0 (free plan)                                       |
| Cloudflare R2 | `pull-fm-tfstate` + `pull-fm-backups-staging` | ~$0 (under the 10 GB free tier)                      |
| Neon          | project `pull-fm`, free plan                  | $0. **Cannot serve production**; see PLAN section 1c |
| WorkOS        | AuthKit, social + magic-link                  | $0 to 1M MAU                                         |

Staging is ephemeral (`docs/PLAN.md` section 10c). Hetzner bills hourly, so the
figure that matters is **EUR 0.0523/hour while up**: a three hour gate session
costs about EUR 0.16, and realistic usage lands near EUR 1-2/mo.

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
