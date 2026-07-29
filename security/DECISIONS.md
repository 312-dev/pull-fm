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

| ID       | Decision                                                                  | Status                                                        |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `SD-001` | Alerting runs on its own credential, not on the operator's personal ntfy  | **Superseded by `SD-002`.** Its premise was measurably wrong  |
| `SD-002` | Alerting runs on a write-only ntfy credential scoped to `pullfm-staging*` | Decided and implemented. Verified by attempting to violate it |

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
