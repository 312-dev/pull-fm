# Runbook: deploying (Gates D and 6)

> **Gate D criterion:** a commit to `main` reaches prod through staging with a
> migration step and **a rollback verified by executing one**, with no manual SSH.
>
> **Status: PARTIAL.** `main` -> staging is automatic and externally verified.
> Prod has never been applied, and **no rollback has been executed**, so the half
> of Gate D that is the interesting half is untested. Where this runbook
> describes something that has not been done, it says so.

---

## 1. The shape of it: the deploy is a pull

CI never connects to the node. **The node polls.**

```
commit to main
  -> GitHub Actions builds and publishes ghcr.io/312-dev/pull-fm/bff:main
  -> pullfm-deploy.timer on the node fires every 60s
  -> pullfm-deploy resolves :main to an immutable digest
  -> no-op if that digest is already running
  -> runs forward migrations WITH THE NEW IMAGE
  -> swaps the container
  -> CI polls https://api-staging.pull.fm/healthz until .version == the commit SHA
```

**Why pull and not push.** A push deploy needs an inbound path to the origin and
a CI credential with shell access to the node holding every user's third-party
credentials. The entire ingress posture exists to ensure neither. CI verifies
from the **public URL** instead, which is a stronger claim: a deploy job that
connects to a node and reports its own exit code proves the deployer ran, whereas
a healthz poll that returns the SHA just built proves that commit is serving real
traffic through Cloudflare, the load balancer, nginx, and the container.

**Migrations run with the new image, before it takes traffic.** Not from a
separate migration image, so the schema and the code that expects it can never be
deployed apart. A migration failure **stops the deploy** and the old container
keeps serving, which is the correct outcome: a schema this build cannot get into
place is a build that must not run.

---

## 2. Normal deploy: what you do

Nothing. Merge to `main`.

```bash
git push origin main
gh run watch                             # the workflow polls healthz itself
curl -sS https://api-staging.pull.fm/healthz | jq -r .version
git rev-parse HEAD                       # these two must match
```

Measured end to end: image build about 2 minutes warm, registry poll up to 60
seconds, container start about 15 seconds. The budget is 10 minutes.

**A deploy is currently a container recreate**, so there is a brief connection
refusal. Zero-non-2xx rolling deploys are Gate 6 and need the second application
node.

---

## 3. Deploying a migration

Rules that are not negotiable, in order of how expensive violating them is:

1. **Every migration is reversible and its down path is tested.** Gate 1 runs
   **two** full up/down cycles, because a migration can be reversible once and
   still leave residue that breaks the second application, and that failure only
   surfaces during a production rollback, which is the worst possible moment.
2. **Additive first.** Add a column, deploy code that writes both, backfill,
   then deploy code that reads the new one, then drop the old one. Four deploys.
   A rename in one step means the old container and the new schema coexist for
   the length of the swap and one of them is wrong.
3. **A destructive migration is a separate deploy from the code that stops using
   the thing.** Otherwise rollback is impossible: the code rolls back, the data
   does not.
4. **`CHECK` constraints are a feature here.** The schema refuses a Deezer
   preview without an expiry, a ciphertext column too short to be valid GCM, and
   a token hash that is not a 64-character hex digest. A migration that would
   need to relax one of those is a design question, not a migration.

```bash
node packages/db/scripts/verify-migrations.mjs   # 12 checks, Gate 1
```

---

## 4. Verifying a deploy actually deployed

```bash
# 1. The public claim.
curl -sS https://api-staging.pull.fm/healthz | jq .
# { "status": "ok", "uptimeSeconds": ..., "version": "<commit sha>" }

# 2. Dependencies, named individually so a failure does not need a log dive.
curl -sS https://api-staging.pull.fm/readyz | jq .
# { "status": "ready", "checks": { "database": "ok", "redis": "ok" } }

# 3. On the node, if you have break-glass access (section 7).
journalctl -u pullfm-deploy --since '-15min'
docker compose -f /opt/pullfm/docker-compose.yml ps
```

`uptimeSeconds` resetting is the signal that a swap happened. `version` not
advancing after a merge means the deploy did not take: check the timer, then the
migration step in the journal.

---

## 5. Rollback

**Never executed. Gate D requires executing one, and that is the open half of the
gate.** What follows is the intended procedure, written so the first execution is
a rehearsal rather than an improvisation.

### If the code is bad and the schema is unchanged

The previous image is kept locally on purpose, so a rollback is a local retag
rather than a registry round trip. Image pruning only removes images older than
72 hours.

```bash
# On the node:
docker images ghcr.io/312-dev/pull-fm/bff --digests   # find the previous digest
printf 'BFF_IMAGE=%s\n' "<previous-digest>" > /etc/pullfm/deploy.env
cd /opt/pullfm && docker compose --env-file /etc/pullfm/deploy.env up -d
curl -fsS http://127.0.0.1:3000/healthz
```

**Then stop the timer, or it will re-deploy the bad build within 60 seconds:**

```bash
systemctl stop pullfm-deploy.timer
```

That is the step this procedure exists to make sure nobody forgets. The pull
model is a virtue everywhere except here, where it will happily undo a rollback.

The real fix is to revert on `main` and let the normal path deploy the revert.
The manual rollback buys the minutes in between.

### If the schema is bad

Harder, and the reason rule 3 in section 3 exists.

1. `MAINTENANCE_MODE=true` first. A half-rolled-back schema serving traffic is
   worse than downtime.
2. Run the down migration **from the image that applied the up migration**, not
   from an older one.
3. Roll the container back.
4. Only then clear maintenance.

If the down migration fails, this is a restore, not a rollback:
[`RUNBOOK-DR.md`](RUNBOOK-DR.md).

### If data is already wrong

Stop. Do not roll forward "to fix it". `RUNBOOK-DR.md` section 3 covers
point-in-time recovery, and the decision of which one to use belongs to whoever
is calmest, which after a bad deploy is usually not the person who shipped it.

---

## 6. Maintenance mode

```bash
# In /etc/pullfm/bff.env on the node:
MAINTENANCE_MODE=true
cd /opt/pullfm && docker compose --env-file /etc/pullfm/deploy.env up -d
```

Application routes return **503 with `Retry-After: 300`**. `/healthz` still
returns 200, so the orchestrator can distinguish intentional downtime from a
crash. Verified by test; the Gate 6 assertion (100% of requests within 60
seconds, in both directions) needs a live host and has not been measured.

`[OPEN]` **The Cloudflare maintenance worker described in `PLAN.md` section 10
does not exist.** There is no Worker in the repository and no external health
check service. Until both exist, maintenance mode is a manual, on-the-node
operation, and the auto-degradation story in
[`RUNBOOK-INCIDENT.md`](RUNBOOK-INCIDENT.md) section 1 is a design intent rather
than a deployed control. This matters most in the scenario it was designed for:
the origin being unreachable is exactly when you cannot set an environment
variable on it.

---

## 7. Break-glass SSH

There is **no standing interactive path to the node**. The firewall carries no
port 22 rule, and Tailscale is not installed because `tailscale_auth_key` is
empty in every committed configuration. Routine operation needs none, because the
deploy loop pulls.

To get in:

```bash
# 1. Add your current /32 to a LOCAL terraform.tfvars (never committed):
#      ssh_allowlist_cidrs = ["203.0.113.7/32"]
cd infra/terraform/envs/staging && terraform apply

# 2. Do the thing.
ssh root@<node>

# 3. Take it back out, and apply again. This step is the one that gets skipped.
```

Leaving the rule in place is a real finding, not untidiness: it converts a
zero-inbound posture into an allowlisted one, and the allowlist is a home IP that
changes.

**This is also the gap behind Gate 4.** A way in for a human is not a rebuild.
See [`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 2.

---

## 8. Deploying infrastructure

```bash
cd infra/terraform/envs/staging
terraform plan -detailed-exitcode     # exit 0 = no drift; this IS the Gate 0 check
terraform apply
```

- Applies run on a **per-environment scoped Cloudflare token**.
  `infra/lib/credentials.sh` **refuses to run** when `CLOUDFLARE_API_KEY` or
  `CLOUDFLARE_EMAIL` are present, because the provider silently prefers the
  global key when both are set, and that regression would otherwise be invisible
  while every artifact in the repository still looked correct.
- **`envs/staging` state is in R2. `envs/shared` and `envs/prod` state is local**,
  which means losing the laptop orphans the zone TLS posture. Migrating both is
  an open task.
- Staging is ephemeral. `./infra/staging-env.sh up` before a gate run, `down`
  after. `down` destroys the servers, the load balancer, the private network,
  **the four Terraform-managed DNS records**, and all staging Postgres data;
  `up` recreates all of it. The R2 backup bucket survives.

**`up` does not currently produce a working environment.** Terraform's job ends
at a booted node; nginx, the origin certificate, the container, and the deploy
timer are applied by hand. Measured 2026-07-29: `up` completed in 45 seconds and
`/healthz` returned **HTTP 525 for five minutes**. See
[`RUNBOOK-DR.md`](RUNBOOK-DR.md) section 2 and `PLAN.md` section 10d.

---

## 9. Releases (Gate R)

**Nothing exists yet.** Distribution is GitHub Releases rather than app stores
(`PLAN.md` section 11.6), which moved obligations rather than removing them:

- Every artifact must be **signed**, and the signature must verify against a
  published key.
- A rebuild from the tagged commit must **reproduce byte-identical artifacts**.
- The signing key is a critical secret with **the same escrow requirement as the
  KEK** (`PULLFM-RISK-003`): two independent copies, and a written procedure for
  what happens if it is lost, because losing it strands every existing install on
  a key nobody can renew.
- There is **no automatic update channel**, which makes `GET /v1/config`
  min-supported-build enforcement more important than it would be on a store, not
  less.

A store rejects a bad build. GitHub Releases does not, so signing and
reproducibility are the only things between a user and a substituted artifact.

---

## 10. Prod

`envs/prod` **has never been applied.** When it is, the differences that matter:

|                                       | Staging                                                       | Prod                                         |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `delete_protection` (db, LB, network) | `false` by design                                             | **`true`**                                   |
| Lifecycle                             | ephemeral, destroyed after gate runs                          | permanent                                    |
| Token prefix issued                   | `pfm_test`                                                    | `pfm_live`                                   |
| Hostname                              | `api-staging.pull.fm` (one label; two-label has no edge cert) | `api.pull.fm`                                |
| Terraform state                       | R2                                                            | R2, and it must be R2 before the first apply |

**The token prefix follows the data environment, not `NODE_ENV`.** Staging runs
`NODE_ENV=production` and still issues `pfm_test`, because what the prefix has to
communicate is "whose data does this reach".

Gate D does not close until a commit reaches prod through staging **and a
rollback has actually been executed**, not documented.
