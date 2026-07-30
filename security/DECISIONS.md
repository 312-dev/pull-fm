# Security decisions

Decisions where the reasoning is the valuable part and would otherwise be lost.

This is not a list of controls: those are in [`THREAT-MODEL.md`](THREAT-MODEL.md) and
[`API-SECURITY-CHECKLIST.md`](API-SECURITY-CHECKLIST.md). It is not a list of accepted weaknesses
either: those are in the accepted-risk register, which is held privately (see [`README.md`](README.md),
"What is not in this directory"). This file holds the decisions in between, where a reasonable
engineer could have gone the other way and the reason for going this way is not visible from the
result.

Each entry states what was decided, what was rejected, why, and **what it costs**, because a decision
record with no downside in it is advocacy rather than a record.

| ID       | Decision                                                                  | Status                                                                     |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SD-001` | Alerting runs on its own credential, not on the operator's personal ntfy  | **Superseded by `SD-002`.** Its premise was measurably wrong               |
| `SD-002` | Alerting runs on a write-only ntfy credential scoped to `pullfm-staging*` | **Superseded by `SD-003`.** Its control was right, its destination was not |
| `SD-003` | The alerting primary path is a PULL by an observer outside our estate     | Decided and implemented. Verified by breaking it in two different places   |

---

## `SD-001` The alerting boundary is the credential, not the topic

> **SUPERSEDED on 2026-07-29 by [`SD-002`](#sd-002-the-alerting-credential-is-write-only-and-scoped-to-pullfm-staging).
> The principle in the title is right and survives. The arrangement it chose does not: it was
> measured on the node and it does not have a credential at all.** Left in place unedited, because
> the reasoning below is exactly the reasoning that produced the gap and deleting it would destroy
> the evidence. Read `SD-002` for what is true now.

**Decided:** 2026-07-29
**Owner:** `ope@312.dev`
**Applies to:** every environment that can send an alert

### What was decided

Pull.fm's alerting sends to a **dedicated ntfy.sh topic whose name carries 96 bits of entropy**,
created for this project and used by nothing else. The endpoint is injected at deploy time from
1Password into `/etc/pullfm/alert.env` (0600, root-owned) and **is not in this repository**, has no
default, and has no fallback. The sender has no hardcoded destination at all.

The operator's **personal ntfy instance was deliberately not used**, despite being the faster and in
some ways better option.

### What was rejected, and why

The personal instance is genuinely the more attractive choice on the merits: it already exists, it is
already monitored, the operator already has the app installed and already reads it, and an alert
channel somebody actually reads is worth more than a technically cleaner one they ignore. Wiring it
up is a few minutes of work with a token that is already in the same 1Password vault this project
reads from.

**The token is the problem.** That token is a publish credential for the personal box's
`security-critical`, `security-warn` and `security-info` topics, which are where **CrowdSec, Falco,
auditd and AIDE** report. It is write-only by design, so that a compromised container can inject
noise but cannot read the detection stream.

Now put that credential on a Pull.fm node. A Pull.fm node holds **other people's Last.fm session
keys, which do not expire**, and other people's ListenBrainz tokens. That makes it the most
attractive target on the operator's network by some distance. A compromise of it would hand the
attacker publish access to the channel that reports intrusions on unrelated personal infrastructure.

**Flooding a detection feed is not a hypothetical.** Burying the real alert under noise is a standard
move after landing on a host, and it works because the defender's attention, not the detector, is the
scarce resource.

So the coupling is not "two systems share a notification service". It is "the system holding third
parties' credentials can suppress the detection of its own compromise spreading". That is a real
attack path manufactured by a convenience, and it is the whole reason for the decision.

### The part that is easy to get wrong

**A dedicated topic is not isolation.** `pullfm-alerts` sounds like the answer and addresses none of
the above, because **on ntfy the boundary is the credential, not the topic**. A token that can
publish to `pullfm-*` and to `security-*` has the same blast radius whichever topic Pull.fm actually
writes to. Topic names are routing; access rules are the control.

The minimum acceptable form of "use the personal instance" is therefore all three of:

- a **dedicated ntfy user** for Pull.fm, and
- a **publish-only access rule scoped to `pullfm-*`** and nothing else, and
- a token that is not the existing `alerter` token and never becomes it.

That is a small change, on the operator's own infrastructure, to an ACL. It is theirs to make with
their own eyes on it, which is why it was not done on their behalf.

### What this costs, stated rather than implied

The decision is right about the boundary and **leaves a real gap on the other side of it**:

- **ntfy.sh's free tier has no read ACL.** On a public instance the topic name is the entire access
  control, in both directions. Anyone who learns it can read every alert Pull.fm sends **and** publish
  forgeries into it. 96 bits of entropy makes guessing it infeasible; it does nothing about the topic
  name leaking from a log, a screenshot, a process listing, or a backup.
- **Production alert bodies are not innocuous.** They name hosts and systemd units and carry journal
  tails from a system that holds third parties' credentials. That is reconnaissance material, and
  putting it on a channel with no read control is a weaker position than the one this decision was
  protecting.
- So the credential boundary was fixed and **the confidentiality of the alert stream was not**. The
  first problem was the more dangerous one, and solving it did not solve the second.

### What is still open

**Staging on ntfy.sh is settled.** Staging alerts concern staging, no user credentials are involved,
it costs nothing, and it depends on none of the operator's own infrastructure being reachable.

**Production is not settled, and must not ship on the staging arrangement.** It needs one of:

| Option                               | Note                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| The personal instance, done properly | Dedicated user, publish-only rule scoped to `pullfm-*`, never the `alerter` token. Meets both requirements |
| A separate ntfy instance for Pull.fm | Full control of the ACL, one more thing to run and to keep up                                              |
| A different channel entirely         | Anything ntfy-compatible works with no code change                                                         |
| ntfy.sh as it is now                 | **Not acceptable for production.** No read ACL, and the bodies are worth reading                           |

Whichever is chosen, the change is **one value in 1Password and one command on the node**. Nothing in
this repository has to change, and that property is what made deferring the decision safe rather than
merely convenient.

### Where the operational detail lives

`infra/observability/README.md` section 2 holds the same reasoning next to the scripts that implement
it, plus the file modes, the `--check` behaviour that prints the endpoint host while stripping the
path, and the installer. This entry exists because the decision is a **trust-boundary** decision and
belongs where the trust boundaries are recorded, not only where the shell scripts are. If the two
ever disagree, the scripts are the fact and this entry is wrong.

---

## `SD-002` The alerting credential is write-only and scoped to `pullfm-staging*`

> **SUPERSEDED on 2026-07-29 by [`SD-003`](#sd-003-the-primary-alerting-path-is-a-pull-by-an-observer-outside-our-estate).
> Everything below about the CREDENTIAL is correct and was verified by attempting to violate it. What
> it got wrong is the DESTINATION: it put a product's operational alerting on the operator's personal
> Hetzner box, and it put the alert path inside a failure domain the alerts might need to report on.**
> Left unedited, because its "what this costs" section named both problems accurately on the day it
> created them, and that honesty is the reason they were fixable a few hours later rather than in a
> year. Read `SD-003` for what is true now.

**Decided:** 2026-07-29
**Owner:** `ope@312.dev`
**Applies to:** every environment that can send an alert
**Supersedes:** [`SD-001`](#sd-001-the-alerting-boundary-is-the-credential-not-the-topic)

### What `SD-001` got wrong, and how that was found

`SD-001` reasoned about which credential to put on a Pull.fm node, rejected the operator's `alerter`
token as too broad, and chose anonymous `ntfy.sh` with a 96-bit topic name instead. Its closing
claim is that the credential boundary was fixed and only the confidentiality of the stream was left
open.

**That is backwards, and it was established by probing rather than by reading.** From the staging
node, on 2026-07-29, with the endpoint exactly as deployed:

| Attempted from the Pull.fm node, unauthenticated                    | Result                                     |
| ------------------------------------------------------------------- | ------------------------------------------ |
| Read a topic the node had never been given                          | **200**, the message came back             |
| Read the personal fleet's `box-stack-...` backup and health channel | **200**, and the `/sse` stream stayed open |
| Publish to a topic name invented on the spot                        | **200**                                    |

So the arrangement `SD-001` chose does not have a narrow credential. **It has no credential.** On
`ntfy.sh` an unauthenticated client may read and write every topic on the instance, which makes
anonymous access **strictly broader than the `alerter` token that `SD-001` rejected**: `alerter` is
write-only on three topics, anonymous is read-write on all of them.

And the instance is not Pull.fm's own. `hetzner/box-stack/NTFY_ALERT_URL` records that the personal
fleet's restic-failure alerts and its five-minute health watchdog publish to `ntfy.sh` as well,
confirmed on the box. **Pull.fm and the personal fleet were already sharing an alerting instance,
and that instance has no access control in either direction.** The document that exists to prevent
that coupling had created it.

The failure mode is worth naming because it will recur: **absence of a credential reads as safety.**
"There is no token on the node to steal" sounds like the strongest possible answer to "what can a
stolen token do", right up to the moment somebody asks what an unauthenticated client is permitted
to do, which nobody had.

### What was decided

Staging alerting moves to the operator's **self-hosted** ntfy at `https://ntfy.graysons.network`,
which already runs `auth-default-access: deny-all`, with:

- a **dedicated ntfy user**, `pullfm-staging`, that is not `alerter` and never becomes it;
- **one access rule**: `write-only` on `pullfm-staging*`, and nothing else, anywhere;
- a **bearer token** issued to that user alone, stored as `pull-fm/staging/ALERT_NTFY_TOKEN` and
  delivered to the node by `install-alert-env.sh`, which already read that item and needed no change.

**The scope is per environment, not `pullfm-*` as `SD-001` proposed.** `pullfm-*` would let a
compromised staging node publish forgeries into the production alert topic, which is the same
bury-the-real-alert attack `SD-001` was written about, merely relocated inside Pull.fm. Production
gets its own user and its own `pullfm-prod*` rule; the two never share a token. The cost of the
tighter rule is one extra line on the ntfy server per environment.

### The verification, because a least-privilege claim nobody has attacked is an assumption

Run from the staging node, sourcing the credential from the **deployed** `/etc/pullfm/alert.env`
rather than from a copy:

| Attempt                                                                  | Required | Got     |
| ------------------------------------------------------------------------ | -------- | ------- |
| Read `pullfm-staging` (its own topic - write-only must be literal)       | refused  | **403** |
| Read `security-critical`, `security-warn`, `security-info`               | refused  | **403** |
| Publish to `security-critical`, `security-warn`, `security-info`         | refused  | **403** |
| Publish to the personal fleet's `box-stack-...` topic                    | refused  | **403** |
| Publish to `pullfm-prod`                                                 | refused  | **403** |
| Publish to `pullfm`, `pullfmevil`, `notpullfm-staging` (prefix boundary) | refused  | **403** |
| `GET` and `DELETE /v1/users`                                             | refused  | **401** |
| Publish to `pullfm-staging`                                              | allowed  | **200** |

Delivery was then proven rather than assumed: `pullfm-alert` exited **0**, its spool line records
`"delivered":true,"delivery":"ntfy"`, the message was **read back off the server with a different,
admin credential**, and `pullfm-job-alert` - which reads `alert.env` itself rather than going through
`pullfm-alert` - was fired separately and also arrived. A publish returning 200 is an acknowledgement,
not evidence that anything is on the topic, which is why the read-back is a separate credential.

One honest detail: **`write-only` is not literally true**. The token can read exactly one topic, the
per-account `st_...` sync topic ntfy issues to every user, which nothing else publishes to. Checked in
both directions: the token reads its own and is refused `403` on `alerter`'s and on an invented
`st_...` name.

### What this costs, stated rather than implied

- **`SD-001` was right that `ntfy.sh` needs nobody's infrastructure to be up, and that property is
  now gone.** Pull.fm's only notification path depends on the personal box, its Cloudflare tunnel and
  one container. A box outage and a Pull.fm outage look identical from outside, and the second is
  exactly when the first is least likely to be noticed. Undelivered is at least a recorded fact:
  `pullfm-alert` journals, spools `delivered:false`, and exits 4.
- **Thirty days of alert bodies now sit at rest on shared personal hardware.** `cache-duration` is
  `720h`, and the bodies name hosts, units and journal tails from a node holding third parties'
  credentials. This is a better position than `ntfy.sh`, where they were readable by anyone who
  learned the topic name, but it is not a clean one.
- **The ACL binds the credential, not the node.** The staging node still has unrestricted outbound
  HTTPS, so a compromised node can publish anonymously to `ntfy.sh` regardless of what its token
  allows. Egress filtering is the only fix and it belongs with the production network design.

Both of the first two, and the third, are in the private register as `PULLFM-RISK-014` and
`PULLFM-RISK-015`, with owners and expiry dates.

### What the topic name is now worth

Nothing on its own, and that is the point of the change. Reading requires a token; the only token
issued for `pullfm-staging` cannot read. So the endpoint is **routing, not a capability**, which is
why the stored value is a plain readable `pullfm-staging` rather than 96 bits of entropy and why it
can be written in a runbook. `install-alert-env.sh` still treats it as a secret - `--check` prints
the host and strips the path - and that is now belt-and-braces rather than the control. Anything in
this repository that still says the topic name is the entire access control describes the retired
arrangement.

### What is still open

**Production.** The mechanism is proven and the remaining work is two commands on the ntfy server
(`ntfy user add pullfm-prod`, `ntfy access pullfm-prod 'pullfm-prod*' write-only`), a token, and two
1Password items named `pull-fm/prod/ALERT_NTFY_URL` and `pull-fm/prod/ALERT_NTFY_TOKEN`. No code
changes: `install-alert-env.sh` derives both item titles from `PULLFM_ALERT_ENV_LABEL`.

**The external observer does not exist.** `infra/observability/README.md` section 4 records that a
watchdog on a dead node does not alert. This decision adds a second instance of the same shape: an
alert channel on a box that is not watched by Pull.fm. Both are closed by the one external uptime
checker `docs/PLAN.md` section 9 already names, and by nothing else.

### Where the operational detail lives

`infra/observability/README.md` section 2, next to the scripts. If the two disagree, the scripts and
the ntfy ACL are the facts and this entry is wrong. The ACL is readable at any time with
`ntfy access` on the box and is the single authoritative statement of what Pull.fm can do.

---

## `SD-003` The primary alerting path is a pull by an observer outside our estate

**Decided:** 2026-07-29
**Owner:** `ope@312.dev`
**Applies to:** every environment that can send an alert
**Supersedes:** [`SD-002`](#sd-002-the-alerting-credential-is-write-only-and-scoped-to-pullfm-staging)

### What `SD-002` got wrong

`SD-002` fixed a real problem correctly. The credential it built is narrow, it was verified by
attempting every forbidden operation, and nothing here reverses that. It got two things wrong that
its own cost section named on the day it was written, and naming them is what made them fixable:

1. **A product ended up depending on the operator's personal infrastructure.** `ntfy.graysons.network`
   is a container on a personal Hetzner box that runs roughly thirty unrelated personal services. The
   operator's local-first preference applies to that fleet; it is not a reason for Pull.fm to inherit
   it. For a product, an independent third party beats self-hosting on an unrelated machine.
2. **The worse one, and the general one: an alert path that traverses infrastructure inside a failure
   domain cannot report that domain failing.** It is a burglar alarm wired to the fuse box inside the
   house. This applied to the personal box exactly as it applies to the Pull.fm node.

And the same shape existed one layer down, recorded in `infra/observability/README.md` section 4 and
never fixed: **every detector ran on the node it reported on**, so a dead node produced no alert, and
no alert is precisely what a healthy quiet week looks like. **Silence was indistinguishable from
health.** That is the finding this decision is actually about; the personal box was one instance of it.

### What was decided

**The primary path is now a PULL, performed by a scheduled GitHub Actions workflow in
`312-dev/pullfm-heartbeat`, and the node holds no alerting credential at all.**

| Piece                                                | Where it runs                                    |
| ---------------------------------------------------- | ------------------------------------------------ |
| `pullfm-heartbeat` writes a content-free beat, 5 min | the node                                         |
| nginx serves it at `/.well-known/pullfm-heartbeat`   | the node, but not the application                |
| `deadman.yml` reads the beat and probes the origin   | **GitHub's scheduler**, every 10 min             |
| A GitHub issue plus a red workflow run               | **GitHub**, notifying by email and GitHub Mobile |

The beat carries a timestamp, a count of unacknowledged conditions, and their dedupe keys. It carries
no hostname, no unit names and no journal tails, because it is served publicly; the bodies stay on the
node where `docs/RUNBOOK-JOBS.md` already sends the reader. That is the payload-free push-notification
pattern: the wake-up crosses the open channel and the detail is fetched over an authenticated one.

The push sink is **retained but demoted to optional and made provider-agnostic**.
`PULLFM_ALERT_SINK_URL` is one 1Password item; `pullfm-alert` derives the wire format from the URL and
speaks ntfy, Discord, Slack or generic JSON. Pointing Pull.fm at Grafana OnCall, Pushover or a hosted
ntfy is one value and no code change. It is **unset today**, and that is a deliberate state rather
than an unfinished one: see "what was not done" below.

### What was rejected, and why

Two properties decided everything: **the destination must not be the thing being monitored**, and **a
failure to deliver must itself be detectable**. Cost was the third constraint, because no paid account
could be created and no payment method added.

| Option                                     | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hosted ntfy (ntfy.sh Supporter or Pro)** | The right shape and the wrong price: reserved topics, which are the whole point, start at the Supporter tier at 6 USD a month. Checked on 2026-07-29. No payment could be authorised. The free tier has **no reserved topics**, so it is anonymous ntfy.sh, which `SD-002` measured as read-and-write on every topic on the instance.                                                                                                                                                                                                                                             |
| **Pushover**                               | 5 USD one-off per platform after a 30-day trial. A payment is a payment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Discord, Slack, Telegram webhook**       | Genuinely free and structurally write-only, and any of them is a good choice. All three need an account, a workspace or a BotFather conversation that only the operator can complete, so none could be provisioned or proved today. They are exactly what `PULLFM_ALERT_SINK_URL` exists to accept.                                                                                                                                                                                                                                                                               |
| **Email through a provider**               | Resend, Postmark, Mailgun and friends all need a verified sender and an email-confirmed signup. Sending SMTP straight to the recipient's MX was rejected separately: Hetzner blocks outbound 25 and mail with no SPF or DKIM is mail that lands in spam, which is the opposite of an alert. **Email was in fact chosen - just not with an SMTP credential on the node.** GitHub's own notification email carries the alert, so the mail path exists with no credential to steal, rotate or leak.                                                                                  |
| **Cloudflare Worker plus KV**              | The strongest technical option and **measurably unavailable**: probed on 2026-07-29, every Pull.fm Cloudflare token is refused `Authentication error` on `workers/scripts`, `storage/kv/namespaces` and `workers/subdomain`, and `403` on `accounts/{id}/tokens`, so a suitable token cannot even be minted. Minting one needs the account global API key, and `infra/lib/credentials.sh` refuses to run when that key is present, for reasons recorded in `PULLFM-RISK-005`. Also: Cloudflare already sits in Pull.fm's serving path, so it is partly the thing being monitored. |
| **A dedicated ntfy for Pull.fm**           | One more stateful service to run and patch for a project with no users, and if it runs on the node it monitors it makes the blind spot worse rather than better.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Healthchecks.io free tier**              | Purpose-built for exactly this and 20 checks free. Signup is email-verified, so it could not be provisioned or proved. Worth revisiting: it would replace the workflow with a service whose entire job is this.                                                                                                                                                                                                                                                                                                                                                                   |
| **Probing the node over the tailnet**      | Would work, and reintroduces the coupling this decision removes: the tailnet is the operator's personal one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**GitHub was chosen because the account already exists, is owned by the `312-dev` organisation rather
than by the operator personally, is outside both the Pull.fm node and the personal box, costs nothing
(Actions minutes are unmetered on public repositories), and needed no signup, no card and no
provisioning step a human had to perform.**

### The part that is easy to get wrong, and that a push design gets wrong

A push was built first. It was abandoned on a measurement, and the constraint produced the better
design:

- GitHub deploy keys, the one write credential that **can** be minted by API, are **disabled
  organisation-wide** on `312-dev` (`deploy_keys_enabled_for_repositories: false`). Turning that off
  for the whole organisation to serve one node would weaken every repository in it.
- There is no API that mints a fine-grained PAT or creates a GitHub App, so both need the operator.
- The only writable off-node store the node already reaches is R2, and every existing R2 credential is
  scoped to a bucket it has a reason to touch. Reusing the backups credential as a heartbeat writer
  would have given the heartbeat writer read and delete over every database dump, which is
  `PULLFM-RISK-009` re-committed knowingly.

**So pulling is not a compromise. It is strictly stronger:** the node holds no alerting credential, so
there is none to steal, none to rotate, none to scope wrongly, and nothing a compromised node can
forge, rewrite or delete. A node cannot suppress an alarm it cannot reach. Compare `SD-002`, whose
entire argument was about how narrow to make a credential the node had to hold.

The corollary is that **`on: schedule` was chosen over `on: push` for the same reason**: a scheduled
workflow always executes the copy of the workflow file on the default branch, so there is no version
of this that the monitored side supplies.

### The verification, because an alert channel nobody has fired is a backup nobody has restored

Every line below was run on 2026-07-29, not reasoned about.

**The path works.**

| Step                                                                        | Evidence                                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A real job failure through the real `OnFailure=pullfm-job-alert@%n.service` | `journalctl -t pullfm-job-alert` classified it `could-not-run`              |
| It was recorded as undelivered rather than silently dropped                 | spool line `"delivered":false,"delivery":"none-configured"`                 |
| It reached the beat                                                         | `pending:1, keys:["unit:pullfm-deadman-selftest"]`                          |
| The beat was readable from outside our estate                               | `curl https://api-staging.pull.fm/.well-known/pullfm-heartbeat` -> `200`    |
| The observer raised it                                                      | run `30493917522` failed, issue #1 opened, `TRIPPED: pending-alerts`        |
| A GitHub notification actually arrived                                      | `/notifications` lists it at `21:51:29Z`                                    |
| Acknowledging with `systemctl reset-failed` cleared it                      | next run succeeded, issue **auto-closed** with `RECOVERED`                  |
| A second, independent detector saw the same failure                         | `pullfm-watchdog` fired key `failed-units` and resolved it on its next pass |

**And it fails visibly, which is the half that was broken before.**

| Deliberate breakage                  | Old behaviour                              | Measured new behaviour                                                                                         |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Invalid push-sink token              | `--check` printed `ARMED` and exited **0** | `SINK NOT ARMED: 401`, exit **1**, against a real server's real 401                                            |
| Invalid push-sink token, alert fired | -                                          | `pullfm-alert` exit **4**, `"delivery":"ntfy-failed"`, **and the alert still reached GitHub through the beat** |
| Heartbeat stops (emitter stopped)    | nothing anywhere                           | `--check` -> `NOT ARMED`, observer -> `TRIPPED: stale-heartbeat`, run failed                                   |
| nginx not serving the beat           | nothing anywhere                           | observer -> `TRIPPED: no-heartbeat` (observed for real before the location block existed)                      |

The third row is the whole decision in one line: **a condition that used to produce silence now
produces a notification.**

Three defects in the watcher were found by running it rather than reading it, and each is the same
species as the bug this decision fixes. Its first version was **invalid YAML**, which GitHub reports
as "workflow file issue" while registering no triggers, so the repository looked armed and ran
nothing. Its second read a 404 body as a stale heartbeat, conflating absent with stale. Its third
detected the fault correctly and then died on `gh issue: not a git repository`, so it knew and could
not tell anyone. **A watcher that has not been made to fire is not a watcher.**

### What was NOT done, stated plainly

- **No immediate push destination is configured.** No third-party account could be created, because
  every candidate needs either a payment method or an email confirmation, and neither was available.
  So the destination is a single configuration value - `pull-fm/{env}/ALERT_SINK_URL` - and pointing it
  anywhere is one 1Password edit plus a converge, with no code change. **The consequence is honest and
  it is a real cost: notification latency is one watcher interval, roughly 10 to 20 minutes, rather
  than seconds.** For a pre-launch staging environment with no users that is acceptable. It is not
  acceptable for production, and `PULLFM-RISK-018` says so with a date on it.
- **Two files this change could not edit need three lines each**, and until they land a rebuilt node
  comes back without the heartbeat. That is exactly the failure `PULLFM-RISK-012` recorded, so it is
  tracked as `PULLFM-RISK-019` rather than trusted to memory: `infra/staging/app/bootstrap.sh` must
  install `pullfm-heartbeat` and its units, and `infra/staging/app/nginx-pullfm.conf.in` must serve
  the beat. Both diffs are written out in `infra/observability/README.md` section 3.
- **The `pullfm-staging` ntfy user is left in place on the personal box** and is untouched. Nothing on
  the node references it any more - verified by grepping `/etc/pullfm`, `/usr/local/bin` and
  `/etc/systemd/system` for both `ntfy.graysons.network` and `ntfy.sh` and finding nothing - so it is a
  dormant fallback the operator can delete at leisure, not a dependency.

### What this costs, stated rather than implied

- **The beat is public, and it says which condition is firing.** Dedupe keys are already readable in
  `pullfm-watchdog` and `docs/RUNBOOK-INCIDENT.md`, so the _set_ was never secret, and for most
  conditions the state is observable by curling the origin anyway. But "staging has 3 failing
  conditions right now" is new information available to anyone. Recorded as `PULLFM-RISK-017`.
- **GitHub is now a single point of failure for alerting, and nothing watches the watcher.** A GitHub
  Actions outage means no alerts, and Pull.fm would not know. Scheduled workflows are also
  best-effort and are disabled after 60 days of repository inactivity. The chain has to terminate
  somewhere; it now terminates at a third party with a public status page instead of at one container
  on a personal box. Recorded as `PULLFM-RISK-018`.
- **Detection is slower than a push.** 10 to 20 minutes for a new condition, up to about 40 for a
  stale beat, because the ceiling has to absorb both timers' jitter. A switch that cries wolf gets
  muted, and a muted switch is the silence this decision exists to end.

### Where the operational detail lives

`infra/observability/README.md` sections 2 and 3, next to the scripts, plus
`312-dev/pullfm-heartbeat`. If they disagree with this entry, the scripts and the workflow are the
facts and this entry is wrong.
