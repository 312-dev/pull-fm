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
./install-alert-env.sh --check     # is this node able to tell anyone anything?
                                  #   asks the NETWORK in three places. It used
                                  #   to read a file and say ARMED while every
                                  #   publish was refused 403.
./alert-selftest.sh                # prove the channel delivers, end to end
./watchdog-selftest.sh             # prove each synthetic trigger reaches ntfy
make alerts                        # both of the above
```

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

|                        | Primary                               | Secondary                            |
| ---------------------- | ------------------------------------- | ------------------------------------ |
| Direction              | **Pull.** An observer fetches from us | Push. The node posts outward         |
| Runs on                | **GitHub's scheduler**, every 10 min  | the node, at the moment of the alert |
| Credential on the node | **none**                              | one, if configured                   |
| Latency                | one watcher interval, 10 to 20 min    | seconds                              |
| Configured today       | **yes**                               | no                                   |

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
  "keys": ["unit:pullfm-deadman-selftest"]
}
```

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
that costs nothing"; that surface is now read by something off the node. And
`reset-failed` was already the gesture an operator makes, so acknowledgement
needed no new verb.

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

### TWO DIFFS ARE NEEDED IN FILES THIS DIRECTORY DOES NOT OWN

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
