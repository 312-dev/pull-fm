# Pull.fm staging - configuration management

Terraform stops at "a booted node with a stable private address, an attached
firewall and a load balancer in front of it". This directory is everything
after that: TLS termination, the data plane, and the deploy loop.

Two nodes, both `cpx12` (2 vCPU / 2 GB) in `hel1`:

| Node                   | Private IP | Runs                                                  |
| ---------------------- | ---------- | ----------------------------------------------------- |
| `pullfm-staging-app-1` | 10.20.1.11 | nginx (TLS origin), BFF container, deploy agent       |
| `pullfm-staging-db-1`  | 10.20.1.21 | Postgres 17, Redis cache, Redis quota. No public IPv4 |

---

## Deviation from the plan: Compose, not Nomad

`docs/PLAN.md` section 1 locks Nomad as the orchestrator. Staging runs **Docker
Compose under systemd** instead. This is a deliberate, recorded deviation and
it is scoped to staging.

**Why.** Nomad's value is scheduling work across a fleet: bin packing, rolling
updates across nodes, service discovery, failover. Staging is one application
node. A single-node Nomad cluster is a server and a client agent on the same
box, consuming 200-300 MB of a 2 GB machine to schedule exactly one task onto
exactly one place it could possibly go. It buys no capability that is exercised
here, and every megabyte it takes comes out of Postgres' page cache or the
BFF's heap.

**What is lost.** Nomad variables as a secret store, and per-task resource
isolation as a scheduler concern. Both are replaced rather than dropped:
secrets are root-owned `0600` env files placed from 1Password, and every
service declares `mem_limit` and `cpus`, so a runaway task still hits its own
cgroup rather than the kernel OOM killer.

**Migration path back.** The unit of deployment is an OCI image pinned by
digest, configured entirely through environment variables. A Nomad job spec is
a mechanical translation of `app/docker-compose.yml`: `image` -> `config.image`,
`env_file` -> a `template` block with `env = true` reading `nomad/jobs/pullfm`,
`mem_limit`/`cpus` -> `resources`. Nothing in the application knows which one is
running it. The trigger to make that move is a second application node, which
is also what Gate 6's rolling-deploy criterion requires, so the two arrive
together.

---

## Ingress path, and the two non-obvious hazards

```
client -> Cloudflare edge -> Hetzner LB (TCP passthrough + PROXY) -> nginx :443 -> BFF :3000
```

**PROXY protocol is mandatory at the origin.** The load balancer is configured
with `proxyprotocol = true`, so every connection begins with a PROXY header. A
listener that does not expect it reads that header as the first line of an HTTP
request and returns 400 on every single connection - a failure that looks like
an application bug and is not one. This is why `enable_proxy_protocol` and the
`proxy_protocol` parameter on the nginx `listen` directives have to be changed
together, in that order, and never independently.

**The origin firewall does not protect the load-balanced path.** Load balancer
traffic reaches the node on the _private_ interface, and Hetzner Cloud
Firewalls filter the public interface only. Hetzner also cannot attach a
firewall to a load balancer. So "only Cloudflare may reach the origin" is
enforced at nginx, on `$proxy_protocol_addr`, against Cloudflare's published
ranges - not by the Terraform firewall rule, which covers only the case of
someone dialling the origin IP directly.

Three layers, none of which is redundant with the others:

1. **Origin firewall** - inbound 80/443 from Cloudflare ranges only. Covers a
   direct-to-origin connection that bypasses the load balancer.
2. **nginx allowlist on `$proxy_protocol_addr`** - covers the load-balanced
   path, which layer 1 cannot see. Refreshed daily by `pullfm-cf-ranges.timer`;
   the script refuses to install a suspiciously short list, because a truncated
   fetch would lock out every real user.
3. **Authenticated Origin Pulls** - mTLS. Cloudflare presents a client
   certificate and nginx refuses the handshake without one. The origin-pull CA
   is shared by every Cloudflare customer, so the config additionally requires
   the subject to be `CN=origin-pull.cloudflare.net`; the issuer alone would
   prove only that the peer is _somebody's_ Cloudflare.

---

## Deploy: pull, not push

A commit to `main` triggers `.github/workflows/deploy-staging.yml`, which
builds `ghcr.io/312-dev/pull-fm/bff:main` and then **verifies from outside**
that staging is serving it. It never connects to the node.

The node deploys itself. `pullfm-deploy.timer` fires every 60 seconds and runs
`/usr/local/bin/pullfm-deploy`, which resolves the tag to a digest, exits if it
is already running, applies forward migrations **with the new image**, and only
then swaps the container.

**Why a pull.** A push deploy needs an inbound path to the origin and a
long-lived credential in CI that can execute commands on the box. The entire
ingress posture exists so that neither is true: there is no public SSH, and the
only credential CI holds is a scoped registry token that can push an image and
nothing else. A leaked `GITHUB_TOKEN` from a workflow run gets an attacker a
package push, not a shell on the machine holding every user's OAuth tokens.

**Why this is stronger evidence, not weaker.** A push job proves the deployer
ran. `deploy-staging.yml` polls `https://api-staging.pull.fm/healthz` until
`.version` equals the commit SHA, which proves the new code is serving real
traffic through Cloudflare, the load balancer, nginx and the container. It
cannot pass by reporting its own success.

Migrations run from inside the deployed image, so the schema and the code that
expects it can never ship apart. A failed migration aborts the deploy and the
previous container keeps serving, which is the correct outcome.

**Deploy latency:** image build (about 2 minutes warm) + up to 60 seconds of
poll + about 15 seconds to start. Comfortably inside Gate 0's ten minutes.

**Known gap (Gate 6, not Gate 0):** `docker compose up -d` recreates the
container, so a deploy is a brief connection refusal rather than a rolling
update. Gate 6 requires zero non-2xx under load during a deploy, and that needs
the second application node. Recorded rather than hidden.

---

## Bootstrapping a node

Both scripts are idempotent. Neither contains a secret, and both refuse to run
if the secret files they depend on are missing.

```bash
# Database node (reached through the app node; it has no public IPv4)
scp -J pullfm@<app-ip> db.env pullfm@10.20.1.21:/tmp/
ssh -J pullfm@<app-ip> pullfm@10.20.1.21
sudo install -d -m 0751 /etc/pullfm && sudo install -m 0600 /tmp/db.env /etc/pullfm/db.env
sudo bash bootstrap.sh

# Application node
sudo bash bootstrap.sh   # needs /etc/pullfm/bff.env and /etc/ssl/pullfm/*
```

**In normal operation nobody runs the above by hand.**
`./infra/staging-env.sh converge` does exactly this over the tailnet, with the
secrets rendered from 1Password into a self-deleting `0700` directory. The
manual form is documented because it is what converge does, not because it is
the procedure.

### Files that are never in git

| Path                                   | Contents                                        | Source                                            |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `/etc/pullfm/bff.env`                  | DATABASE_URL, REDIS urls, KEK, WorkOS key       | 1Password `pull-fm/staging/*`                     |
| `/etc/pullfm/db.env`                   | Postgres and Redis passwords                    | 1Password `pull-fm/staging/*`                     |
| `/etc/pullfm/redis/{cache,quota}.conf` | Rendered by `db/bootstrap.sh`; carry a password | generated                                         |
| `/etc/ssl/pullfm/origin.{pem,key}`     | Cloudflare Origin CA certificate and key        | 1Password `pull-fm/staging/ORIGIN_CA_PRIVATE_KEY` |
| `/etc/pullfm/deploy.env`               | The running image digest                        | written by `pullfm-deploy`                        |

---

## Redis: two instances, and why it is not one with two databases

`redis-cache` is `allkeys-lru`; losing a key there is a cache miss. `redis-quota`
is `noeviction`, because eviction policy in Redis is **per instance, not per
database**. Rate-limit counters sharing an `allkeys-lru` instance with the
cache are silently evicted by any cache-fill event, after which every rate
limit fails **open** with no error and no alert. See `security/THREAT-MODEL.md`
T11 and the comment on `REDIS_QUOTA_URL` in `apps/bff/src/config.ts`.

Verify:

```bash
redis-cli -h 10.20.1.21 -p 6379 -a "$CACHE_PW" config get maxmemory-policy  # allkeys-lru
redis-cli -h 10.20.1.21 -p 6380 -a "$QUOTA_PW" config get maxmemory-policy  # noeviction
```

---

## Rebuilding: `up` produces a serving node, unattended

`./infra/staging-env.sh up` is one command and there is no human step in it:

```
terraform apply          19 resources, about 45 seconds
wait for cloud-init      packages, docker, nginx, Tailscale, directory layout
converge                 secrets from 1Password over SSH, then bootstrap.sh
verify                   poll https://api-staging.pull.fm/healthz for HEAD
```

### The division of labour, and why it falls where it does

The split is by **secrecy**, not by convenience.

| Stage          | Carries                                             | Why there                                                                                                                                                              |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cloud-init** | packages, docker, nginx, the tailnet, `/etc/pullfm` | `user_data` is persisted in Terraform state and readable from the Hetzner API for the life of the server. Everything here is a public fact and none of it is a secret. |
| **converge**   | `bff.env`, `db.env`, the origin certificate and key | Secrets. Shipped over SSH after the node exists, straight from 1Password, installed root-owned `0600`. Never in git, never in state, never in an image.                |
| **verify**     | nothing                                             | Reads the public URL. It cannot pass by reporting its own success.                                                                                                     |

The one secret in `user_data` is a Tailscale auth key, and it is minted fresh
per apply, **single use**, pre-authorised, and **ephemeral**. It is spent the
instant the first node claims it, so the copy left in state authorises nothing
afterwards, and ephemeral means a torn-down environment does not leave dead
nodes in the tailnet after every drill.

### Measured, 2026-07-29

The drill is `down` then `up`, timed, with no human step in between:

| Step                                       | Result                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `./infra/staging-env.sh down`              | 19 resources destroyed, **51 seconds**, run rate to EUR 0.00/mo                  |
| `./infra/staging-env.sh up`                | **6 minutes 1 second**, exit 0, no interaction                                   |
| `curl https://api-staging.pull.fm/healthz` | **200**, `version` = the commit at HEAD                                          |
| `curl https://api-staging.pull.fm/readyz`  | **200**, `database: ok`, `redis: ok` - migrations applied, both stores reachable |

Six minutes against a thirty minute budget. Staging was then torn down again,
because that is what an ephemeral environment is for; `up` is how it comes back.

Three bugs were found by running it rather than by reading it, which is the
argument for drilling in one paragraph:

1. **The secret directory deleted itself.** `pullfm_secret_workdir` installed its
   own `EXIT` trap, and the caller captured its output with a command
   substitution - so the trap fired when that subshell exited, removing the
   directory before a single byte was written into it. The caller owns the trap
   now, and `pullfm_render_staging_secrets` refuses to write into a directory
   that is not present and 0700.

2. **A rebuild SSHed to the previous node's corpse for ten minutes.** Tailscale
   dedups the DNS name of a device claiming a taken hostname
   (`pullfm-staging-app-1-1`) but leaves `HostName` identical on both, and
   ephemeral reaping is not prompt: the destroyed pair was still listed fifteen
   minutes later. Node lookup now prefers an ONLINE peer and accepts the `-N`
   suffix, and `up` deletes stale `pullfm-staging-*` devices before minting a
   key, which turns the race into a precondition.

3. **A progress message became part of an IP address.** `wait_for_node` returns
   the address on stdout and also logged there, so the caller got
   `"  waiting for ...\n100.76.161.103"` and SSH answered "hostname contains
   invalid characters". Progress goes to stderr.

None of the three is exotic. All three are invisible to review and fatal to an
unattended rebuild.

### What the previous drill found, and what changed

**Measured 2026-07-29.** Staging was torn down and rebuilt from IaC, and did
not come back:

| Step                                       | Result                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `./infra/staging-env.sh down`              | destroyed 19 resources, run rate to **EUR 0.00/mo**. R2 backup bucket survived.         |
| `./infra/staging-env.sh up`                | **45 seconds**, 19 resources created, load balancer even reclaimed the same IPv4        |
| `curl https://api-staging.pull.fm/healthz` | **HTTP 525 for five straight minutes** (Cloudflare could not handshake with the origin) |
| Hetzner load balancer target health        | **unhealthy on both 80 and 443**                                                        |

Terraform's job ended at a booted node. nginx, the origin certificate, the BFF
container, the deploy timer, Postgres and Redis had all been applied **by a
human over SSH** during Gate 0 and existed nowhere else. And there was no way
in: the firewall carries no rule for port 22 and Tailscale was never installed,
because `tailscale_auth_key` was empty in every committed configuration.
Recovering meant putting an operator `/32` into `ssh_allowlist_cidrs`, applying,
bootstrapping by hand, and taking it back out.

Three changes close that:

1. **cloud-init installs Tailscale**, from a key minted per apply, so a rebuilt
   node is reachable without touching the firewall. Break-glass SSH remains,
   unused, for the case where the tailnet itself is the problem.
2. **cloud-init installs everything secret-free**, so converge only ever places
   secrets and runs a committed script.
3. **`up` runs all four stages**, so "rebuild" is one command whose exit code
   means the public URL served the current commit.

Break-glass SSH via `ssh_allowlist_cidrs` is still documented and still empty in
every committed configuration. It is now a fallback rather than the procedure.

## Not here yet

Deliberate omissions, each owned by a later phase:

- **PgBouncer** (Phase 1, Gate 1). Postgres is sized for one BFF node with a
  pool of 10 in the meantime.
- **pgBackRest to R2** (Phase 1, Gate 4). `wal_level` and `archive_mode` are
  already set so enabling it is a config reload rather than a restart.
- **Second application node**, which is what Gate 6's rolling deploy needs.
