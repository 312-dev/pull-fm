# Runbook: the scalability suite (Phase 7, Gate 7)

How to run the load suite, what each scenario answers, what the numbers were the
last time it ran, and what it genuinely cannot tell you.

Suite lives in [`load/`](../load/). Gate definition is
[`PLAN.md` section 7](PLAN.md), gate 7:

> Under a failure-injection matrix (each upstream forced to 429/500/timeout in
> turn) `/feed` returns 200 with degraded sections, p95 <800ms, errors <1%, no
> pool exhaustion, recovery <60s

---

## 1. The constraint that shapes everything

MusicBrainz permits **1 request per second, globally, per IP**, for the entire
service. iTunes permits roughly **20 per minute**. Last.fm and MusicBrainz
revoke access **without appeal and without an SLA**
([`UPSTREAM-TERMS.md`](UPSTREAM-TERMS.md)).

A load test that drives real upstream traffic is therefore not a test. It is an
outage, and a permanent one. [`PLAN.md` section 8](PLAN.md) is explicit that
v1's Gate 7 would have ended the project before launch.

So the suite is built around a warm cache and mocked providers, and it exists to
prove the **cache-first architecture holds under load** rather than to prove we
can generate traffic.

### The safety mechanism, and why it is not optional

**There is no environment variable that points the BFF at mock upstreams.**
`apps/bff/src/services/upstream.ts` constructs every provider client without a
`baseUrl`, and the origins are hardcoded module constants in
`packages/upstream`. The only substitution seam is `WiringOverrides.upstreamFetch`,
which the unit-test harness uses and nothing else can reach.

A BFF started the ordinary way and put under load **calls MusicBrainz, iTunes,
Last.fm, Deezer and ListenBrainz for real.**

`load/safety/upstream-guard.mjs` closes that seam from outside the application:

```bash
node --import ./load/safety/upstream-guard.mjs apps/bff/dist/index.js
```

It wraps `globalThis.fetch`, rewrites every known provider origin to the mock
server, and **refuses** any host that is neither a known provider nor loopback.

Three properties make this a control rather than a suggestion:

| Property                   | How                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The safe path is default   | `load/bin/stack-up.sh` is the documented way to start the stack and always passes `--import`                                                                                |
| Forgetting it fails loudly | Every scenario preflights `GET /__guard/health` and **aborts** if the guard is absent. `GUARD_NOT_REQUIRED=1` skips it and marks the run inadmissible                       |
| The dangerous path is ugly | `PULLFM_ALLOW_REAL_UPSTREAMS=1` is required, prints a three-line banner, and reports `safe: false`, which every scenario treats as a hard stop regardless of any other flag |

The guard is also the **measuring instrument**. It counts every outbound call
keyed by normalised URL, from inside the process making it, which is the only
vantage point from which single-flight can be observed at all.

---

## 2. Running it

### Local (the thing that must work)

```bash
pnpm stack:up                       # postgres, pgbouncer, redis, redis-quota
cp load/.env.load.example load/.env.load
# generate your own KEK into load/.env.load:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

pnpm build
load/bin/stack-up.sh --count 200    # mock, IdP, migrations, guarded BFF, subjects
```

Then any scenario:

```bash
mkdir -p k6-results
k6 run load/scenarios/coalescing.js
k6 run load/scenarios/steady-10k.js
k6 run load/scenarios/pool-ceiling.js
k6 run load/scenarios/breaker.js
load/bin/fail-closed.sh             # drives the three-phase quota-Redis test
```

Stop with `load/bin/stack-up.sh --down`.

### Against staging

Set `BASE_URL` and provision subjects against it. **Confirm the guard is
protecting the target first**; `assertSafeTarget` will refuse a host that is not
recognisably local or staging, and the guard preflight will refuse a target
whose BFF was not started with `--import`.

A EUR 11.59/mo single node is not a load-test target. Saturating it measures
Hetzner's smallest instance, not the architecture. Run the correctness gates
(`coalescing`, `fail-closed`, `breaker`) against staging and keep the throughput
runs local.

---

## 3. Authentication: how a runner obtains credentials

Auth is **magic-link only**. There is no password grant and no scripted login,
and `POST /v1/auth/start` is itself limited to 10 per IP per hour, so it is not
a provisioning path for hundreds of subjects even in principle.

The API has **two credentials, and the load suite needs both.**

### Personal API tokens (`pfm_live_` / `pfm_test_`)

The sane credential for a load runner, and the one to reach for first.

**How a runner obtains one, by hand:**

1. Sign in interactively (magic link) and get a session.
2. `POST /v1/tokens` with `{"name": "...", "scopes": [...], "expiresInDays": N}`.
3. The response carries `token` **once**. Store it in 1Password. It is never
   retrievable again; only `sha256(token)` is kept.
4. Use it as `Authorization: Bearer pfm_test_…`.

`load/auth/seed-subjects.mjs` does exactly this, in bulk, through the real
route rather than by writing `api_tokens` rows. A hand-written row would skip
hashing, scope defaulting and the per-user cap, and the suite would then be
exercising a credential the application never issues.

> **Never commit a token.** The manifest is written to `load/.subjects.json`
> with mode 0600 and is gitignored. Run records carry counts only, never values.

**Two ceilings a runner must know about:**

- **60 requests per minute per token** (`API_TOKEN_DEFAULT_RATE_LIMIT`), schema
  max 600. That is 1 req/s per token at the default. It is a correct product
  default and a hard ceiling on token-driven load: the first `pool-ceiling` run
  produced 696,259 requests at a 95% failure rate, and every failure was a 429
  from this budget rather than anything to do with the pool.
- **Tokens are refused on most of the surface.** `requireAuth` admits them on
  `/v1/me`, `/v1/connections`, `GET /v1/wishlist`, `/v1/feed`,
  `/v1/recommendations`, `/v1/stations`, `/v1/stations/:id/tracks`. Everything
  else is 403: `/v1/search`, all `/v1/artists`, `/v1/tracks`, `/v1/albums`, the
  preview route, and every wishlist write.

### Session JWTs, through the documented JWKS seam

Because the refused routes above are precisely the cache-backed ones, a
token-only suite cannot measure the cache behaviour at all.

`apps/bff/src/config.ts` anticipates this and names it "the JWKS seam":
`WORKOS_JWKS_URL` and `WORKOS_API_BASE_URL` are honoured **outside production**
so a suite can mint tokens against a key set it controls while the authorization
code under test runs unmodified. `security/BOLA-TESTING.md` section 3 picks the
same mechanism for CI.

`load/auth/idp.mjs` is that key set: an RS256 keypair generated **in memory at
startup**, never written to disk, serving `/jwks.json` and `/mint`.

It is useless against production by construction. Three controls close the seam
there and none of them is in this suite's reach: both values are derived from
`WORKOS_CLIENT_ID` when `DEPLOY_ENV=production` so an override is ignored rather
than honoured; a boot assertion refuses to start if the effective host is not
`api.workos.com`; and a unit test asserts the assertion.

### Subjects also need a ListenBrainz connection

`/v1/feed`, `/v1/recommendations` and `/v1/stations` are assembled from a user's
ListenBrainz data. An unconnected subject gets
`{"sections":[],"degraded":true,"unavailableProviders":["listenbrainz"]}`.

A run against unconnected subjects measures the empty-state path and reports
excellent latency for a system doing no work. That mistake was made once here:
94.9% of feeds came back degraded and the p95 looked wonderful. The seeder now
connects every subject through `POST /v1/connections/listenbrainz`, whose token
validation the guard routes to the mock.

---

## 4. The scenarios, and the question each answers

| Scenario       | Question                                                          | Gate                                                        |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `steady-10k`   | What is p95 at a warm cache, at 10x the modelled peak?            | p95<300ms, p99<600ms, errors<0.1%                           |
| `coalescing`   | Do N concurrent cold requests for one key produce exactly 1 call? | `upstream_calls_per_key` max **<= 1**                       |
| `fail-closed`  | When the quota Redis refuses writes, do limits fail CLOSED?       | `quota_fail_open_leaks` **== 0** while severed              |
| `pool-ceiling` | What happens at the connection-pool ceiling?                      | `pool_exhaustion_errors` **== 0**, `api_error_rate` <1%     |
| `breaker`      | What does the API serve while a circuit breaker is open?          | `/feed` 200 + declared degradation, p95<800ms, recovery<60s |
| `chaos`        | The Gate 7 fault matrix: each provider x 429/500/timeout          | p95<800ms, errors<1%, recovery<60s                          |
| `cold-cache`   | What does a cold cache cost?                                      | p95<2s (Gate 2)                                             |
| `soak`         | Does anything drift over four hours?                              | late-phase SLO == early-phase SLO                           |
| `burst-50k`    | **Deferred.** PLAN.md sections 8 and 9.                           | requires an explicit acknowledgement flag to run at all     |

Every threshold makes k6 **exit 99**, which fails a build. These are gates, not
report lines.

---

## 5. Results, measured 2026-07-29

Local stack, single BFF node, macOS, Postgres 18 + Redis 7 in Docker, 200
provisioned subjects, mocked upstreams behind the egress guard.

### `steady-10k` — PASS, admissible

3m measured window after 1m warm-up, arrival 2.3 sessions/s (about 10x the
modelled peak).

| Metric                         | Measured     | Gate     |
| ------------------------------ | ------------ | -------- |
| requests                       | 11,393       |          |
| sessions                       | 417          |          |
| p95                            | **31.7 ms**  | < 300 ms |
| p99                            | **100.3 ms** | < 600 ms |
| api error rate                 | **0.009%**   | < 0.1%   |
| feed degraded rate             | **0%**       |          |
| feed responses with 0 sections | **0**        | 0        |
| problem+json violations        | 0            | 0        |

**The headline architectural result:**

| Upstream fan-out                     | Measured  |
| ------------------------------------ | --------- |
| total provider calls                 | **137**   |
| **upstream calls per request**       | **0.012** |
| worst calls for any single cache key | **1**     |
| calls to MusicBrainz                 | **0**     |
| calls to iTunes                      | **0**     |
| calls to Deezer / Last.fm            | **0**     |
| calls to ListenBrainz                | 137       |

All 137 went to ListenBrainz, whose quota is **per user token** so one user
cannot starve another. The two providers with project-ending ceilings were
never touched by user traffic at all, which is `upstream.ts`'s stated design
("MusicBrainz NO... the request path uses `peek`, which never calls out")
holding under load rather than only in a comment.

### `coalescing` — PASS

100 concurrent VUs, 2 rounds, all acting as one subject, cache truncated first.

| Measured                      | Value         |
| ----------------------------- | ------------- |
| concurrent callers            | 100           |
| requests served               | 200 (all 200) |
| upstream calls total          | **6**         |
| worst calls for one cache key | **1**         |
| suppressed calls              | ~94           |

**Negative control, so the gate is known to be falsifiable.** With the provider
forced to 500 so no fill ever persists, the same scenario measured
`worst single cache key = 3` and the run went **red**. A gate that cannot go red
is a report.

### `fail-closed` — PASS, all three phases

| Phase    | Requests | Result                                                      |
| -------- | -------- | ----------------------------------------------------------- |
| healthy  | 1,383    | p95 **14.7 ms**, 0 failures                                 |
| severed  | 263      | **0 fail-open leaks.** 98.9% answered 503, p95 **1,010 ms** |
| restored | 1,391    | p95 **13.4 ms**, 0 failures                                 |

Not one request was served without a working limiter while the quota Redis was
stopped. THREAT-MODEL T11 does not occur.

The **1,010 ms** is worth knowing precisely: it is the `commandTimeout: 1000`
in `apps/bff/src/lib/redis.ts`. Failing closed costs one second per request,
because the offline queue is deliberately left enabled. Correct, and expensive:
a quota-Redis outage converts the whole API to a one-second-per-request 503
machine rather than a fast one.

### `pool-ceiling` — PASS

Staircase to 200 concurrent VUs against `DATABASE_POOL_MAX=10`, direct endpoint.

| Metric                     | Measured     |
| -------------------------- | ------------ |
| requests                   | 215,877      |
| p95                        | **90.7 ms**  |
| p99                        | **178.6 ms** |
| api error rate             | **0%**       |
| pool exhaustion errors     | **0**        |
| real wishlist rows written | 19,716       |

200 concurrent clients multiplexed onto 10 connections queued and stayed
correct. Roughly **2,000 req/s** sustained on one node.

### `chaos` (the Gate 7 matrix) — **FAIL on recovery, PASS on everything else**

ListenBrainz forced to 429, then 500, then timeout. 25 s hold per cell.

| Gate 7 criterion       | Measured    | Verdict  |
| ---------------------- | ----------- | -------- |
| `/feed` returns 200    | yes         | PASS     |
| with degraded sections | 0 empty     | PASS     |
| p95 < 800 ms           | **32.5 ms** | PASS     |
| errors < 1%            | **0%**      | PASS     |
| no pool exhaustion     | 0           | PASS     |
| **recovery < 60 s**    | > window    | **FAIL** |

4,952 requests, 51 upstream calls, worst key 1, zero refused hosts. Five of the
six Gate 7 criteria hold comfortably. The sixth is section 6.1 and is the same
defect the `breaker` scenario isolates.

### `breaker` — **FAIL on recovery**

| Metric                                  | Measured   | Gate       |
| --------------------------------------- | ---------- | ---------- |
| `/feed` status while breaker open       | **200**    | 200        |
| degradation declared (`degraded: true`) | yes        | yes        |
| p95 while open                          | **9.5 ms** | < 800 ms   |
| errors while open                       | **0%**     | < 1%       |
| feed responses with 0 sections          | 0          | 0          |
| **recovery after fault cleared**        | **62 s**   | **< 60 s** |

Everything Gate 7 asks for except the last row. See section 6.

---

## 6. Open defects this suite found

### 6.1 Circuit-breaker recovery exceeds the Gate 7 budget

**Measured 62 s against a 60 s gate, after only a 30 s fault.**

Cause is the exponential re-open backoff in
`packages/upstream/src/circuit-breaker.ts`: every failed half-open trial re-opens
the circuit and multiplies the reset timeout, `30s -> 60s -> 120s -> 240s cap`.
A sustained fault therefore leaves the breaker in its **slowest** state exactly
when the upstream comes back. A fault long enough to reach the cap means up to
**240 s** of continued degradation after the provider is healthy.

Two ways to close it, both in `packages/upstream`, neither owned by this suite:

1. Lower `resetTimeoutMs` or cap `maxResetTimeoutMs` nearer 60 s.
2. Probe actively rather than waiting for a request to trigger the half-open
   transition, so recovery is bounded by probe interval rather than by backoff.

The threshold is deliberately **left red** rather than relaxed to fit the
measurement. A gate quietly moved to match reality is not a gate.

### 6.2 The BFF cannot connect through the local PgBouncer at all

```
ERR unsupported startup parameter: statement_timeout
```

`apps/bff/src/lib/db.ts` passes `statement_timeout` and
`idle_in_transaction_session_timeout` as connection parameters. PgBouncer rejects
unknown startup parameters unless `IGNORE_STARTUP_PARAMETERS` names them, and
the `pgbouncer` service in `docker-compose.dev.yml` does not set it.

**Consequence: Gate 1's "transaction pooler serves >= 200 client conns on <= 25
server conns" cannot be measured locally today.** `pool-ceiling` currently runs
against the direct endpoint and records `POOL_ENDPOINT=direct` so the result can
never be quoted as evidence for the pooled path.

The fix is one line in the `pgbouncer` service:

```yaml
IGNORE_STARTUP_PARAMETERS: statement_timeout,idle_in_transaction_session_timeout
```

Neon's pooler accepts `statement_timeout`, so this is expected to be
local-only. That expectation is **unverified** and should be confirmed against
the real pooled endpoint before Gate 1 is called green.

### 6.3 `x-cache` does not exist, so Gate 2's cache gate was green over nothing

Gate 2 requires "warm cache hit >= 90%". This suite gated on `cache_hit_rate`
derived from an `x-cache: HIT | MISS | BYPASS` header that `load/README.md`
listed as required.

**No such header is emitted on any route.** There is no cache-statistics
endpoint, and `GET /metrics` is a stub emitting only `pullfm_build_info`.
`CachedUpstream.stats()` and `SingleFlight.stats` exist and nothing in
`apps/bff` reads them.

k6 scores a threshold over a metric with **no samples as PASSING**, so the cache
gate was green on every run it ever made, measuring nothing.

It is now removed rather than falsely green, and replaced by **upstream calls
per request** measured at the egress guard, which answers the question Gate 2
was really asking and is far harder to fake than a header the application sets
about itself. Restoring the real gate needs `x-cache` on the crosswalk-backed
reads, in `apps/bff`.

### 6.4 The global rate limiter caps any single-host load run at 5 req/s

`@fastify/rate-limit` is registered with `global: true`, `max: RATE_LIMIT_MAX`
(default 300), `timeWindow: "1 minute"`, keyed on `req.ip`, and with **no Redis
store**, so it is an in-process LRU.

Two consequences:

- A load generator on one host shares **one bucket**. At the default the entire
  run is capped at 5 req/s and measures the limiter. Load runs raise
  `RATE_LIMIT_MAX`, which is recorded in every run record.
- The limit is **per node** and resets on restart. With more than one BFF node
  the effective per-IP limit is `RATE_LIMIT_MAX x nodes`. Unlike the per-token
  limiter, it neither fails open nor closed on Redis, because it never touches
  Redis.

---

## 7. Capacity model

`PLAN.md` section 8 requires a written capacity model in place of the deferred
`burst-50k`. Measured from the `steady-10k` run above.

**Measured at the 10k profile:**

| Quantity                   | Value                         |
| -------------------------- | ----------------------------- |
| requests/s sustained       | ~36 req/s (11,393 over 315 s) |
| sessions/s sustained       | ~1.3                          |
| p95 at that load           | 31.7 ms                       |
| upstream calls per request | **0.012**                     |
| pool-ceiling throughput    | ~2,000 req/s on one node      |

**Extrapolation to 50k**, 5x the users at the same per-user behaviour:

```
requests/s at 50k    = 36 x 5                    = ~180 req/s
upstream calls/s     = 180 x 0.012               = ~2.2 calls/s
```

Compared against the ceilings that matter:

| Provider     | Ceiling            | Request-path pressure at 50k               |
| ------------ | ------------------ | ------------------------------------------ |
| MusicBrainz  | 1 req/s global     | **0.** Never called from the request path. |
| iTunes       | ~0.33 req/s        | **0.** Never called from the request path. |
| ListenBrainz | 30 / 10 s PER USER | ~2.2 calls/s spread across 10,000 tokens.  |

**The conclusion is different from the one `PLAN.md` section 3 anticipated, and
in a good way.** Section 3 expected upstream quota to be the binding constraint
at 50k. On the _request path_ it is not, because the cache-first design keeps
the dangerous providers off it entirely: ListenBrainz's budget is per user
token, so it scales with users by construction.

The MusicBrainz ceiling still binds, but on the **background warm path**
(`warm:cache`), not on user traffic. That is a batch-scheduling problem with a
known answer (a local mirror, `PLAN.md` section 3) rather than a request-path
problem, and it is unaffected by how many users are online.

**Scale trigger** (`PLAN.md` section 8): add a BFF node at sustained 60% CPU or
p95 > 250 ms. At 31.7 ms p95 and ~36 req/s, the measured headroom to that
trigger is large; `pool-ceiling` reached ~2,000 req/s on one node before
anything degraded.

---

## 8. What cannot be measured, and why

Stated plainly, because a load suite that oversells itself is worse than none.

### Multi-node anything

**Horizontal scaling cannot be measured today.** `app_node_count > 1` fails
`terraform plan` unless a separate Redis cache node is enabled, precisely
because Redis holds the shared MusicBrainz token bucket. `make infra-guards`
asserts that guard.

Everything that follows from that is therefore unmeasured, not merely untested:

- **Single-flight across nodes.** The map is per process and
  `single-flight.ts` says so in its own header. Two nodes holding the same cold
  key produce two upstream calls. This suite proves the per-process property
  and nothing more. No amount of running `coalescing.js` harder discovers the
  multi-node number.
- **The global per-IP rate limit under more than one node**, which is
  `RATE_LIMIT_MAX x nodes` because the store is in-process.
- **Rolling deploy under sustained load** (Gate 6's "zero non-2xx"), which needs
  a second node to roll to.

### Gate 1's pooler assertion

Blocked on 6.2. Not measured against a transaction pooler at all, locally or in
the cloud.

### Gate 2's warm cache hit rate

Blocked on 6.3. There is no signal to measure.

### The upstream latency and refusal profiles

Modelled, not sampled. They come from typical observed behaviour and published
documentation rather than from a distribution measured over time; the iTunes
403 body and the ReccoBeats limit are inferred. They are the least trustworthy
numbers in the suite. Everything is retunable at runtime through
`/__admin/config`, so correcting them after a re-audit needs no code change.

### The mock is not the upstream

It reproduces latency, quota and error shape. It does not reproduce their data,
their partial outages, or their occasional 200-with-garbage.

### Absence of a leak

No k6 result proves there is no leak, only that latency did not drift during the
window. Pair `soak` with process RSS and Postgres connection counts.

### The population is smaller than the model

The traffic model wants 2,000 daily-active subjects. Runs above used 200
provisioned ones, and the run record says `boundBy: "fixtures"`. A smaller
population **overstates per-user cache locality**. Seed more subjects before
quoting a cache-locality number.

### Staging

Not run against staging. It did not exist when this was written. The scenarios
take `BASE_URL`, and the guard preflight refuses a target it cannot confirm is
protected, so pointing them at staging is configuration rather than code.
