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
ran. `deploy-staging.yml` polls `https://api.staging.pull.fm/healthz` until
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

## Not here yet

Deliberate omissions, each owned by a later phase:

- **PgBouncer** (Phase 1, Gate 1). Postgres is sized for one BFF node with a
  pool of 10 in the meantime.
- **pgBackRest to R2** (Phase 1, Gate 4). `wal_level` and `archive_mode` are
  already set so enabling it is a config reload rather than a restart.
- **Tailscale** on the nodes. The plan makes it the only SSH path;
  bootstrapping needed break-glass access first (see
  `ssh_allowlist_cidrs` in `infra/terraform/modules/firewall`).
- **Second application node**, which is what Gate 6's rolling deploy needs.
