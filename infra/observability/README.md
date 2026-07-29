# Observability and alerting

> **Status: the channel is ARMED and PROVEN. Fifteen of the thirty conditions in
> [`../../docs/RUNBOOK-INCIDENT.md`](../../docs/RUNBOOK-INCIDENT.md) section 6 now
> deliver a notification, thirteen of them proven by a synthetic trigger read
> back off a real ntfy server. The rest are blocked, and section 6 says which and
> why per row.**
>
> Before this directory existed there was **no notification channel anywhere in
> this project**. Four scheduled jobs classified their own failures correctly,
> wrote them to a file on a node, and told nobody. That was the single most
> valuable gap in the repository and it is the one this directory closes.

```bash
./install-alert-env.sh --check     # is this node able to tell anyone anything?
./alert-selftest.sh                # prove the channel delivers, end to end
./watchdog-selftest.sh             # prove each synthetic trigger reaches ntfy
make alerts                        # both of the above
```

---

## 1. What is here

| File                          | What it is                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `pullfm-alert`                | **The** notification sender. Everything that alerts goes through it.               |
| `pullfm-watchdog`             | Scrapes the node's own `/metrics` once a minute and fires the section 6 conditions |
| `install-alert-env.sh`        | Writes `/etc/pullfm/alert.env` from 1Password. The one command that arms a node    |
| `alert.env.example`           | The shape of that file. `op://` references, never values                           |
| `alert-selftest.sh`           | Proves the channel delivers, against a real ntfy                                   |
| `watchdog-selftest.sh`        | Proves each detector fires, with negative controls                                 |
| `systemd/`                    | The watchdog unit and timer                                                        |
| `testdata/metrics-sample.txt` | A real captured scrape, used as the self-test fixture                              |

---

## 2. The channel, and the judgement call behind it

**Transport: ntfy.** It was already the transport named in `docs/PLAN.md` and
already referenced by the committed job-failure handler, it is free, it needs no
account, it self-hosts, and the mobile clients are free. Nothing about the
decision was close.

**Instance: the operator's self-hosted ntfy, on a dedicated write-only
credential that cannot touch anything else on it.** That part was close, it was
got wrong once, and the correction is the interesting part.

### The arrangement this replaced, and why it was worse than it looked

Until 2026-07-29 the channel was an **anonymous `ntfy.sh` topic** with 96 bits of
entropy in its name. The reasoning behind that choice is preserved verbatim in
[`../../security/DECISIONS.md`](../../security/DECISIONS.md) `SD-001`: the
operator's personal `alerter` token is a publish credential for the personal
box's `security-critical` / `security-warn` / `security-info` topics, where
CrowdSec, Falco, auditd and AIDE report. Putting that token on a node holding
other people's Last.fm session keys would let a compromise of Pull.fm inject
noise into the channel that reports intrusions on unrelated personal
infrastructure. Drowning the real Falco alert is the standard next move after
landing on a host, so that was a real attack path and rejecting the token was
correct.

**Choosing anonymous `ntfy.sh` instead was not.** Probed from the staging node,
against the endpoint exactly as deployed:

```
read a topic the node was never given            -> 200, message returned
read the personal fleet's box-stack-... channel    -> 200, and /sse stayed open
publish to a topic name invented on the spot     -> 200
```

Anonymous access on `ntfy.sh` is **read and write on every topic on the
instance**. That is strictly broader than the `alerter` token it was chosen over:
`alerter` is write-only on three topics, anonymous is read-write on all of them.
And `hetzner/box-stack/NTFY_ALERT_URL` shows the personal fleet's restic-failure
and health-watchdog alerts publish to `ntfy.sh` too, so Pull.fm and the personal
fleet were **already sharing an instance with no access control in either
direction**. The decision written to prevent that coupling had produced it.

The lesson, because it generalises: **absence of a credential reads as safety.**
"No token on the node to steal" answers the wrong question. The right one is what
an unauthenticated client is permitted to do, and on a public ntfy the answer is
everything.

### What is in place now

The self-hosted instance at `https://ntfy.graysons.network` already runs
`auth-default-access: deny-all`, so every publisher and subscriber needs an
explicit grant. Pull.fm has exactly one:

| Item        | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| ntfy user   | `pullfm-staging` - not `alerter`, and never becomes it                 |
| Access rule | `write-only` on `pullfm-staging*`. There is no second rule             |
| Credential  | A bearer token issued to that user, `pull-fm/staging/ALERT_NTFY_TOKEN` |
| Topic       | `pullfm-staging`                                                       |

**The scope is per environment rather than `pullfm-*`.** A `pullfm-*` rule would
let a compromised staging node publish forgeries into the production alert topic,
which is the bury-the-real-alert attack above relocated inside Pull.fm.
Production gets `pullfm-prod` with its own user, its own token and its own
`pullfm-prod*` rule.

The delivery path is unchanged and needed no code edit: `install-alert-env.sh`
already read both `pull-fm/{env}/ALERT_NTFY_URL` and
`pull-fm/{env}/ALERT_NTFY_TOKEN`, and `pullfm-alert` already sent the token as a
bearer header when one is present.

### Verified by attempting to violate it

A least-privilege claim that has not been attacked is an assumption. Run from the
staging node with the credential sourced from the deployed `/etc/pullfm/alert.env`:

```
READ  pullfm-staging      403     # write-only is literal
READ  security-critical   403     # and -warn, -info
WRITE security-critical   403     # and -warn, -info
WRITE box-stack-...         403     # the personal fleet's own channel
WRITE pullfm-prod         403     # staging cannot forge a production alert
WRITE pullfm / pullfmevil / notpullfm-staging   403    # prefix boundary holds
GET, DELETE /v1/users     401
WRITE pullfm-staging      200     # the one thing it may do
```

Then the positive case, proven rather than assumed: `pullfm-alert` exited **0**,
its spool line reads `"delivered":true,"delivery":"ntfy"`, and the message was
**read back off the server with a different, admin credential**. A 200 on publish
is an acknowledgement, not evidence anything landed, which is why the read-back
uses a credential that is allowed to read. `pullfm-job-alert`, which sources
`alert.env` itself instead of going through `pullfm-alert`, was fired separately
and also arrived.

Re-run any of this at any time; the ACL is authoritative and self-describing:

```bash
ssh root@<box> 'docker exec $(docker ps --format "{{.Names}}" | grep ^ntfy-) ntfy access'
```

One honest detail: **`write-only` is not literally true.** The token can read one
topic, the per-account `st_...` sync topic ntfy issues to every user, which nothing
else publishes to. It is refused `403` on `alerter`'s sync topic and on an
invented `st_...` name, so it is scoped to its own account rather than to `st_*`.

### What the topic name is worth now, which is different from before

**Nothing on its own.** Reading requires a token and the only token issued cannot
read, so the endpoint is routing rather than a capability. That is why the stored
value is a plain `pullfm-staging` instead of 96 bits of entropy and why it is
safe to write in a runbook.

`install-alert-env.sh` still treats it as a secret - the file is 0600 root-owned,
never printed, never logged, never passed as an argv where `ps` would show it, and
`--check` prints the endpoint host while stripping the path. That is now defence
in depth rather than the control. **Anywhere in this repository that still says
"on ntfy the topic name is the entire access control" is describing the retired
arrangement**, and is true only of a public instance.

### KNOWN GAP created by this change: `--check` now reports ARMED on a node that cannot deliver

**This is the one thing to fix next in this directory.** It is written here rather
than fixed in place only because `install-alert-env.sh` is not this change's to
edit.

Moving to an authenticated endpoint made the token mandatory, and neither the
installer nor `--check` knows that:

- `install-alert-env.sh` resolves the token with `|| true`, which was correct when
  an anonymous instance was legitimate. If `pull-fm/{env}/ALERT_NTFY_TOKEN` is
  missing it writes `PULLFM_NTFY_TOKEN=` and prints `armed`.
- `--check` deliberately reports on the FILE rather than the network. With an
  empty token it prints `ARMED` and exits 0.
- Measured: that node is refused **403 on every publish**.

`pullfm-alert` still exits 4 and spools `"delivered":false`, so it is not silent
at the moment of an alert. But the two commands whose entire job is to answer
"can this node tell anyone anything" both answer **yes** when the answer is no,
and `docs/RUNBOOK-INCIDENT.md` section 10 records that this project has twice
shipped a control that looked configured and was absent.

Two fixes, both small. First, refuse to write an unauthenticated env file unless
that is explicitly what was wanted:

```bash
TOKEN=$(opfield "${TOKEN_ITEM}" password || true)
[ -n "${TOKEN}" ] || [ "${PULLFM_ALLOW_ANONYMOUS_NTFY:-0}" = 1 ] || {
  echo "install-alert-env.sh: ${TOKEN_REF} resolved to an empty value." >&2
  echo "The endpoint runs auth-default-access: deny-all (DECISIONS.md SD-002), so" >&2
  echo "an empty token writes a node that reads as ARMED and is refused 403 on" >&2
  echo "every publish. Create the item, or set PULLFM_ALLOW_ANONYMOUS_NTFY=1." >&2
  exit 65
}
```

Second, make `--check` ask the server instead of the filesystem. ntfy has an
authorization probe that **stores nothing and wakes nobody**: an empty-body POST
with `Cache: no` and `Firebase: no`. Verified on 2026-07-29 by firing it three
times and confirming the topic's stored message count did not move.

```bash
  probe=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
    -H 'Cache: no' -H 'Firebase: no' -H 'Content-Length: 0' \
    ${PULLFM_NTFY_TOKEN:+-H "Authorization: Bearer ${PULLFM_NTFY_TOKEN}"} \
    "${PULLFM_NTFY_URL}")
  case "${probe}" in
    200) echo "ARMED: ${DEST} (${perms}), endpoint host ${host}, publish authorised" ;;
    401) echo "NOT ARMED: the token is invalid. Re-run the installer."; exit 1 ;;
    403) echo "NOT ARMED: the credential may not publish to this topic (missing or wrong-scoped token)."; exit 1 ;;
    *)   echo "NOT ARMED: endpoint unreachable (curl said '${probe}')."; exit 1 ;;
  esac
```

That turns `--check` from a statement about a file into the statement it claims
to make, and it is the difference between `make alerts-armed` being a control and
being a formality.

### What this costs

Recorded in full in `SD-002` and in the private risk register as
`PULLFM-RISK-014` and `PULLFM-RISK-015`. In short:

- **The independence is gone.** `SD-001` was right that `ntfy.sh` needs nobody's
  infrastructure to be up. Pull.fm's only notification path now depends on the
  personal box, its Cloudflare tunnel and one container, and a box outage is
  hardest to notice at exactly the moment it matters. Undelivered is still a
  recorded fact: journal, `delivered:false` in the spool, exit code 4.
- **Thirty days of alert bodies sit at rest on shared personal hardware**
  (`cache-duration: 720h`), and those bodies name hosts, units and journal tails.
  Better than being world-readable to anyone who learns a topic name, not clean.
- **The ACL binds the credential, not the node.** Outbound HTTPS from the node is
  unrestricted, so a compromised node can still publish anonymously to `ntfy.sh`
  whatever its token allows. Egress filtering is the fix and belongs with the
  production network design.

### Related, and already recorded

`docs/PLAN.md` section 10 records the same class of problem in the other
direction: "**Blast-radius isolation is partially false.** The Hetzner project is
isolated; the Cloudflare account is shared with the personal fleet." Alerting is
now the second entry on that list, deliberately and with an expiry date, rather
than accidentally and undocumented as it was before.

---

## 3. Arming a node

```bash
# 1. On the operator's machine, with `op` signed in.
PULLFM_ALERT_ENV_LABEL=staging ./infra/observability/install-alert-env.sh --stdout |
  ssh root@NODE 'install -m 0600 -o root -g root /dev/stdin /etc/pullfm/alert.env'

# 2. On the node, prove it rather than assume it.
/usr/local/bin/pullfm-alert --key arm-test \
  --title 'Pull.fm channel test' --message "armed at $(date -u +%FT%TZ)"
```

Step 2 is not optional and not ceremony. `docs/RUNBOOK-INCIDENT.md` section 10
records that this project has twice shipped a control that looked configured and
was absent, and an alert channel nobody has fired is the same defect as a backup
nobody has restored.

### What `bootstrap.sh` needs, for whoever owns `infra/staging/`

This directory deliberately does not edit `infra/staging/app/bootstrap.sh`.
Three lines are needed there:

```bash
install -m 0755 ../observability/pullfm-alert    /usr/local/bin/pullfm-alert
install -m 0755 ../observability/pullfm-watchdog /usr/local/bin/pullfm-watchdog
install -m 0644 ../observability/systemd/pullfm-watchdog.{service,timer} /etc/systemd/system/
systemctl enable --now pullfm-watchdog.timer
```

Plus two things that are not this directory's to change:

1. **`/etc/pullfm/alert.env` must exist before the timers can notify anyone.**
   It is a secret, so it travels the same path `bff.env` does (over SSH, after
   the node exists, never through Terraform `user_data`, which is persisted in
   state and readable from the Hetzner API for the life of the server).
2. **`nginx` should deny `/metrics` at the edge.** The application already
   refuses any non-loopback caller without `METRICS_TOKEN`, so this is
   defence in depth rather than the control, but `location = /metrics { deny
all; }` costs nothing and removes the endpoint from the attack surface
   entirely:

   ```nginx
   location = /metrics { deny all; return 404; }
   ```

---

## 4. What the watchdog can and cannot see

It runs **on the node**. That buys credential-free loopback access to `/metrics`
and one permanent blind spot:

> **A watchdog on a dead node does not alert.**

So A1 (external health check), A3 (edge 5xx rate) and A4 (origin unreachable
from the edge) are **not armed and cannot be armed from here**. They need a
checker outside our infrastructure. `docs/PLAN.md` section 9 already names that
as the retained capability behind the deferred self-hosted monitoring stack:
"Full observability, plus **one external uptime checker outside our
infrastructure**." That checker does not exist yet, and until it does the honest
statement is that Pull.fm cannot tell anyone its node is gone.

The watchdog's own `/healthz` check is a **backstop for a crashed container on a
live node**, and its alert text says so, so it is not mistaken for A1.

---

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
