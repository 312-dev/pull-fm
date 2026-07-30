# Observability and alerting

> **Status: the channel is ARMED and PROVEN, and since 2026-07-29 its PRIMARY PATH
> IS A PULL BY AN OBSERVER OUTSIDE ALL OF OUR INFRASTRUCTURE.** The node publishes
> a content-free heartbeat, a scheduled workflow in
> [`312-dev/pullfm-heartbeat`](https://github.com/312-dev/pullfm-heartbeat) reads
> it and probes the public origin, and a GitHub issue plus a red run notify the
> operator. Proven by breaking it in two places, not by reading a config file.
>
> Before this directory existed there was **no notification channel anywhere in
> this project**. Four scheduled jobs classified their own failures correctly,
> wrote them to a file on a node, and told nobody.
>
> Before 2026-07-29 there was a channel and it still could not report the one
> thing that matters most: **every detector ran on the node it was reporting on,
> so a dead node produced no alert, and no alert is exactly what a healthy quiet
> week looks like.** Silence was indistinguishable from health. That is the gap
> the heartbeat closes, and it is why the primary path deliberately holds no
> credential on the node at all.

```bash
sudo ./install-alert-env.sh --check # is this node able to tell anyone anything?
                                  #   asks the NETWORK in FOUR places. It used
                                  #   to read a file and say ARMED while every
                                  #   publish was refused 403. `sudo` because
                                  #   question 2b needs the nginx access log.
./alert-selftest.sh                # prove the channel delivers, end to end
./watchdog-selftest.sh             # prove each synthetic trigger reaches ntfy
make alerts                        # both of the above

pullfm-alert --list                # what is outstanding, and HOW OLD it is
pullfm-alert --ack <key> --ack-note 'looking at it'   # a human saw it
pullfm-alert --resolve --key <key> # the condition actually went away
```

> **`--ack` means seen. `--resolve` means fixed. They are different on purpose,
> and neither is `rm`.** Before `--ack` existed the only way to clear a pending
> condition was deleting its dedupe stamp under `/var/lib/pullfm/alerts/` by
> hand, which is a reflex that does not distinguish a probe you recognise from a
> real alert you have not read. See `DECISIONS.md` `SD-004`.

---

## 1. What is here

| File                          | What it is                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `pullfm-alert`                | **The** notification sender. Provider-agnostic: ntfy, Discord, Slack or JSON       |
| `pullfm-heartbeat`            | Emits the content-free beat the external dead man's switch watches                 |
| `pullfm-watchdog`             | Scrapes the node's own `/metrics` once a minute and fires the section 6 conditions |
| `install-alert-env.sh`        | Writes `/etc/pullfm/alert.env` from 1Password. The one command that arms a node    |
| `alert.env.example`           | The shape of that file. `op://` references, never values                           |
| `alert-selftest.sh`           | Proves the channel delivers, against a real ntfy                                   |
| `watchdog-selftest.sh`        | Proves each detector fires, with negative controls                                 |
| `systemd/`                    | The watchdog and heartbeat units and timers                                        |
| `testdata/metrics-sample.txt` | A real captured scrape, used as the self-test fixture                              |

---

## 2. The channel, and the judgement call behind it

**There are two paths and the order matters.**

|                          | Primary                                    | Secondary                            |
| ------------------------ | ------------------------------------------ | ------------------------------------ |
| Direction                | **Pull.** An observer fetches from us      | Push. The node posts outward         |
| Runs on                  | GitHub's scheduler, cron says every 10 min | the node, at the moment of the alert |
| Credential on the node   | **none**                                   | one, if configured                   |
| Latency, as designed     | one watcher interval, 10 to 20 min         | seconds                              |
| Latency, **as measured** | **one watcher GAP: 60 to 150+ min**        | seconds                              |
| Configured today         | **yes**                                    | no                                   |

> **THE MEASURED ROW IS THE TRUE ONE.** On 2026-07-30 the scheduled workflow had
> run **three times in 4.5 hours** (gaps of 62, 81 and 153 minutes) against about
> 27 expected ticks, and **every gap was longer than the 30-minute staleness
> ceiling the watcher itself enforces**. Corroborated from nginx's access log,
> which shows three fetches of the beat at exactly those times and none between.
> GitHub's cron drops ticks, and the repository is **private**, so `SD-003`'s
> "Actions minutes are unmetered on public repositories" no longer applies to it:
> at GitHub's one-minute-per-job billing floor a true 10-minute cadence is ~4,320
> minutes a month against the Team plan's 3,000. Recorded as `PULLFM-RISK-020`.
>
> This is the third time this project has found a control that was described
> correctly and behaved differently, and the first two were found the same way:
> **by asking the running system instead of the repository.**

The primary path exists because of a finding that is worth stating in one line:

> **Alerting that runs on infrastructure inside the failure domain it reports on
> cannot report that domain failing.** It is a burglar alarm wired to the fuse box
> inside the house.

That was true twice over. Section 4 has always recorded that a watchdog on a dead
node does not alert. And until 2026-07-29 the destination was an ntfy container on
the operator's personal Hetzner box, so a product depended on personal
infrastructure for its operational alerting, and an outage of that box was hardest
to notice at exactly the moment it mattered.

### How the primary path works

```
pullfm-heartbeat  ->  /var/lib/pullfm/heartbeat/staging.json   (every 5 min, and after every alert)
       nginx      ->  https://api-staging.pull.fm/.well-known/pullfm-heartbeat   (no auth)
    deadman.yml   <-  reads the beat, probes /healthz           (every 10 min, on GitHub)
                  ->  GitHub issue + red workflow run           (email + GitHub Mobile push)
```

The beat is four scalars and a list of names:

```json
{
  "v": 1,
  "env": "staging",
  "ts": "2026-07-29T21:50:46Z",
  "epoch": 1785361846,
  "pending": 1,
  "oldest": 3600,
  "keys": ["unit:pullfm-deadman-selftest"]
}
```

`oldest` is the age in seconds of the **longest-standing unacknowledged**
condition, and 0 means nothing pending or no age known. It exists because a count
cannot escalate: `pending:1` reads identically whether the condition started a
minute ago or a week ago, and an alarm that never changes is one an operator stops
reading. It is a scalar and names nothing, so it adds no disclosure over `pending`
and `keys` (which is the question `PULLFM-RISK-017`'s review note asks).

**It carries a count, never an alert.** No hostname, no unit path, no journal tail,
because the file is public and those are reconnaissance material about a node that
holds third parties' Last.fm session keys. The bodies stay on the node, which is
where `docs/RUNBOOK-JOBS.md` already sends you. This is the payload-free push
notification pattern: the wake-up crosses the open channel, the detail is fetched
over an authenticated one. `alert-selftest.sh` **fails** if the beat ever contains
a `host`, `message`, `body`, `detail` or `tail` field, so this is enforced rather
than remembered.

`pending` reuses two pieces of state that already had exactly the right lifecycle,
so nothing new has to be kept in sync:

| Source                         | Created by            | Cleared by               |
| ------------------------------ | --------------------- | ------------------------ |
| `/var/lib/pullfm/alerts/<key>` | `pullfm-alert` firing | `pullfm-alert --resolve` |
| a `pullfm-*` unit in `failed`  | any job unit failing  | `systemctl reset-failed` |

The second is why **`pullfm-job-alert` needed no change at all** to reach the
switch. It already left the failed unit failed and called that "a fourth surface
that costs nothing"; that surface is now read by something off the node.

### Acknowledgement, and the sentence this file used to end that paragraph with

It used to say: _"and `reset-failed` was already the gesture an operator makes, so
acknowledgement needed no new verb."_ **That was wrong, and the way it was wrong
is instructive.** It is true for one of the two sources and false for the other.
A `pullfm-alert` dedupe stamp has no `reset-failed`, so for every watchdog-raised
condition the only way to clear a pending count was `rm` on a file under
`/var/lib`, and that is what actually happened to two verification probes on the
night the switch shipped.

There are now three verbs and the distinction between them is the point:

| Verb                     | Means                     | Does                                                               |
| ------------------------ | ------------------------- | ------------------------------------------------------------------ |
| `--ack <key>`            | **seen**, not yet fixed   | records who/when/where/why in `<key>.ack`; count drops; stamp kept |
| `--resolve --key <key>`  | **fixed**, condition gone | removes the stamp and both siblings; sends one recovery notice     |
| `systemctl reset-failed` | fixed, for a `unit:` key  | unchanged; still the right gesture for a failed unit               |

Layout under `/var/lib/pullfm/alerts/`, whose only writer is `pullfm-alert`:

```
<key>         the dedupe stamp. ONE Unix timestamp. NEVER touched by an ack.
<key>.first   the epoch the key was first seen. Written once. This is `oldest`.
<key>.ack     epoch <TAB> who <TAB> host <TAB> iso8601 <TAB> note
```

**Three invariants, each of which was a bug before it was a rule:**

1. **An ack never touches the dedupe stamp.** If it did, the next tick of a
   once-a-minute watchdog would look like a brand new condition and page
   immediately, so acknowledging would increase the noise.
2. **A real re-fire clears the ack.** Suppressed repeats inside the window do not;
   a fire after the window does. An ack silences the nagging, never the condition.
3. **Acking a key that is not pending exits 6.** A silent success would leave an
   operator believing they had acknowledged something that is still counting.

`.first` is separate from the stamp because **a condition that re-fires hourly
keeps a permanently fresh dedupe timestamp**, so that timestamp can never answer
"how long has this been broken".

The 11 assertions covering all of this are in `alert-selftest.sh`, including that
the siblings are never themselves published as conditions - getting that wrong
makes an acknowledgement _increase_ the count it was meant to reduce.

### 2b. Is anything actually POLLING the beat

Questions 1 and 2 of `--check` prove **our** half of the chain: the beat is
written, and it is readable from outside. Neither says the watcher is reading it,
and section 2's measured-latency box is what that gap looked like in practice.

So `--check` asks a fourth question, from nginx's access log, against a one-hour
ceiling (`PULLFM_POLL_CEILING_S`). Two properties make it honest, and **both were
bugs first**:

- **It excludes its own probe by user agent.** Question 2 fetches the public beat
  seconds earlier and that request lands in the same log. Without the exclusion
  `--check` sees itself, reports "polled 0s ago" and passes on every node forever.
  **A check that cannot fail is not a check** - the exact defect `--check` was
  rewritten to stop shipping, reintroduced by the fix for it.
- **It reports presence without claiming attribution.** Requests arrive through
  Cloudflare, so the watcher and your own `curl` are indistinguishable, and it
  says so in its output. The asymmetry is deliberate: **it cannot prove a poll
  came from the watcher, but it can prove nobody polled at all, and absence is
  the alarm condition.**

Proven able to fail, which is the only proof that counts here:

```
log with no polls of the beat  -> NOT ARMED: nothing has requested ... at all   exit 1
newest poll 2 hours old        -> NOT ARMED: last fetched 7200s ago (ceiling 3600s)  exit 1
```

The authoritative record of the watcher is still GitHub's, and it is one command:

```bash
gh run list -R 312-dev/pullfm-heartbeat --event schedule   # look at the GAPS
```

### Why the node holds no credential, which was forced and is better

A push design was built first: a write credential on the node, posting a beat to a
destination the watcher could read. It was abandoned on measurements, not on taste:

| Candidate write credential                       | Measured on 2026-07-29                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| GitHub deploy key (the only one an API can mint) | **disabled organisation-wide** on `312-dev`                              |
| GitHub fine-grained PAT, or a GitHub App         | no creation API exists; both need a human                                |
| Cloudflare Worker plus KV                        | every Pull.fm token: `Authentication error`. Minting one: `403`          |
| An existing R2 bucket credential                 | reaches the **database backups**. That is `PULLFM-RISK-009` re-committed |

So it pulls. **That is strictly stronger than any push**, and the reasoning
generalises: there is no token to steal, rotate, scope wrongly or spend, and a
compromised node can neither forge health it does not sign nor suppress an alarm
it cannot reach. `SD-002` spent two documents arguing how narrow to make a
credential the node had to hold. The better question was whether it had to hold
one.

The same reasoning picked `on: schedule` over `on: push` in the watcher: a
scheduled workflow always runs the copy of the workflow file on the default
branch, so there is no version of the alarm that the monitored side supplies.

### The secondary path, and why it is one value

`pullfm-alert` derives its wire format from the sink URL, so the destination is
**one 1Password item** and no code change:

| `pull-fm/{env}/ALERT_SINK_URL` looks like | kind      | shape sent                                  |
| ----------------------------------------- | --------- | ------------------------------------------- |
| `…discord.com/api/webhooks/…`             | `discord` | JSON `content`                              |
| `…hooks.slack.com/…`                      | `slack`   | JSON `text`                                 |
| anything with `ntfy` in it                | `ntfy`    | body plus `Title`/`Priority`/`Tags` headers |
| anything else                             | `webhook` | JSON with both, plus structured fields      |

All four are proven against a live receiver. **It is unset today**, and that is
deliberate rather than unfinished: no third-party account could be created, because
every free candidate needs an email confirmation and every paid one needs a card.
Grafana OnCall, Pushover, a Discord webhook or ntfy.sh Supporter all drop straight
in. The cost of leaving it unset is latency, not coverage, and it is recorded as
`PULLFM-RISK-018`.

### The history, and the one lesson that generalises

`SD-001` chose an anonymous `ntfy.sh` topic with 96 bits of entropy, reasoning
carefully about which credential to put on the node. `SD-002` measured it and found
the arrangement **had no credential at all**: anonymous `ntfy.sh` grants read and
write on every topic on the instance, which is strictly broader than the token
`SD-001` rejected. `SD-002` then moved to a write-only `pullfm-staging`-scoped
token on the personal box, verified by attempting every forbidden operation, and
`SD-003` moved off that box entirely.

The lesson from `SD-001` is still the best line in this directory: **absence of a
credential reads as safety.** "No token on the node to steal" answers the wrong
question; the right one is what an unauthenticated client is permitted to do.

`SD-003` adds a second: **absence of an alert reads as health.** Both are the same
mistake - treating an absence as evidence - and both took a measurement rather than
an argument to find.

### The KNOWN GAP recorded here on 2026-07-29 is now FIXED

It read: _`--check` now reports ARMED on a node that cannot deliver._ It was real,
and it was measured - the same node was refused **403 on every publish** while
`--check` printed `ARMED` and exited **0**. Both halves are closed in
`install-alert-env.sh`, which this change owns:

- **The token guard.** A sink whose URL says ntfy and whose token is empty is now
  refused at install time with exit 65, overridable only by setting
  `PULLFM_ALLOW_ANONYMOUS_NTFY=1` deliberately.
- **`--check` asks the network, in three places, and reports each separately.**
  Is the beat being written; is it **readable from outside**, through nginx and
  Cloudflare, which is the chain the watcher actually traverses; and will the sink
  accept a publish right now. For ntfy that last one uses the authorization probe
  that stores nothing and wakes nobody (an empty-body `POST` with `Cache: no` and
  `Firebase: no`). For every other provider there is no side-effect-free probe, so
  it says **`NOT PROBED`** in those words rather than printing something that reads
  like proof.

Reproduced side by side on the node with a deliberately invalid token:

```
file-only verdict (the retired behaviour):  ARMED (exit 0)      <-- WRONG
--check (now):  SINK NOT ARMED: 401. The token is invalid or absent.
RESULT: NOT ARMED                                                   exit 1
```

The general form, since this is the third time this repository has shipped a
control that looked configured and was absent: **a check that reads configuration
is not a check.** Ask the thing you are depending on.

### What this costs

Recorded in full in `SD-003` and as `PULLFM-RISK-017`, `018` and `019`:

- **The beat is public and says which condition is firing.** The set of possible
  keys was already public in `pullfm-watchdog`; which one is firing now is new.
- **Nothing watches the watcher.** GitHub Actions is one third party, its cron is
  best-effort, and scheduled workflows are disabled after 60 days of repository
  inactivity. The chain terminates somewhere; it now terminates at a third party
  with a public status page rather than at one container on a personal box.
- **Detection is slower than a push**: 10 to 20 minutes for a new condition, up to
  about 40 for a stale beat, because the 30-minute staleness ceiling must absorb
  both the 5-minute node timer's jitter and GitHub's cron jitter. A switch that
  cries wolf gets muted, and a muted switch is the silence this replaced.
- **The wiring is not in converge yet** (`PULLFM-RISK-019`), so until the two
  diffs in section 3 land, **a rebuild comes back without the heartbeat**. That is
  the `PULLFM-RISK-012` failure mode exactly, which is why it has a short expiry.

### Related, and already recorded

`docs/PLAN.md` section 9 names "one external uptime checker outside our
infrastructure" as the retained capability behind the deferred monitoring stack.
**That checker now exists**, and it is `deadman.yml`. Section 4 below is updated
accordingly.

---

## 3. Arming a node

```bash
# 1. On the operator's machine, with `op` signed in. This is what converge runs.
PULLFM_ALERT_ENV_LABEL=staging ./infra/observability/install-alert-env.sh --stdout |
  ssh root@NODE 'install -m 0600 -o root -g root /dev/stdin /etc/pullfm/alert.env'

# 2. On the node, prove it rather than assume it. This now asks the network.
/usr/local/bin/pullfm-heartbeat
./install-alert-env.sh --check          # must print ARMED (public)

# 3. Prove the WATCHER, not just the node. A switch nobody has fired is not a switch.
gh workflow run deadman.yml -R 312-dev/pullfm-heartbeat -f simulate=stale
```

Step 3 is not ceremony. `docs/RUNBOOK-INCIDENT.md` section 10 records that this
project has **three** times shipped a control that looked configured and was
absent, and the third was the watcher itself: its first version was invalid YAML,
which GitHub reports as "workflow file issue" while registering no triggers, so the
repository looked armed and ran nothing.

### THE DESTINATION IS ALREADY A CONVERGE-RENDERED VALUE, AND NEEDS NO DIFF

Worth stating because it is the thing most likely to be "helpfully" re-plumbed by
somebody who assumes it is missing. `infra/staging-env.sh` already renders
`/etc/pullfm/alert.env` during converge:

```bash
"${ROOT}/infra/observability/install-alert-env.sh" --stdout |
  ssh ... "sudo install -m 0600 -o root -g root /dev/stdin /etc/pullfm/alert.env"
```

and it **warns** when that fails, with the words "the node will run its timers and
notify nobody". So repointing Pull.fm's push destination at any provider is
**one 1Password value plus a converge, and no code change**: set
`pull-fm/{env}/ALERT_SINK_URL` (and `ALERT_SINK_TOKEN` if the provider needs one
separately from the URL). `pullfm-alert` derives the wire format from the URL.

**Never hand-edit `/etc/pullfm/alert.env` on a node.** The next converge
overwrites it, so a hand edit is a change that disappears at the next deploy and
takes the control with it. The file's own header says so.

Items are referenced **by title**, never by item id: `tools/check-public-identifiers.mjs`
fails CI on an item id, because an id is a direct object reference.

### THREE DIFFS ARE NEEDED IN FILES THIS DIRECTORY DOES NOT OWN

**Until both land, a converge produces a node with no heartbeat**, the watcher trips
on `no-heartbeat`, and a permanently tripped switch gets muted. Tracked with a short
expiry as `PULLFM-RISK-019`. Both were installed by hand on the running node so the
design could be verified end to end; neither survives a rebuild.

**1. `infra/staging/app/bootstrap.sh`** currently installs only `pullfm-alert` and
`pullfm-watchdog` from `./observability`. It needs the heartbeat too:

```bash
install -m 0755 ../observability/pullfm-alert     /usr/local/bin/pullfm-alert
install -m 0755 ../observability/pullfm-watchdog  /usr/local/bin/pullfm-watchdog
install -m 0755 ../observability/pullfm-heartbeat /usr/local/bin/pullfm-heartbeat   # ADD
install -m 0644 ../observability/systemd/pullfm-watchdog.{service,timer}  /etc/systemd/system/
install -m 0644 ../observability/systemd/pullfm-heartbeat.{service,timer} /etc/systemd/system/  # ADD
systemctl enable --now pullfm-watchdog.timer
systemctl enable --now pullfm-heartbeat.timer                                        # ADD
```

**2. `infra/staging/app/nginx-pullfm.conf.in`**, in the port 443 server block,
immediately before `location = /metrics`:

```nginx
    # THE DEAD MAN'S SWITCH READS THIS FROM OUTSIDE OUR INFRASTRUCTURE.
    # Served by nginx with no credential, and deliberately NOT by the application:
    # it has to keep answering when the container does not, and a watcher that
    # needed a token would need that token in a public repository's Actions
    # secrets. Content-free by construction; bodies stay on the node.
    location = /.well-known/pullfm-heartbeat {
        alias /var/lib/pullfm/heartbeat/staging.json;
        default_type application/json;
        add_header Cache-Control "no-store" always;
        # access_log stays ON: the log is the only evidence that the watcher is
        # really polling, and a switch nobody polls does not exist.
    }
```

Note `alias` rather than `root`, and note the file name is per environment, so the
production template gets `prod.json` and the URL in
`install-alert-env.sh` already switches on `PULLFM_ALERT_ENV_LABEL`. nginx runs on
the host rather than in a container here, so no compose change is needed;
`/var/lib/pullfm` is `0755` and the beat is written `0644`, which `www-data` can
read - confirmed with `sudo -u www-data cat`.

**3. `.github/workflows/deadman.yml` in `312-dev/pullfm-heartbeat`**, which is a
different repository and could not be committed to by the change that wrote this.
The node now publishes `oldest`; **nothing reads it yet**, so an unacknowledged
condition still sits at an unchanging count and never escalates. In the
`else` branch that parses the beat, alongside the existing `pending` handling:

```bash
oldest=$(printf '%s' "${beat}" | jq -r '.oldest // 0' 2>/dev/null)
case "${oldest}" in '' | *[!0-9]*) oldest=0 ;; esac

if [ "${pending}" != "0" ] && [ "${pending}" != "?" ]; then
  # Age in the SAME line as the count, so the escalation is visible in the issue
  # title path rather than buried: a count that never changes is wallpaper.
  add pending-alerts "The node reports **${pending} unacknowledged alert(s)** \
(oldest **$((oldest / 60))m**), keys \`${keys:--}\`. Bodies deliberately stay on \
the node: \`journalctl -t pullfm-alert -p err\` and \`/var/log/pullfm/alerts.jsonl\`."
fi

# A SEPARATE problem key, not a longer message. An operator who has been looking
# at "3 unacknowledged" for two days needs the alarm to CHANGE, and a new key is
# what makes the issue comment read differently instead of identically.
if [ "${oldest}" -gt "${ESCALATE_SECONDS:-86400}" ]; then
  add stale-unacknowledged "A condition has been unacknowledged for \
**$((oldest / 3600))h**, ceiling $((${ESCALATE_SECONDS:-86400} / 3600))h. Either fix it, or \
acknowledge it on the node with \`pullfm-alert --ack <key>\` so the record says who \
accepted it and when."
fi
```

with `ESCALATE_SECONDS: '86400'` added next to `STALE_SECONDS` in the job `env:`.

**The residual this does not close, stated because it is the honest half:** an
acknowledged condition drops out of `pending` and out of `oldest` entirely, so an
operator who acks something and never fixes it has a permanently quiet switch.
Closing that needs the beat to publish an acked count too, which is another field
on a public document, and `PULLFM-RISK-017`'s review note asks specifically about
field creep. It is deliberately left as the owner's decision rather than taken.

### The rest of what `bootstrap.sh` needs, unchanged

1. **`/etc/pullfm/alert.env` must exist before the timers can notify anyone.** It is
   a secret, so it travels the path `bff.env` does (over SSH, after the node
   exists, never through Terraform `user_data`, which is persisted in state and
   readable from the Hetzner API for the life of the server).
2. **`nginx` should deny `/metrics` at the edge** - already present in the template.

## 4. What the watchdog can and cannot see

It runs **on the node**. That buys credential-free loopback access to `/metrics`
and one permanent blind spot:

> **A watchdog on a dead node does not alert.**

**That blind spot is now covered, and this section used to say it could not be.**
The sentence it used to end on was: "the honest statement is that Pull.fm cannot
tell anyone its node is gone." That is no longer true.

`deadman.yml` in `312-dev/pullfm-heartbeat` probes
`https://api-staging.pull.fm/healthz` from a GitHub runner, which is outside
Hetzner, outside the operator's estate, and behind neither Cloudflare tunnel. So
**A1 (external health check), A3 (edge 5xx) and A4 (origin unreachable from the
edge) are armed**, by the one external uptime checker `docs/PLAN.md` section 9 named
as the retained capability behind the deferred monitoring stack.

What the split buys, and it is worth keeping straight:

| Question                        | Answered by                 | Because                        |
| ------------------------------- | --------------------------- | ------------------------------ |
| Is the node serving traffic?    | the external probe          | it must not depend on the node |
| Is the watchdog still watching? | heartbeat staleness         | a dead watchdog stops the beat |
| Which condition is firing?      | the watchdog, via `pending` | it needs loopback `/metrics`   |

The watchdog's own `/healthz` check remains a **backstop for a crashed container on
a live node**, and its alert text says so, so it is not mistaken for A1.

## 5. Metrics

`GET /metrics` on the BFF, Prometheus text format, no client library (the
reasoning is in the header of `apps/bff/src/lib/metrics.ts`). Every series is
justified against a named alert or a named gate in the header of
`apps/bff/src/lib/observability.ts`; nothing is exported because it is
interesting.

**Access:** loopback, checked against the TCP peer address rather than `req.ip`
(`trustProxy` is on, so `req.ip` is a client-supplied header), or a bearer token
equal to `METRICS_TOKEN`. Anything else gets a 404, not a 403, because a 403
confirms the endpoint is worth another guess.

**Drift protection.** The watchdog is a shell script that greps for series
names. A rename would make it find nothing, skip the check, and disarm an alert
in complete silence. Two tests prevent that:

- `apps/bff/src/lib/observability.test.ts` extracts the metric names **out of
  `pullfm-watchdog` itself** and requires the application to emit every one.
- `apps/bff/test/integration/observability.test.ts` requires
  `testdata/metrics-sample.txt` to still match a live scrape, so the self-test
  fixture cannot go stale.

Between them, a rename breaks a test in the commit that makes it.

---

## 6. Maintenance mode

Two levers, and they compose in one direction only:

| Lever                                | Needs a restart | Use when                                     |
| ------------------------------------ | --------------- | -------------------------------------------- |
| `MAINTENANCE_MODE=true` in `bff.env` | yes             | planned work, a deploy freeze, vacation mode |
| `touch /etc/pullfm/maintenance`      | **no**          | containment during an incident               |

Either being set means maintenance. The file can never turn it **off** while the
environment says on, which is deliberate: a lever that could clear the env flag
would be a way to accidentally serve traffic from a node an operator had
contained during a SEV-1.

`/healthz`, `/readyz` and `/metrics` stay up throughout. The first two so the
orchestrator does not restart a node that was deliberately stopped; the third
because losing observability at the moment of an incident is the opposite of
what maintenance mode is for.

Proven, not described: `apps/bff/test/integration/observability.test.ts`
enumerates the **router** and asserts every application route answers 503 with
`Retry-After: 300`, then flips the file lever on and off inside one live process
and asserts 503 then 200. A route added later that forgets to be covered fails
that test on the day it lands.
