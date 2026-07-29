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

| ID       | Decision                                                                 | Status                                 |
| -------- | ------------------------------------------------------------------------ | -------------------------------------- |
| `SD-001` | Alerting runs on its own credential, not on the operator's personal ntfy | Decided. Production channel still open |

---

## `SD-001` The alerting boundary is the credential, not the topic

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
