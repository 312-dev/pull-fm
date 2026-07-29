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

**Instance: NOT the operator's personal one, and not hardcoded anywhere.** That
part was close, and it is worth writing down properly.

### The obvious option, and why it was rejected

The operator runs an ntfy instance on a personal Hetzner box, with a publish
token already in the same 1Password vault this project reads its secrets from.
Wiring Pull.fm into it is about four minutes of work. The argument for it is
real: it is already monitored, the operator already has the app installed and
already looks at it, and an alert channel the operator actually reads is worth
more than a technically-cleaner one they do not.

The argument against is specific rather than architectural, and it is what
decided it.

**That token is not scoped to a topic Pull.fm would own.** The 1Password entry
for it records what it is: a write-only publish token for the personal box's
`security-critical`, `security-warn` and `security-info` topics, used by
CrowdSec, Falco, auditd, AIDE and the canary handlers. Its note says, correctly,
that write-only is the design so that a compromised container can inject noise
but cannot read the detection stream.

Now put that token on a Pull.fm node. A Pull.fm node stores **other people's
Last.fm session keys**, which do not expire, and other people's ListenBrainz
tokens. It is a more attractive target than anything else on the personal
network, and a compromise of it would hand the attacker publish access to the
channel that reports intrusions on the personal box. Injecting noise into a
detection feed is not a theoretical concern; drowning the real Falco alert is
the standard next move after landing on a host.

So the coupling is not "two systems share a notification service". It is "the
system holding third-party credentials can suppress the detection of its own
compromise spreading". That is a real attack path created by a convenience.

### Is a dedicated topic enough isolation?

**No, and this is the part most likely to be got wrong.** A dedicated
`pullfm-alerts` topic sounds like the answer and does not address any of the
above, because on ntfy the isolation boundary is the **credential**, not the
topic. A token that can publish to `pullfm-*` and to `security-*` gives the same
blast radius whichever topic Pull.fm actually uses.

The minimum acceptable form of "use the personal instance" is therefore:

- a **dedicated ntfy user** for Pull.fm, and
- a **publish-only access rule** on `pullfm-*` and nothing else, and
- a token that is not the `alerter` token and never becomes it.

That is a five-minute change on the ntfy instance and it is the operator's to
make, on their infrastructure, awake, with their own eyes on the ACL. It is not
something to do on their behalf overnight, so it was not done.

### What was done instead

The channel is **injected at deploy time and absent from git**:

- `pullfm-alert` reads `PULLFM_NTFY_URL` from `/etc/pullfm/alert.env`. It has no
  default and no fallback.
- `alert.env` is written by `install-alert-env.sh` out of 1Password, at 0600,
  root-owned, and is never printed, logged, or passed as an argv (where `ps`
  would show it to every user on the box).
- The value currently stored is a **dedicated ntfy.sh topic with 96 bits of
  entropy in its name**, created for this project and used by nothing else.

**On a public ntfy instance the topic name is the entire access control.**
Anyone who learns it can read every alert Pull.fm sends and publish forgeries
into it. That is why the URL is treated as a credential in both directions, why
this repository never contains it, and why `--check` prints the endpoint host
but strips the path.

### What the operator should decide when awake

| Question                                  | Recommendation                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep ntfy.sh for **staging**?             | Yes. Staging alerts concern staging. No user credentials are involved, it costs nothing, and it depends on none of the operator's own infrastructure being up.                                                |
| Use ntfy.sh for **production**?           | **No.** Production alert bodies name hosts, units and journal tails from a system holding third-party credentials. That belongs on an instance with a read ACL, which the free tier of ntfy.sh does not have. |
| Use the personal instance for production? | Acceptable **only** with a dedicated user and a publish-only rule scoped to `pullfm-*`. Never the `alerter` token.                                                                                            |
| Something else?                           | Any ntfy-compatible endpoint works with no code change. Change one 1Password value and re-run the installer.                                                                                                  |

Whatever is chosen, the change is one value in 1Password and one command on the
node. Nothing in this repository has to be edited, which is the property that
made deferring the decision safe.

### Related, and already recorded

`docs/PLAN.md` section 10 already records the same class of problem in the other
direction: "**Blast-radius isolation is partially false.** The Hetzner project is
isolated; the Cloudflare account is shared with the personal fleet." Alerting was
about to become the second entry on that list. It is not.

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
