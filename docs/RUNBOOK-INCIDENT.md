# Runbook: incidents (Gate 5)

> **Gate 5 criterion:** each of a **named list** of alert conditions fires to
> ntfy within 60 seconds when triggered synthetically, evidenced by a timestamped
> log; every alert has a runbook URL returning 200.
>
> **Status: SPECIFICATION ONLY, with one partial exception.** No alert in
> section 6 delivers a notification. The scheduled-job rows J1 to J4 have their
> detection and classification committed and their delivery unconfigured, which
> is called out where they appear. The list,
> the synthetic trigger for each, and the runbook anchor each links to are
> written here so the alerting work has a target and so Gate 5 has something to
> be measured against. **Nothing below should be read as "we will be told".**
> Read section 6's status column literally.

---

## 1. The design assumption: nobody is coming

Pull.fm is operated by **one person, with no on-call rotation, no secondary, and
no escalation path**. Every design decision in this runbook follows from taking
that seriously rather than pretending otherwise.

An alert at 3am with nobody to receive it is a notification, not a response. So
the system is built to **degrade automatically instead of paging**:

| Instead of                    | We do                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Paging on a crashed process   | Restart policy on the container; the process comes back without anyone                                                            |
| Paging on a failed origin     | An external health check enables the Cloudflare maintenance worker, so users get an honest 503 instead of a timeout               |
| Paging on a degraded upstream | Circuit breaker opens, the affected feed section is omitted, and the response carries `degraded: true` and `unavailableProviders` |
| Paging on a database problem  | Read-only degraded mode: reads served, mutations refused with a clear error                                                       |
| Paging on a runaway cost      | `./infra/staging-env.sh down` is a hard cap that needs no human at 3am to be effective the next morning                           |

**Notifications still exist**, and they go to ntfy. Their purpose is to tell the
operator what already happened and what already degraded, not to summon a
response inside a time budget nobody can keep.

### The published SLO

> **Pull.fm is best effort. There is no uptime guarantee, no support commitment,
> and no 24/7 response.** Outages may last hours. Both the data export and the
> account deletion endpoints are designed to work without operator involvement,
> because those are the two things a user must never have to wait for.

This is stated in [`../legal/terms-of-service.md`](../legal/terms-of-service.md)
section 12 and in [`../SECURITY.md`](../SECURITY.md), because a service level
that only exists in an internal document is not published.

**Vacation mode** is a defined state, not an absence: deploy freeze, maintenance
worker armed to auto-enable on failure, and a pinned notice in `GET /v1/config`.

---

## 2. Severity, and what each one actually means here

Severity is defined by **what degrades and who is harmed**, not by how alarming
it feels.

| Sev       | Definition                                                                                                   | Expected response                                      |
| --------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **SEV-1** | A third party's credentials are, or may be, exposed. The KEK, a database dump, a backup, or the token vault. | Everything else stops. See section 4.                  |
| **SEV-2** | User data is exposed to the wrong user, or destroyed. BOLA, a bad migration, an erroneous cascade.           | Same day. Stop deploys.                                |
| **SEV-3** | An upstream licence is at risk: quota burned, terms breached, a revocation notice received.                  | Same day. **This is product-ending, not operational.** |
| **SEV-4** | The service is down or degraded for everyone.                                                                | Auto-degrade. Fix when the operator is next available. |
| **SEV-5** | Cost anomaly, partial degradation, one provider down.                                                        | Next working session.                                  |

**SEV-3 outranks SEV-4 deliberately.** Losing MusicBrainz access ends the
product; there is no second supplier of MBIDs. An outage is recoverable. A
revocation is not, and it arrives without appeal or SLA.

---

## 3. First fifteen minutes, for any incident

```bash
# 1. Is it us, or is it the edge?
curl -sS -o /dev/null -w '%{http_code}\n' https://api-staging.pull.fm/healthz
#    525 => edge cannot reach origin (TLS). 503 => maintenance or not ready.
#    521 => origin refusing. 200 => the API is fine, look elsewhere.

# 2. What does the app itself say about its dependencies?
curl -sS https://api-staging.pull.fm/readyz | jq .
#    { "status": "not_ready", "checks": { "database": "fail", "redis": "ok" } }

# 3. Is the environment even up? (Staging is ephemeral and often deliberately down.)
./infra/staging-env.sh status
make cost                     # a non-zero run rate means something is running

# 4. What is running on the node, and what is it running?
#    Requires break-glass SSH: see RUNBOOK-DEPLOY.md section 7.
systemctl status pullfm-deploy.timer
docker compose -f /opt/pullfm/docker-compose.yml ps
journalctl -u pullfm-deploy --since '-1h'
```

**Write down the time you started and what you observed, before you change
anything.** A solo operator has no colleague to reconstruct the timeline with,
and the audit trail is `audit_log` plus your own notes and nothing else.

### Stop the bleeding

```bash
# Put the service into honest downtime rather than leaving it timing out.
MAINTENANCE_MODE=true    # in /etc/pullfm/bff.env, then restart the container
# Application routes return 503 with Retry-After: 300; /healthz still returns
# 200, so the orchestrator can tell intentional downtime from a crash.
```

Rolling back a bad deploy: [`RUNBOOK-DEPLOY.md`](RUNBOOK-DEPLOY.md) section 5.

---

## 4. SEV-1: suspected credential exposure

This is the only scenario where the runbook says "do this now, at any hour". The
asset is not ours: a Last.fm session key is a credential on a user's real Last.fm
account, and **Last.fm session keys do not expire**. We would be the breach
vector for accounts we do not control and cannot revoke.

### Order of operations

1. **Contain.** `MAINTENANCE_MODE=true`. If the suspected path is the database or
   a backup credential, revoke that credential first, before anything else.
2. **Preserve evidence.** Do not restart the affected node until you have
   `journalctl` output and the relevant `audit_log` rows. A restart is the
   default instinct and it destroys the timeline.
3. **Scope it.** `audit_log` is the tool this exists for: it answers "which
   accounts, over which window" and turns a mass "everybody rotate everything"
   notice into a scoped one. Query by `action`, `created_at`, and `ip`.
4. **Rotate the KEK** if it is in scope. Rotation re-wraps data keys and never
   touches token plaintext, so it is an online operation, and `kek_id` exists
   from day one specifically so this is possible.
   `[OPEN: the rotation drill has never been rehearsed. PULLFM-RISK-003's review
notes say that if it has not been, this risk should be rated critical, because
rotation is the only incident response available for a suspected KEK
disclosure. Rehearse it before it is needed.]`
5. **Tell the users whose third-party credentials may be affected, and tell them
   to revoke at the provider**, not just at Pull.fm. Disconnecting here deletes
   our copy; it does not invalidate the credential.
6. **Notify.** See section 5.

### What does not help

- Rotating the WorkOS key does not protect a leaked ListenBrainz token.
- Deleting the ciphertext does not help if the KEK leaked and a backup exists.
- "It was only ciphertext" is only true while the KEK is not also in scope.

---

## 5. Notification obligations, with the deadlines

| Who                                | When                                                                                      | Why                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SeatGeek**                       | **Within 24 hours of a suspected Security Incident**                                      | **Contractual.** SeatGeek API terms clause 5.3. This is the tightest deadline we are under and it is easy to miss because it is not a regulator. |
| **Supervisory authority (GDPR)**   | Within 72 hours of becoming aware, where the breach is likely to risk rights and freedoms | Art. 33                                                                                                                                          |
| **Affected users**                 | Without undue delay, where the risk is high                                               | Art. 34                                                                                                                                          |
| **State attorneys general / CCPA** | Per state law                                                                             | Varies                                                                                                                                           |
| **Cloudflare, Hetzner, WorkOS**    | As their terms require                                                                    | Processor contracts                                                                                                                              |

**The SeatGeek clock is 24 hours and it starts at "suspected", not "confirmed".**
It applies while we hold their API credentials, whether or not the events route
is enabled, because clause 8.1 makes those credentials Confidential Information
and 5.3 attaches to a suspected incident rather than a proven one. Contact path
is their developer support; obtain and record the current address the same way
the terms were obtained, since their portal 403s automated fetches.

**Do not wait for certainty to start drafting.** A 24-hour deadline consumed by
investigation leaves no time to write.

---

## 6. The Gate 5 alert list

**Every row below is `SPEC` and none is configured.** The columns are the ones
Gate 5 requires: the condition, how to fire it synthetically so the alert can be
proven rather than assumed, and where it points.

### Availability and correctness

| #   | Condition                                                                              | Synthetic trigger                                  | Links to                                                | Status |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- | ------ |
| A1  | External health check: `https://api.pull.fm/healthz` non-200 twice in a row, 60s apart | Set `MAINTENANCE_MODE=true`, or stop the container | [Section 3](#3-first-fifteen-minutes-for-any-incident)  | SPEC   |
| A2  | `/readyz` reports any dependency `fail` for 2 minutes                                  | Stop the Redis container                           | [Section 7](#7-degraded-modes-what-each-one-looks-like) | SPEC   |
| A3  | Edge 5xx rate over 1% for 5 minutes (Cloudflare analytics)                             | Point the LB at a dead backend                     | [Section 3](#3-first-fifteen-minutes-for-any-incident)  | SPEC   |
| A4  | Origin unreachable from the edge (521/522/525)                                         | Stop nginx on the origin                           | [`RUNBOOK-DR.md`](RUNBOOK-DR.md)                        | SPEC   |
| A5  | Deploy timer failed 3 consecutive runs                                                 | Push an image whose migration fails                | [`RUNBOOK-DEPLOY.md`](RUNBOOK-DEPLOY.md) section 5      | SPEC   |
| A6  | p95 latency over 800ms for 10 minutes                                                  | k6 against the mock at 2x the modelled load        | [Section 7](#7-degraded-modes-what-each-one-looks-like) | SPEC   |

### Data and durability

| #   | Condition                                        | Synthetic trigger                                   | Links to                                                | Status                                    |
| --- | ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| D1  | No successful pgBackRest full backup in 26 hours | Stop the backup timer for a day, or move the stanza | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 4              | SPEC (**and pgBackRest is not deployed**) |
| D2  | WAL archive lag over 5 minutes (the Gate 4 RPO)  | Break `archive_command`                             | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 4              | SPEC (**same**)                           |
| D3  | Monthly restore drill did not run, or failed     | Skip the scheduled drill                            | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 5              | SPEC                                      |
| D4  | Postgres disk over 80%                           | `fallocate` a large file on the data volume         | [Section 7](#7-degraded-modes-what-each-one-looks-like) | SPEC                                      |
| D5  | Replication lag over 60s (once a replica exists) | Pause the replica                                   | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 6              | SPEC                                      |

### Security

| #   | Condition                                                                                            | Synthetic trigger                                | Links to                                                | Status                                        |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------- |
| S1  | Any `audit_log` row with `outcome = 'denied'` on a credential-affecting action, over 5 in 10 minutes | Replay a forged WorkOS webhook signature 6 times | [Section 4](#4-sev-1-suspected-credential-exposure)     | SPEC                                          |
| S2  | Rejected webhook signature, any occurrence                                                           | Send an unsigned `POST /v1/webhooks/workos`      | [Section 4](#4-sev-1-suspected-credential-exposure)     | SPEC                                          |
| S3  | Quota Redis unreachable (the limiter fails **closed** to 503, so this is visible as a 503 spike)     | Stop the quota Redis instance                    | [Section 7](#7-degraded-modes-what-each-one-looks-like) | SPEC                                          |
| S4  | 401 rate on token auth over 20/min from one source                                                   | Loop a curl with a bad `pfm_live_` token         | [Section 8](#8-abuse-and-quota-arson)                   | SPEC                                          |
| S5  | Nightly ZAP active scan finds a high or critical                                                     | Introduce a known-vulnerable route on a branch   | [`../security/README.md`](../security/README.md)        | SPEC                                          |
| S6  | An accepted risk in the register has expired                                                         | Backdate an `expires_on`                         | `make risks`                                            | **Implemented as a CI failure, not an alert** |

### Upstream licence protection (the ones that end the product)

| #   | Condition                                                           | Synthetic trigger                                     | Links to                                                | Status |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ------ |
| U1  | MusicBrainz egress over 1.0 req/s averaged over 60s                 | `MOCK_SYNC_RESOLVE=1` against the mock upstream layer | [Section 8](#8-abuse-and-quota-arson)                   | SPEC   |
| U2  | iTunes calls over 20/min                                            | Same harness                                          | [Section 8](#8-abuse-and-quota-arson)                   | SPEC   |
| U3  | **Last.fm cached data over 80 MB** (the licence cap is 100 MB)      | Insert rows until `cache_size_by_provider` crosses it | [Section 9](#9-the-lastfm-100-mb-cap)                   | SPEC   |
| U4  | Any upstream circuit breaker open for over 15 minutes               | Force the mock to 500                                 | [Section 7](#7-degraded-modes-what-each-one-looks-like) | SPEC   |
| U5  | Any 403 or explicit revocation response from Last.fm or MusicBrainz | Mock returns 403                                      | **Treat as SEV-3 immediately**                          | SPEC   |

### Scheduled jobs (the ones that make the retention windows true)

These four are different from every other row here in one respect worth stating:
the **detection** side is built and committed, and only the delivery side is
missing. Each job unit carries `SuccessExitStatus=2` and
`OnFailure=pullfm-job-alert@%n.service`, so an exit 1 (could not run, changed
nothing) already becomes a failed unit, an error-priority journal record and a
line in `/var/log/pullfm/job-alerts.jsonl`. What does not exist is a channel:
`/etc/pullfm/alert.env` is not created by anything and `PULLFM_NTFY_URL` is
unset, so **nobody is told**. Full detail in [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md)
section 4.

They also cannot fire at all yet, for the same reason as D1 and D2: nothing is
deployed.

| #   | Condition                                                                      | Synthetic trigger                                              | Links to                             | Status                                                      |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| J1  | `purge:audit` exits 1, so `audit_log` keeps identifiers past the 90-day window | Point `DATABASE_URL` at an unreachable host and start the unit | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | Handler committed, **no channel, and no compute** to run it |
| J2  | `sweep:expired` exits 1, so `idempotency_keys` keeps copied API responses      | As above                                                       | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | Handler committed, **no channel, and no compute**           |
| J3  | `reap:unverified` exits 1, so unconsented WorkOS records accumulate            | Revoke the WorkOS API key and start the unit                   | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | Handler committed, **no channel, and no compute**           |
| J4  | `warm:cache` exits 1 on every run, so the cache decays and shelf items vanish  | Break the candidate query and start the unit                   | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | Handler committed, **no channel, and no compute**           |

**J1 to J3 are the ones that matter legally**, because until they run the
windows in `legal/privacy-policy.md` are windows the system applies per run
rather than per day. J4 is a product-quality alert, not a compliance one.

### Cost

| #   | Condition                                    | Synthetic trigger                                                            | Links to                             | Status                                                   |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| C1  | Cloudflare account spend over $10 / over $25 | Cloudflare's own alert; verify by lowering the threshold below current spend | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | **ARMED, machine-verified by `make cost`**               |
| C2  | R2 storage charges over $5                   | As above with `r2_storage`                                                   | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | **ARMED**                                                |
| C3  | Hetzner spend cap                            | none available                                                               | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | **VENDOR LIMITATION** - no API, console option not found |
| C4  | Staging left running over 12 hours           | `./infra/staging-env.sh up` and wait                                         | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | SPEC - this is the alert that would substitute for C3    |

**C4 is the one worth building first.** It is the alert that compensates for the
control Hetzner does not sell, it is entirely within our power to build, and the
data it needs is already what `make cost` computes.

### What closes Gate 5

For each row above, a timestamped log showing: the trigger, the ntfy delivery,
and the elapsed time under 60 seconds. Plus a check that every runbook anchor in
the "Links to" column resolves. **Sixteen of these cannot be demonstrated until
the systems they watch exist** (pgBackRest, a replica, a metrics registry, and
for J1 to J4 any deployed compute at all), which is a real ordering constraint
and not an excuse: Gate 5 cannot close before Gate 4 and Phase 4.

**The cheapest remaining step is a channel, not a detector.** J1 to J4 already
detect and classify; they write to a file. One root-owned `alert.env` with an
ntfy URL in it turns four committed detectors into four delivered alerts, and
the same file is what every other row will use.

---

## 7. Degraded modes: what each one looks like

Degradation is a designed state, so it should be recognisable rather than
alarming.

| Failure                    | Designed behaviour                                                                    | How you can tell                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| One upstream down          | Circuit breaker opens, that section is omitted                                        | `degraded: true` and the provider named in `unavailableProviders`                                                 |
| Cache Redis down           | Cache misses, higher latency, correct answers                                         | `/readyz` reports `redis: fail`; latency up, no errors                                                            |
| **Quota Redis down**       | **Rate limiting fails closed: 503, not unlimited**                                    | A 503 spike with no other symptom. This is deliberate: failing open would silently remove every abuse protection. |
| Database read-only or slow | Read-only degraded mode: reads served, mutations refused                              | Mutating routes error, reads fine                                                                                 |
| Database down              | `/readyz` 503, LB removes the target                                                  | `checks.database = "fail"`                                                                                        |
| Origin unreachable         | Cloudflare maintenance worker serves an honest page                                   | Users see a maintenance page, not a timeout                                                                       |
| Deploy failing             | **Old container keeps serving.** A migration failure stops the deploy before the swap | Version at `/healthz` stops advancing                                                                             |

The last row is worth stating positively: a build whose migration fails is a
build that must not run, and the deploy agent enforces that ordering by running
migrations with the **new** image before swapping the container.

---

## 8. Abuse and quota arson

The cheapest catastrophic attack on Pull.fm is not stealing anything. It is
**spending our upstream quota**: no credential is compromised, no data leaks, and
the product is dead because MusicBrainz revoked us.

Signals: U1, U2, S4 above; a spike in `/v1/search` or preview resolution; one
account or one IP dominating the request mix.

Response, in order of reversibility:

1. Confirm the shape from logs (client IP and user agent are retained precisely
   for this).
2. Reduce the offending token's `rate_limit_per_minute`, or revoke the token.
3. Cloudflare rate limiting or a block on the source, at the edge.
4. The per-provider **runtime kill switch**: stop calling that upstream entirely
   and serve from cache. The cache-first architecture is what makes this
   survivable, and it is a security control as much as a performance one.
5. If the source is one account, suspend it. Signup is free and instant, so
   expect rotation and prefer the per-account budget over the per-IP one.

**Scraping this API cannot itself produce an upstream burst**, because no request
path calls a third party synchronously. It produces queued jobs, which are
rate-shaped by construction. That is the design property to verify still holds
before assuming an upstream spike came from user traffic.

---

## 9. The Last.fm 100 MB cap

Last.fm ToS 4.3.4 caps cached Last.fm data at **100 MB** without written consent.
Exceeding it is a licence breach, not a disk problem.

```sql
SELECT * FROM cache_size_by_provider WHERE provider = 'lastfm';
```

The view exists so the cap can be **enforced rather than estimated**;
`pg_column_size` includes TOAST overhead, so it reports an upper bound, which is
the safe direction to err. Alert at 80 MB (U3). Remediation is LRU eviction of
Last.fm rows, not a bigger disk.

---

## 10. After an incident

1. **Write it down the same day**, while you still remember the order things
   happened in. There is no colleague to reconstruct it with later.
2. **Ask what would have caught it.** If the answer is an alert, add it to
   section 6 with its synthetic trigger, so it is testable rather than aspirational.
3. **If a control looked configured but was absent**, that is the most valuable
   finding available and it belongs in `SCORECARD.md`. It has happened twice
   already: Semgrep rules that were never in the repository, and a
   `delete_protection` setting documented in the plan a day before anything
   passed it.
4. **If it was accepted risk**, revisit the register entry rather than only
   fixing the instance. A risk that materialised is evidence the severity was
   underestimated.
5. **If an upstream was involved**, re-read that provider's terms. They can
   change at any time and continued use is acceptance.
