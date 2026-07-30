# Runbook: scheduled background jobs

> **Status: CONFIGURED, NOT RUNNING.** The four jobs below are wired to systemd
> timers that `infra/staging/app/bootstrap.sh` installs and enables. **No
> compute is deployed, so none of them has ever fired.** Nothing in this
> document should be read as "these are running". They will begin running the
> first time a node is converged, and not before.
>
> This distinction is the whole point of the document. Three of the four jobs
> are what make the retention windows in
> [`../legal/privacy-policy.md`](../legal/privacy-policy.md) true statements
> rather than intentions, and that policy must not describe a window as enforced
> until something enforces it.

```bash
make jobs      # asserts the schedule is what this document says it is
```

---

## 1. The schedule

This table is authoritative. Every other place that mentions a cadence points
here, and `make jobs` fails if this table and the unit files disagree.

| Job                   | Command                                      | Unit                           | `OnCalendar`         | Cadence      | Bounded at |
| --------------------- | -------------------------------------------- | ------------------------------ | -------------------- | ------------ | ---------- |
| Cache warm            | `pnpm --filter @pull-fm/bff warm:cache`      | `pullfm-warm-cache.timer`      | `*-*-* *:10/30:00`   | every 30 min | 22 min     |
| Expired-row sweep     | `pnpm --filter @pull-fm/bff sweep:expired`   | `pullfm-sweep-expired.timer`   | `*-*-* *:05:00`      | hourly       | 10 min     |
| Unverified reap       | `pnpm --filter @pull-fm/bff reap:unverified` | `pullfm-reap-unverified.timer` | `*-*-* *:35:00`      | hourly       | 15 min     |
| Audit retention purge | `pnpm --filter @pull-fm/bff purge:audit`     | `pullfm-purge-audit.timer`     | `*-*-* 06:17:00 UTC` | daily        | 30 min     |

**Why those cadences**, in one line each. The full argument is in the header of
each entrypoint under `apps/bff/src/scripts/`, which is where it belongs,
because the number and the reasoning have to change together.

- **`warm:cache` every 30 minutes.** A full run spends at most 300 MusicBrainz
  calls at one every two seconds and 60 iTunes calls at one every six, so about
  sixteen minutes of pacing under a twenty minute deadline. Half-hourly is the
  cadence that leaves a gap larger than the longest possible run. Running it
  more often warms nothing extra, because each run is bounded by its own call
  ceilings, and only shortens the gap that keeps two runs off one egress IP.
- **`sweep:expired` hourly.** `idempotency_keys.expires_at` is 24 hours and the
  privacy policy says so. Daily would make the worst case 48 hours against a
  24-hour promise; hourly makes it 25, which is the schema's number plus the
  hour of clock-skew slack the sweeper deliberately allows.
- **`reap:unverified` hourly.** Same shape. `AUTH_UNVERIFIED_REAP_AFTER_S` is 24
  hours, so a daily job would make the true upper bound on an unconsented
  record's life 48 hours and the stated window would bound nothing.
- **`purge:audit` daily at 06:17 UTC.** Every window it enforces is measured in
  tens of days, so a day is the finest granularity that means anything. Weekly
  is the one cadence that would be wrong: the policy promises anonymization
  "normally within 24 hours". 06:17 UTC is 01:17 for the operator, so a failure
  is waiting at the start of the day rather than at the end of it.

**Why every timer fires on a different minute.** Each job runs as its own
container with a 384 MB cap, on a node that is also running nginx, a 768 MB BFF
and two Redis instances. Three of them starting in the same second is a memory
problem that nobody would diagnose as a scheduling one. `AccuracySec=1s` is set
for the same reason: systemd's default one-minute accuracy window lets it
coalesce timers, which is precisely the behaviour being avoided.

---

## 2. The mechanism, and why it is this one

**Scheduled commands, run by systemd timers on the application node, in
one-shot containers built from the image digest that is currently serving.**

Concretely: `pullfm-<job>.timer` starts `pullfm-<job>.service`, which runs
`/usr/local/bin/pullfm-job <job>`, which runs
`docker run --rm --network host --env-file /etc/pullfm/bff.env <digest> node dist/scripts/<job>.js`.
The digest comes from `/etc/pullfm/deploy.env`, which the deploy agent writes,
so a job can never be a different build from the request path and can never be
the first thing to run an untested image.

### The alternatives, and why each was rejected

| Option                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-process `setInterval`**         | Rejected outright. A BFF node is horizontally scaled, so an interval inside it fires once per node. For the sweeps that turns one run into an N-way race that only an advisory lock saves; for the warmer it is worse than a race, because each node would pace itself correctly against a limiter it does not share and the service would exceed a per-IP limit by exactly the node count while every node's metrics showed compliance.                                                                               |
| **`pg_cron` inside the database**    | Rejected on its merits, and separately unavailable in practice. See section 3.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **GitHub Actions `schedule:`**       | Free for a public repo, and rejected on three counts. It would need `DATABASE_URL`, the KEK and the WorkOS key as CI secrets, which is exactly the credential posture the pull-based deploy exists to avoid. Scheduled workflows are best-effort and routinely run tens of minutes late, which breaks the "worst case 25 hours" arithmetic the retention windows rest on. And the warmer would egress from shared runner addresses, so a per-IP budget we are held to would be spent by, and attributed to, strangers. |
| **Cloudflare Workers cron triggers** | Free tier exists. Rejected: a Worker cannot run the Node entrypoints, so it could only poke an HTTP endpoint, which means building an authenticated trigger route whose only purpose is to be called by a scheduler. That is new attack surface on the public API in exchange for nothing.                                                                                                                                                                                                                             |
| **A hosted scheduler**               | Rejected: the project is non-commercial and cost-sensitive, and this introduces a paid dependency for something the operating system already does.                                                                                                                                                                                                                                                                                                                                                                     |
| **Nomad periodic jobs**              | The natural answer, and not available: staging runs Docker Compose under systemd as a recorded deviation (`infra/staging/README.md`). A single-node Nomad cluster would spend 200 to 300 MB scheduling one task onto the one place it could go. Worth revisiting the day a second node arrives, which is the same day the deviation is due to be reconsidered.                                                                                                                                                         |
| **systemd timers** (chosen)          | Already the mechanism this repository uses for `pullfm-deploy.timer` and `pullfm-cf-ranges.timer`, so it adds no new concept. It runs on the node that already holds the secrets, from the same egress address the budget is measured against. It distinguishes exit codes natively, which is the requirement the other options cannot meet at all: `SuccessExitStatus=` and `OnFailure=` are the difference between "look at it Monday" and "something is unbounded right now".                                       |

### What follows the choice

- **One node, one bucket.** Pre-launch there is a single application node with
  Redis co-located on it. The advisory lock each job takes is therefore not
  load-bearing today. It is kept, and the timers are installed on every
  application node rather than pinned to one, because the two-node shape has to
  stay correct and because a timer pinned to a named node does not survive that
  node being replaced. Terraform makes the wrong order impossible: raising
  `app_node_count` without externalizing Redis fails the plan.
- **No second copy.** systemd will not start a second instance of a running
  one-shot service, so the timer firing during a long run is a no-op rather than
  an overlap. `RuntimeMaxSec` on each unit is strictly less than its interval,
  so a wedged run is killed before the next one is due.
- **Skipped, not failed, before the first deploy.** Each unit carries
  `ConditionPathExists=/etc/pullfm/deploy.env`. A node in its first sixty
  seconds has no image pinned; a skipped unit is not a failed unit and does not
  reach the alert path.

---

## 3. `pg_cron` on Neon: the answer, recorded

`docs/compliance/data-retention-policy.md` section 5.5 carried a `[CONFIRM]` on
whether `pg_cron` is available on the Neon plan in use. Nobody had checked. It
was checked on 2026-07-29 and the answer is in two parts.

**Is it available?** Yes as an extension, no as a scheduler on this plan.

- Neon lists `pg_cron` 1.6 as a supported extension for Postgres 14 through 18.
- Enabling it is not `CREATE EXTENSION` alone: `cron.database_name` has to be
  set through an Update-compute-endpoint API call, followed by a compute
  restart.
- Neon's own documentation states that **`pg_cron` jobs only run while the
  compute is active**, and recommends it only on computes that run 24/7 or that
  have scale-to-zero disabled.
- **This project is on the Neon Free plan** (`infra/neon/imports.tf` records the
  subscription as `free_v3`), and on the Free plan **scale-to-zero cannot be
  disabled**: it is always on with a five minute idle timeout. That is already
  recorded independently in `infra/neon/main.tf`.

So a `pg_cron` schedule here would run only when something else happened to be
keeping the compute awake. For a retention job whose entire value is that it
runs on a cadence, that is the worst possible property: it would work in testing,
work under load, and silently stop during exactly the quiet periods when a
24-hour window is most likely to be exceeded.

**Would it be right even if it were available?** No, and this half does not
depend on the plan.

- Three of the four jobs are not SQL at all. The reaper calls the WorkOS API,
  the warmer calls MusicBrainz and iTunes under paced budgets, and both need
  the application's own clients and configuration.
- The remaining two stopped being plain SQL the moment they became operable: the
  batching, capping, freshness signal and invariant reporting are control flow,
  and the exit codes an alerting scheduler acts on have to come from a process.
- A retention job hidden inside the database has no code review, no test suite
  and no version control, which is the wrong home for the mechanism enforcing a
  published privacy commitment.

The `[CONFIRM]` is now answered rather than withdrawn.

---

## 4. Exit codes, and how exit 1 becomes an alert

Every entrypoint under `apps/bff/src/scripts/` shares one contract:

| Code | Meaning                                                             | Treatment                                                      |
| ---- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0    | Ran, or declined because another invocation held the advisory lock. | Silent. Journal only.                                          |
| 1    | **Could not run, and changed nothing.**                             | **Unit fails. `OnFailure` fires the alert handler.**           |
| 2    | Ran, and something inside it needs a look. Nothing is unbounded.    | Logged, not alerted. `SuccessExitStatus=2` makes it a success. |

**Exit 1 is the only alert-worthy one, and the reason is that it is invisible
otherwise.** A sweeper that fails to run produces no errors, deletes no rows,
and looks exactly like a sweeper that ran and found nothing to do. Meanwhile
whatever it bounds is unbounded. Exit 2 is the opposite case: the job worked and
reported a detail, and paging on it teaches the operator to ignore the channel
that also carries exit 1.

`SuccessExitStatus=2` on each unit is what implements the split. Without it,
systemd treats 1 and 2 identically and the design collapses into "any non-zero
is a failure", which is the thing the three-code contract exists to avoid.

### Where an alert actually goes today

**This answer changed on 2026-07-29 and the change is worth stating precisely,
because the previous answer was "nowhere off the box".**

A notification channel now exists. `infra/observability/` holds one sender, one
watchdog and an installer that writes `/etc/pullfm/alert.env` out of 1Password,
and **the committed handler in this section was tested against it**: with an
`alert.env` in place, `pullfm-job-alert` published to a live ntfy endpoint and
the notification was read back off the topic. Nothing in the handler changed;
what changed is that the file it has always looked for now has a way to exist.

`/usr/local/bin/pullfm-job-alert` still writes to the surfaces that exist on any
node without further configuration, and still treats delivery as an extra rather
than as the record:

| Surface                            | Always present                              | What it gives                                                                               |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Failed systemd unit                | yes                                         | `systemctl --failed` lists it until someone resets it                                       |
| Journal, error priority            | yes                                         | `journalctl -t pullfm-job-alert -p err`, with the fixed token `PULLFM-ALERT`                |
| `/var/log/pullfm/job-alerts.jsonl` | yes                                         | One JSON object per failure, including `delivered`, so "nobody was told" is itself a record |
| ntfy                               | **once `/etc/pullfm/alert.env` is written** | Proven to deliver. `make alerts-armed` says whether THIS machine can notify anyone          |

**The spool's `delivered` field is now load-bearing rather than aspirational.**
`pullfm-watchdog` reads it and raises a separate alert when a job failure was
recorded with `delivered:false`, which covers the one case the handler cannot
cover by itself: the job failed AND the channel was down at that moment. Without
that backstop, a failure during a channel outage is silent forever.

The handler classifies the failure before writing it, so the message says which
of these happened rather than "something failed":

| Result                         | Reason          | Meaning                                                    |
| ------------------------------ | --------------- | ---------------------------------------------------------- |
| `exit-code` status 1           | `could-not-run` | The job could not run. This is the one that matters.       |
| `exit-code` status 125/126/127 | `runner-failed` | Docker could not start the container. The job did not run. |
| `timeout`                      | `timed-out`     | Killed at `RuntimeMaxSec`. Treat the run as incomplete.    |
| `signal` or `core-dump`        | `killed`        | Check the OOM killer first.                                |

**The node holds no alerting credential at all, and that is deliberate.** This
paragraph used to describe a write-only ntfy token scoped to `pullfm-staging*` on
the operator's self-hosted instance. That was `SD-002` and it is **no longer how
this works**: `SD-003` moved the primary path off the operator's personal
infrastructure entirely and made it a **pull**. The node publishes a content-free
heartbeat, nginx serves it at `/.well-known/pullfm-heartbeat`, and a scheduled
workflow in `312-dev/pullfm-heartbeat` reads it from outside every machine we own
and opens a GitHub issue when it stops. Nothing on the node can suppress that,
because there is no credential to steal and nothing to write to.

The push sink is now **optional, provider-agnostic and unset today**. One
1Password value (`pull-fm/{env}/ALERT_SINK_URL`) points it at ntfy, Discord, Slack
or any JSON webhook with no code change. Unset costs latency, not coverage: every
alert still reaches the external watcher through the heartbeat. Reasoning and full
verification in [`../security/DECISIONS.md`](../security/DECISIONS.md) `SD-003`
and `SD-004`.

```bash
# From the operator's machine, with `op` signed in. Converge does this for you;
# see infra/staging-env.sh. NEVER hand-edit alert.env: the next converge wins.
PULLFM_ALERT_ENV_LABEL=staging ./infra/observability/install-alert-env.sh --stdout |
  ssh root@NODE 'install -m 0600 -o root -g root /dev/stdin /etc/pullfm/alert.env'

# On the node, prove it rather than assume it. Four network questions, not a file.
sudo ./install-alert-env.sh --check
```

Until the heartbeat is running on a given node, **an exit 1 is recorded there and
nobody is told**. `--check` answers that by asking the network, including whether
anything is actually _polling_ the beat, because a switch nobody polls is not a
switch. It used to read a file and print `ARMED` while every publish was refused
403, which is why it now reports each question separately and says `NOT PROBED` or
`SKIPPED` rather than anything that reads like proof.

### Clearing an alert: `--ack` means seen, `--resolve` means fixed

The heartbeat publishes a count of **unacknowledged** conditions, and the watcher
raises "N unacknowledged alert(s)" from it. There are three supported ways to
clear one and **none of them is `rm`**:

```bash
pullfm-alert --list                       # what is outstanding, and HOW OLD
pullfm-alert --ack <key> --ack-note 'why' # seen, not yet fixed. RECORDS who+when
pullfm-alert --resolve --key <key>        # the condition actually went away
systemctl reset-failed <unit>             # for a unit: key, still the right gesture
```

**Do not delete files under `/var/lib/pullfm/alerts/` to clear a count.** It works,
and that is the problem: it leaves no record that an alert was cleared, and the
habit does not distinguish a probe you recognise from a real alert you have not
read yet. `--ack` records who acknowledged, when, from which host and optionally
why, and it deliberately leaves the dedupe stamp in place so the repeat window
keeps working.

An ack is **not** permanent amnesty: if the condition fires again after the repeat
window it returns to unacknowledged, and the beat publishes `oldest` so a
long-standing condition can escalate on age instead of sitting at the same count.
Acking a key that is not pending **fails with exit 6** rather than pretending to
succeed. `pullfm-alert --list` is the supported way to find the exact key to type.

This is also still the reason `purge:audit` carries its own in-band freshness
signal: the `stale` field of its run outcome reports that nothing was anonymized
within the freshness window while rows past the retention window were waiting.
That is the only symptom a silently dead scheduler produces from the inside, and
it remains worth having now that there is a channel, because a channel is one
more thing that can be broken.

---

## 5. What is actually running

| Thing                    | State                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| The four jobs            | Written, tested, and **runnable by hand**                                       |
| The four timers          | **Configured in git and enabled by bootstrap.sh. Never fired.**                 |
| The alert handler        | **Configured. Never invoked by systemd**, but proven to deliver by hand         |
| A notification channel   | **EXISTS and is proven.** `infra/observability/`, armed per node from 1Password |
| The watchdog             | **Written and proven** against synthetic triggers. Never run on a real node     |
| Compute to run any of it | **Not deployed.** `infra/terraform` is not applied and the run rate is EUR 0.   |

**What remains blocked on deployment**, and only on deployment:

1. Evidence that any timer fired. `systemctl list-timers 'pullfm-*'` on a
   converged node is the first proof, and `journalctl -u pullfm-sweep-expired`
   showing a summary line is the second.
2. Closing appendix item 1 of `legal/privacy-policy.md`, which requires a
   schedule that **exists and is verified to have fired**. The first half is now
   true. The second cannot become true without a node.
3. Gate 5 evidence for the four job conditions. The channel half is done; what
   is left is a node on which a real exit 1 can be classified. The handler reads
   `Result=` and `ExecMainStatus=` from systemd, so it cannot be exercised
   anywhere else: run on a laptop it correctly reports `unexpected`, because
   there is no unit to ask about.

Until then the accurate statement, and the one the legal documents should make,
is: **these are the retention windows the system applies on every run, the runs
are scheduled, and the schedule has not started because nothing is deployed.**

---

## 6. Verifying, without infrastructure and with it

### From a checkout, right now

```bash
make jobs
```

`infra/scripts/check-job-schedule.mjs` asserts, and fails the build on any of:

- every job has a `.service` and a `.timer`, and `bootstrap.sh` **enables** each
  timer rather than merely installing it (installed-and-dormant is the same
  failure as unscheduled, and it looks like progress in a diff)
- every unit carries `SuccessExitStatus=2` and `OnFailure=`, so exit 1 and exit
  2 cannot collapse into one treatment
- `RuntimeMaxSec` is set and is strictly shorter than the firing interval
- every job name the runner accepts resolves to a real entrypoint **and** to the
  same `pnpm` command this document quotes, so a renamed script breaks CI rather
  than silently retiring a timer
- each `OnCalendar` expands to a constant interval of the intended length, with
  the expansion **cross-checked against `systemd-analyze calendar`** wherever
  systemd exists. On macOS it falls back to this repository's own parser and
  says so; on Linux the comparison is a hard assertion.
- no two jobs fire on the same minute
- this document quotes the same calendars as the unit files

### On a node, once one exists

```bash
systemctl list-timers 'pullfm-*'              # next and last elapse for each
systemctl start pullfm-sweep-expired.service  # force one run
journalctl -u pullfm-sweep-expired -n 50      # the JSON summary is on stdout
systemctl --failed                            # anything that exited 1
cat /var/log/pullfm/job-alerts.jsonl          # the failure spool
make alerts-armed                             # can this node notify anyone?
```

The last line is the one that is easy to skip and is the difference between a
recorded failure and a reported one. A node whose timers all fire correctly and
whose `alert.env` is missing is a node that enforces every retention window and
tells nobody when it stops.

A dry run of any job without the timer, using the deployed image:

```bash
/usr/local/bin/pullfm-job sweep-expired; echo "exit $?"
```

---

## 7. Changing a schedule

1. Change the reasoning in the entrypoint header under `apps/bff/src/scripts/`.
   The cadence and the argument for it live together.
2. Change the `.timer` and, if the bound moved, `RuntimeMaxSec` in the
   `.service`.
3. Change the table in section 1 of this document and the table in
   `docs/compliance/data-retention-policy.md`.
4. `make jobs`. It fails if any of the three disagree.
5. Converge. Timers are picked up by `bootstrap.sh`, which is idempotent.

**Do not turn any of these into an in-process timer.** The reasoning is in every
entrypoint header and in section 2, and it does not become less true when there
is only one node: it becomes untrue silently, on the day there are two.
