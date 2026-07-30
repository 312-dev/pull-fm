# Runbook: incidents (Gate 5)

> **Gate 5 criterion:** each of a **named list** of alert conditions fires to
> ntfy within 60 seconds when triggered synthetically, evidenced by a timestamped
> log; every alert has a runbook URL returning 200.
>
> **Status: A CHANNEL EXISTS AND DELIVERS. Gate 5 is not closed.**
>
> Until 2026-07-29 there was no notification channel anywhere in this project,
> and the accurate summary was "when something fails it is written to a log on a
> node and nobody is told". That is no longer true. `infra/observability/`
> contains one sender, one watchdog, a heartbeat emitter, and an
> `/etc/pullfm/alert.env` written from 1Password at converge time, and the path has
> been fired end to end and read back.
>
> **The PRIMARY path is no longer ntfy, and no longer a push at all.** Since
> `SD-003` the node publishes a content-free heartbeat, a scheduled workflow in
> `312-dev/pullfm-heartbeat` reads it from outside every machine we own, and a
> GitHub issue plus a red run notify the operator. **The node holds no alerting
> credential.** The push sink below is optional, provider-agnostic and **unset
> today**; where this document says "ntfy" about the delivery mechanism, read "the
> push sink, when one is configured". The ntfy-specific verifications are still
> valid evidence that the sender works, because they were run against a real ntfy.
>
> **A measured correction to the latency claims in this file:** the watcher's cron
> is best-effort and was observed running 3 times in 4.5 hours on 2026-07-30, so
> real detection latency for anything that depends on the pull path is **tens of
> minutes to hours, not 60 seconds**. See `PULLFM-RISK-020`. The 60-second Gate 5
> budget describes the push sink, which is the path that is currently unset.
>
> Of the thirty rows in section 6:
>
> | State                                                                        | Count |
> | ---------------------------------------------------------------------------- | ----- |
> | **ARMED AND PROVEN** - synthetic trigger fired, message read back off ntfy   | 5     |
> | **ARMED, delivery proven, trigger blocked on deployed compute** (J1 to J4)   | 4     |
> | **ARMED, NOT PROVEN** - detector written, no way to trigger it from a laptop | 3     |
> | **ARMED at the vendor**, machine-verified by `make cost` (C1, C2)            | 2     |
> | **NOT ARMED**, each with the reason stated in its row                        | 16    |
>
> Against the twenty-two rows that were `SPEC` before this work: **eight are now
> armed** and five of those are proven. Fourteen are not, and the reasons are
> real ordering constraints rather than remaining effort: nine need infrastructure
> that does not exist, three need an external checker, and two describe a
> pgBackRest deployment that Neon replaced.
>
> **Two distinctions are kept deliberately here and must not be collapsed.**
> "Configured" is not "proven": a channel nobody has fired is the same class of
> defect as a backup nobody has restored, and this project has been bitten by
> exactly that pattern twice (section 10). And "delivered to the ntfy server" is
> not "a human read it": the operator must still be subscribed to whichever sink
> is configured, which is the one step nothing in this repository can perform or
> verify. On the primary path this is weaker than it used to be, because a GitHub
> issue assigned to the operator notifies through two independent reasons plus a
> red workflow run, none of which needs a subscription to be set up by hand.
>
> ```bash
> sudo ./infra/observability/install-alert-env.sh --check   # FOUR network questions
> make alerts                                              # prove it end to end
> gh run list -R 312-dev/pullfm-heartbeat --event schedule  # look at the GAPS
> pullfm-alert --list                                      # what is outstanding
> ```

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

**Notifications still exist.** They reach the operator as a GitHub issue raised by
an observer outside all of our infrastructure, and additionally as an immediate
push if a sink is configured. Their purpose is to tell the operator what already
happened and what already degraded, not to summon a response inside a time budget
nobody can keep.

**Clearing one is a verb, not a `rm`.** `pullfm-alert --list` shows what is
outstanding and how old it is; `--ack <key>` records that a human saw it;
`--resolve --key <key>` says it is fixed. Deleting a spool file under
`/var/lib/pullfm/alerts/` also works and leaves no record that an alert was
cleared, which is why it is not the documented gesture. See `SD-004`.

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
#
# PREFER THE FILE during an incident. It takes effect in about a second, needs
# no restart, and therefore does not destroy the process state that step 2 of
# the SEV-1 procedure below tells you to preserve.
touch /etc/pullfm/maintenance
rm    /etc/pullfm/maintenance     # and back, same latency

# The env variable is the right lever for PLANNED downtime and vacation mode,
# because it survives a restart and the file does not.
MAINTENANCE_MODE=true    # in /etc/pullfm/bff.env, then restart the container

# Either way: application routes return 503 with Retry-After: 300, while
# /healthz, /readyz and /metrics keep answering - the first two so the
# orchestrator can tell intentional downtime from a crash, the third so the
# service is still observable while it is refusing traffic.
curl -s localhost:8080/metrics | grep pullfm_maintenance_mode   # 1 while down
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
   our copy; it does not invalidate the credential. A direct message to an
   affected person is not a public communication, so nothing in section 5a gates
   it - but read section 5a before publishing anything broadcast.
6. **Notify.** See section 5, and **start the SeatGeek clock in section 5a at the
   moment of first suspicion**, which is before this step in wall-clock time even
   though it appears after it in this list. Twenty-four hours is short enough that
   it has to be started, not remembered.

### What does not help

- Rotating the WorkOS key does not protect a leaked ListenBrainz token.
- Deleting the ciphertext does not help if the KEK leaked and a backup exists.
- "It was only ciphertext" is only true while the KEK is not also in scope.

---

## 5. Notification obligations, with the deadlines

| Who                                | When                                                                                                                                                              | Why                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SeatGeek**                       | **As soon as possible, and no later than 24 hours after a SUSPECTED Security Incident.** They must also be **consulted before any public communication** about it | **Contractual.** SeatGeek API terms clause 5.3. This is the tightest deadline we are under and it is easy to miss because it is not a regulator. Worked as numbered steps with a clock in [section 5a](#5a-the-seatgeek-24-hour-clock-as-steps-with-times-on-them) |
| **Supervisory authority (GDPR)**   | Within 72 hours of becoming aware, where the breach is likely to risk rights and freedoms                                                                         | Art. 33                                                                                                                                                                                                                                                            |
| **Affected users**                 | Without undue delay, where the risk is high                                                                                                                       | Art. 34                                                                                                                                                                                                                                                            |
| **State attorneys general / CCPA** | Per state law                                                                                                                                                     | Varies                                                                                                                                                                                                                                                             |
| **Cloudflare, Hetzner, WorkOS**    | As their terms require                                                                                                                                            | Processor contracts                                                                                                                                                                                                                                                |

**The SeatGeek clock is 24 hours and it starts at "suspected", not "confirmed".**
It applies while we hold their API credentials, whether or not the events route
is enabled, because **section 5 of their terms (Security and Confidentiality)**
makes those credentials Confidential Information and **5.3** attaches to a
suspected incident rather than a proven one. Contact path is their developer
support; obtain and record the current address the same way the terms were
obtained, since their portal 403s automated fetches.

**Do not wait for certainty to start drafting.** A 24-hour deadline consumed by
investigation leaves no time to write.

---

## 5a. The SeatGeek 24-hour clock, as steps with times on them

> **WHY THIS IS A PROCEDURE AND NOT THE PARAGRAPH ABOVE.** Until 2026-07-29 this
> obligation existed in this runbook as one table row and one paragraph of prose.
> Prose is what an operator reads calmly, in advance; a deadline is what they miss
> at 2am. Every other deadline in this document (the 15 minutes in section 3, the
> ordering in section 4) is a numbered step, and this is the tightest deadline we
> are under. It is also the only one enforced by a counterparty who can terminate
> our access rather than by a regulator who will send a letter.
>
> **Two things about the clause were also wrong or missing** and both are fixed
> here. The obligation was cited to "clause 8.1" for confidentiality; section 8 of
> SeatGeek's terms is Disclaimers and Limitation of Liability, and confidentiality
> is section 5. And **5.3 requires them to be consulted before any public
> communication about the incident**, which had never been recorded anywhere in
> this repository at all. That duty conflicts with the instinct in section 4 step
> 5, so the conflict is resolved below rather than discovered live.

**Verbatim obligation (5.3, as relayed by the operator):** notify SeatGeek of a
Security Incident "as soon as possible, and in no event later than 24 hours
thereafter", and consult them before any public communication about it.

**T+0 is the moment you first SUSPECT.** Not the moment you confirm, not the
moment you finish triage. Write that timestamp down before doing anything else -
it is the only number in this procedure you cannot reconstruct later.

> **RECIPIENT, RESOLVED 2026-07-29. SEND TO BOTH, AND THE REASON IS THAT THEY ARE
> TWO DIFFERENT CHANNELS FOR TWO DIFFERENT PURPOSES.**
>
> | To                                               | Why                                                                                                                                                                                                                                                                                                                                                    |
> | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | `legal@seatgeek.com`, Attention: General Counsel | **This is the contractual notice channel.** Their clause 12.4 (Notices) requires notices to SeatGeek to be addressed to SeatGeek, Inc., 902 Broadway, Floor 10, New York, NY 10010, Attention: Legal Team, "with email copies to legal@seatgeek.com, Attention: General Counsel". A notification sent anywhere else is not a notice under their terms. |
> | `tech-architecture@seatgeek.com`                 | **This is the operational contact**, given under their Contact Us clause for questions about the APIs. It is the address a human is likely to read quickly, which is what a 24 hour clock needs.                                                                                                                                                       |
>
> **WHY NOT tech-architecture ALONE, which was the operator's first instinct.**
> It is the address published for API questions, so it is the obvious guess and it
> is the fast one, but 12.4 is explicit about where a _notice_ goes. Discharging a
> contractual notification duty through a support mailbox invites the argument that
> the notice was never given. Sending both costs one extra line in the To field and
> removes the argument entirely.
>
> Their 12.4 also says notices to us "will be effective... on the day sent (if by
> email)", so send early and correct later rather than waiting to be certain. Step
> 3 below is written for the 24 hour deadline; the postal copy is belt and braces
> and can follow.
>
> **This duty is already owed and does not wait for the events route.** We hold
> their API credentials today, those credentials are Confidential Information under
> section 5 of their terms, and 5.3 attaches to a _suspected_ incident whether or
> not `SEATGEEK_ENABLED` is set.

| Step | Deadline  | Action                                                                                                                                                                                                                                                                                       |
| ---- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **T+0**   | Record the UTC timestamp of first suspicion in the incident note, and compute T+24 explicitly as a clock time. `date -u -d '+24 hours'` on the node, or `date -u -v+24H` on macOS. A deadline expressed as "tomorrow" is how this gets missed.                                               |
| 2    | **T+0**   | Decide whether SeatGeek credentials or SeatGeek-derived data are in scope **at all**. If neither is, 5.3 does not attach and the rest of this section is not owed. Record the reasoning either way; "we decided it was out of scope" with no note is indistinguishable from never deciding.  |
| 3    | **T+1h**  | Send the first notification. It does **not** need scope, cause, or remediation - it needs to exist. "We are investigating a suspected security incident that may involve credentials or data associated with the SeatGeek API. We will follow up within 24 hours." That discharges the duty. |
| 4    | **T+1h**  | **Before** any public statement, status page update, GitHub advisory, release note, or user email, contact SeatGeek and say what you intend to publish. 5.3 requires consultation, not merely notice. See the conflict note below.                                                           |
| 5    | **T+24h** | Hard deadline for a substantive notification: what happened, what data or credentials were involved, what has been done. If the investigation is unfinished, send what is known and say it is unfinished. **Late and complete is a breach; on-time and partial is not.**                     |
| 6    | **T+24h** | Rotate the SeatGeek credential if it was in scope, and record the rotation in the incident note. It is a Confidential Information obligation under their section 5, independent of the events route being disabled.                                                                          |
| 7    | **T+7d**  | Write the follow-up. Also re-read their terms: section 1 lets them change at any time with continued use as acceptance, and an incident is exactly when a changed obligation would matter.                                                                                                   |
| 8    | **T+6mo** | **The outer limit on any claim of ours against them.** Their clause 12.2 requires any cause of action we bring to be filed within six months, under New York law with exclusive venue in New York County. If the incident originated on their side, this is the date to diary.               |

**The conflict in step 4, stated so it is decided in advance rather than at
2am.** GDPR Article 34 and the instinct in [section 4](#4-sev-1-suspected-credential-exposure)
step 5 both say to tell affected users without undue delay. SeatGeek's 5.3 says
to consult them before public communication. These pull in opposite directions
and the resolution is:

- **A direct, private notification to an affected user is not a public
  communication.** Send it. Telling one person their Last.fm session key may be
  exposed is not an announcement, and no vendor clause can gate a user's
  safety notification.
- **Anything broadcast is.** A status page, a release note, a GitHub security
  advisory, a post, a mass email. Consult first, and if the consultation is not
  answered inside the window that user safety allows, publish anyway and record
  the attempt with its timestamp. A documented unanswered consultation is a
  defensible position; silence toward users is not.
- **If those two ever genuinely collide, user safety wins and the note says so.**
  The maximum exposure on the SeatGeek side of that trade is a contract dispute
  in which their own liability to us is capped at fifty dollars.

---

## 6. The Gate 5 alert list

The columns are the ones Gate 5 requires: the condition, how to fire it
synthetically so the alert can be proven rather than assumed, and where it
points. **Read the status column literally.** The four values it uses:

| Status                | Means                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **ARMED AND PROVEN**  | A detector exists AND the synthetic trigger was fired AND the resulting notification was read back off a real ntfy server. |
| **ARMED, NOT PROVEN** | A detector exists and would deliver. Nothing has fired it, because the trigger needs something that does not exist yet.    |
| **NOT ARMED**         | Nothing detects this. The reason is in the row.                                                                            |
| **N/A**               | The condition is handled somewhere other than an alert, or has been made obsolete.                                         |

The proofs are generated, not asserted:
`infra/observability/watchdog-selftest.sh` mutates one line of a **real captured
scrape**, runs the real watchdog, and polls ntfy until the message appears,
timing it. It also runs negative controls, because an alerter that fires on a
healthy system trains the operator to ignore it.

### Availability and correctness

| #   | Condition                                                                              | Synthetic trigger                                    | Links to                                                | Status                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | External health check: `https://api.pull.fm/healthz` non-200 twice in a row, 60s apart | Set `MAINTENANCE_MODE=true`, or stop the container   | [Section 3](#3-first-fifteen-minutes-for-any-incident)  | **NOT ARMED.** Needs a checker OUTSIDE our infrastructure. The watchdog runs on the node, and a watchdog on a dead node does not alert. Its local `/healthz` check is a backstop for a crashed container, not this row.                                 |
| A2  | `/readyz` reports any dependency `fail` for 2 minutes                                  | Set `pullfm_dependency_up` to 0 and run the watchdog | [Section 7](#7-degraded-modes-what-each-one-looks-like) | **ARMED AND PROVEN.** Delivered in under 1s.                                                                                                                                                                                                            |
| A3  | Edge 5xx rate over 1% for 5 minutes (Cloudflare analytics)                             | Point the LB at a dead backend                       | [Section 3](#3-first-fifteen-minutes-for-any-incident)  | **NOT ARMED.** Lives at the edge; needs a Cloudflare notification or a Logpush consumer, neither configured.                                                                                                                                            |
| A4  | Origin unreachable from the edge (521/522/525)                                         | Stop nginx on the origin                             | [`RUNBOOK-DR.md`](RUNBOOK-DR.md)                        | **NOT ARMED.** Same blind spot as A1: only visible from outside.                                                                                                                                                                                        |
| A5  | Deploy timer failed 3 consecutive runs                                                 | Push an image whose migration fails                  | [`RUNBOOK-DEPLOY.md`](RUNBOOK-DEPLOY.md) section 5      | **ARMED, NOT PROVEN.** The watchdog alerts on ANY failed `pullfm-*` unit, which covers this. It needs systemd, so it cannot be triggered from a laptop, and it alerts on the first failure rather than the third.                                       |
| A6  | p95 latency over 800ms for 10 minutes                                                  | k6 against the mock at 2x the modelled load          | [Section 7](#7-degraded-modes-what-each-one-looks-like) | **NOT ARMED.** The evidence now exists (`pullfm_http_request_duration_seconds`, with an `le="0.8"` bucket chosen for this row) but nothing computes a quantile. A quantile over two scrapes in shell would be a wrong number rather than a missing one. |

### Data and durability

| #   | Condition                                        | Synthetic trigger                                   | Links to                                                | Status                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | No successful pgBackRest full backup in 26 hours | Stop the backup timer for a day, or move the stanza | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 4              | **N/A as written.** There is no pgBackRest: the database is Neon and PITR is Neon's (`PLAN.md` phase 1). The condition worth watching is now "Neon PITR window shorter than the promise", which is a different alert and belongs to whoever owns DR. |
| D2  | WAL archive lag over 5 minutes (the Gate 4 RPO)  | Break `archive_command`                             | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 4              | **N/A as written.** Same reason. There is no `archive_command` we own.                                                                                                                                                                               |
| D3  | Monthly restore drill did not run, or failed     | Skip the scheduled drill                            | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 5              | **NOT ARMED.** There is no scheduled drill to miss yet.                                                                                                                                                                                              |
| D4  | Postgres disk over 80%                           | `fallocate` a large file on the data volume         | [Section 7](#7-degraded-modes-what-each-one-looks-like) | **N/A.** We do not own the data volume; Neon manages storage. The node's own disk is a different and unwatched condition.                                                                                                                            |
| D5  | Replication lag over 60s (once a replica exists) | Pause the replica                                   | [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 6              | **NOT ARMED.** No replica exists; deferred deliberately (`PLAN.md` section 9).                                                                                                                                                                       |

### Security

| #   | Condition                                                                                                         | Synthetic trigger                                                  | Links to                                                | Status                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `audit_log` rows with `outcome = 'denied'` on a credential-affecting action, above the configured burst threshold | Replay a forged identity-provider webhook signature until it trips | [Section 4](#4-sev-1-suspected-credential-exposure)     | **NOT ARMED.** Needs a database query on a cadence. The watchdog reads `/metrics` and holds no database credential, deliberately; wiring one into a host script would widen its blast radius.      |
| S2  | Rejected webhook signature, any occurrence                                                                        | Send an unsigned `POST /v1/webhooks/workos`                        | [Section 4](#4-sev-1-suspected-credential-exposure)     | **NOT ARMED.** The cheapest remaining row: a counter in the webhook route would make it a watchdog check. Not done because it is a code change to a route this phase does not own.                 |
| S3  | Quota Redis unreachable (the limiter fails **closed** to 503)                                                     | Increment `pullfm_fail_closed_total` and run the watchdog          | [Section 7](#7-degraded-modes-what-each-one-looks-like) | **ARMED AND PROVEN.** Delivered in under 1s. Previously invisible from inside the service: the refusal was a bare `catch` that logged nothing and counted nothing.                                 |
| S4  | 401 rate on token auth from a single source, above the configured threshold                                       | Loop a curl with a bad personal API token                          | [Section 8](#8-abuse-and-quota-arson)                   | **NOT ARMED.** `pullfm_http_requests_total{status="401"}` exists, but "from one source" needs a per-source dimension, and client IP as a metric label is unbounded cardinality. Edge-side control. |
| S5  | Nightly ZAP active scan finds a high or critical                                                                  | Introduce a known-vulnerable route on a branch                     | [`../security/README.md`](../security/README.md)        | **NOT ARMED.** Belongs to CI rather than the node, like S6.                                                                                                                                        |
| S6  | An accepted risk in the register has expired                                                                      | Backdate an `expires_on`                                           | `make risks`                                            | **N/A. Implemented as a CI failure, not an alert**, which is stricter: it blocks a merge rather than notifying after one.                                                                          |

### Upstream licence protection (the ones that end the product)

| #   | Condition                                                           | Synthetic trigger                                                        | Links to                                                | Status                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | MusicBrainz egress over 1.0 req/s averaged over 60s                 | Advance `pullfm_musicbrainz_pacer_dispatched_total` and run the watchdog | [Section 8](#8-abuse-and-quota-arson)                   | **ARMED AND PROVEN.** Delivered in under 1s, with a negative control proving paced traffic stays silent.                                                                                            |
| U2  | iTunes calls over 20/min                                            | Advance `pullfm_upstream_requests_total{provider="itunes"}`              | [Section 8](#8-abuse-and-quota-arson)                   | **ARMED, NOT PROVEN.** The check is written and its arithmetic is shared with U1, which is proven. The counter is created on first use, so a scrape with no iTunes traffic has no series to mutate. |
| U3  | **Last.fm cached data over 80 MB** (the licence cap is 100 MB)      | Set `pullfm_cache_bytes{provider="lastfm"}` above the threshold          | [Section 9](#9-the-lastfm-100-mb-cap)                   | **ARMED AND PROVEN.** Delivered in under 1s. The gauge is sampled at most every 5 minutes because it is a database aggregate.                                                                       |
| U4  | Any upstream circuit breaker open for over 15 minutes               | Set the provider status to degraded and its age past 900s                | [Section 7](#7-degraded-modes-what-each-one-looks-like) | **ARMED AND PROVEN.** Delivered in under 1s, with a negative control proving a brief blip stays silent. Uses the coarse `degraded` status, which does not separate `open` from `half_open`.         |
| U5  | Any 403 or explicit revocation response from Last.fm or MusicBrainz | Mock returns 403                                                         | **Treat as SEV-3 immediately**                          | **NOT ARMED.** `pullfm_upstream_failures_total` carries the error kind, but a 403 is not distinguished from any other HTTP failure in it. Needs a status-code label to become alertable.            |

### Scheduled jobs (the ones that make the retention windows true)

**This is the row that changed most, so it is worth being precise about which
half moved.** The detection side was already committed: each unit carries
`SuccessExitStatus=2` and `OnFailure=pullfm-job-alert@%n.service`, so an exit 1
becomes a failed unit, an error-priority journal record, and a line in
`/var/log/pullfm/job-alerts.jsonl`. What was missing was the channel.

**The channel now exists, and the committed handler was tested against it.**
`infra/staging/app/pullfm-job-alert` was run against a live ntfy endpoint with an
`alert.env` in place and the notification was read back off the topic. So the
delivery leg is proven and unchanged code will use it.

Two things are still not proven, and neither is a channel problem:

1. **No compute exists**, so no timer has ever fired and no real exit 1 has ever
   been classified. The handler reads `Result=` and `ExecMainStatus=` off
   systemd, which cannot be exercised on a developer laptop; when run there it
   correctly classifies the failure as `unexpected` because there is no unit to
   ask about.
2. `/etc/pullfm/alert.env` must be written to each node.
   `infra/observability/install-alert-env.sh` does it in one command, and
   `make alerts-armed` answers whether it happened.

The watchdog carries a **backstop** for these four, which is proven: it reads
the spool and alerts when a job failure was recorded with `delivered:false`. That
covers the case where the job failed AND the channel was down at that moment,
which would otherwise be a failure nobody ever hears about.

| #   | Condition                                                                      | Synthetic trigger                                              | Links to                             | Status                                                                                                                                   |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | `purge:audit` exits 1, so `audit_log` keeps identifiers past the 90-day window | Point `DATABASE_URL` at an unreachable host and start the unit | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | **ARMED.** Handler + channel proven together. Trigger blocked on compute.                                                                |
| J2  | `sweep:expired` exits 1, so `idempotency_keys` keeps copied API responses      | As above                                                       | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | **ARMED.** Same. This unit is the one the delivery test was run against.                                                                 |
| J3  | `reap:unverified` exits 1, so unconsented WorkOS records accumulate            | Revoke the WorkOS API key and start the unit                   | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | **ARMED.** Same.                                                                                                                         |
| J4  | `warm:cache` exits 1 on every run, so the cache decays and shelf items vanish  | Break the candidate query and start the unit                   | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | **ARMED.** Same. Also partly covered by U1 and by the pacer queue-overflow check.                                                        |
| Jb  | A job failure was recorded and its own alert did NOT deliver                   | Append a `"delivered":false` line to the spool                 | [`RUNBOOK-JOBS.md`](RUNBOOK-JOBS.md) | **ARMED AND PROVEN.** Not one of the original rows; added because a channel outage during a job failure is otherwise permanently silent. |

**J1 to J3 are the ones that matter legally**, because until they run the
windows in `legal/privacy-policy.md` are windows the system applies per run
rather than per day. J4 is a product-quality alert, not a compliance one.

### Cost

| #   | Condition                                    | Synthetic trigger                                                            | Links to                             | Status                                                                                                                                                   |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Cloudflare account spend over $10 / over $25 | Cloudflare's own alert; verify by lowering the threshold below current spend | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | **ARMED at the vendor, machine-verified by `make cost`**                                                                                                 |
| C2  | R2 storage charges over $5                   | As above with `r2_storage`                                                   | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | **ARMED at the vendor**                                                                                                                                  |
| C3  | Hetzner spend cap                            | none available                                                               | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | **N/A - VENDOR LIMITATION.** No API, console option not found. C4 is the compensating control.                                                           |
| C4  | Staging left running over 12 hours           | `./infra/staging-env.sh up` and wait                                         | [`RUNBOOK-COST.md`](RUNBOOK-COST.md) | **ARMED, NOT PROVEN.** The watchdog reads the node's own uptime, which in staging IS the billing window. Not provable on macOS: it needs `/proc/uptime`. |

### Other conditions the watchdog now covers

Not part of the original list, so not counted against it, but they exist and are
proven, and two of them are the reason a silent failure stays silent:

| Condition                                   | Why it is worth a notification                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/metrics` unreachable while up             | Every metric-derived alert on the node is now silent and will stay silent. Without this the operator sees nothing and reads it as nothing being wrong. |
| Database pool saturated for 3 samples       | Gate 7 asserts no pool exhaustion. It presents to a user as latency with no error anywhere, so it has no other symptom.                                |
| Warm cache hit ratio below the Gate 2 floor | Every miss is a remote MusicBrainz call, so it is an upstream budget problem before it is a latency one.                                               |
| MusicBrainz pacer queue overflow            | The rate limit was NOT exceeded, which is the pacer working. But the warm path is dropping candidates, so the cache decays quietly.                    |
| Any failed `pullfm-*` systemd unit          | Covers A5 and anything else not modelled above. A unit stays failed until reset, so this repeats until handled.                                        |

### What closes Gate 5

For each row, a timestamped log showing the trigger, the ntfy delivery, and the
elapsed time under 60 seconds. `make alerts` produces exactly that for the rows
marked proven, and each was under one second.

**What remains, honestly:**

- **Three rows need a checker outside our infrastructure** (A1, A3, A4). This is
  the single largest remaining gap and it is not solvable from inside the node.
  `PLAN.md` section 9 already names an external uptime checker as the retained
  capability behind the deferred monitoring stack; it does not exist yet.
- **Nine rows need infrastructure that does not exist**: a deployed node (J1 to
  J4, A5, C4), a restore drill (D3), a replica (D5), a Cloudflare notification
  or Logpush consumer (A3).
- **Two rows describe a system we no longer run** (D1, D2, pgBackRest) and one
  describes a disk we do not own (D4).
- **Three rows need a code change** to become detectable at all: a rejected-
  signature counter (S2), a status-code label on upstream failures (U5), and a
  quantile computation for A6.
- **The operator must subscribe to the topic.** Nothing here can verify that a
  notification was seen by a human, and that step has not been performed.

---

## 7. Degraded modes: what each one looks like

Degradation is a designed state, so it should be recognisable rather than
alarming.

| Failure                    | Designed behaviour                                                                    | How you can tell                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One upstream down          | Circuit breaker opens, that section is omitted                                        | `degraded: true` and the provider named in `unavailableProviders`                                                                                                                                                                                                                                                         |
| Cache Redis down           | Cache misses, higher latency, correct answers                                         | `/readyz` reports `redis: fail`; latency up, no errors                                                                                                                                                                                                                                                                    |
| **Quota Redis down**       | **Rate limiting fails closed: 503, not unlimited**                                    | `pullfm_fail_closed_total{store="quota_limiter"}` increases, and S3 fires. Before that counter existed the only symptom was a 503 spike indistinguishable from an upstream provider being down, because the refusal was a bare `catch` that logged nothing. Failing closed is deliberate; being unable to see it was not. |
| Database read-only or slow | Read-only degraded mode: reads served, mutations refused                              | Mutating routes error, reads fine                                                                                                                                                                                                                                                                                         |
| Database down              | `/readyz` 503, LB removes the target                                                  | `checks.database = "fail"`                                                                                                                                                                                                                                                                                                |
| Origin unreachable         | Cloudflare maintenance worker serves an honest page                                   | Users see a maintenance page, not a timeout                                                                                                                                                                                                                                                                               |
| Deploy failing             | **Old container keeps serving.** A migration failure stops the deploy before the swap | Version at `/healthz` stops advancing                                                                                                                                                                                                                                                                                     |

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
