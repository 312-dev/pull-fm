# Pull.fm scalability suite

k6 scenarios plus a mock upstream layer, for Phase 7 / **Gate 7** of
[`docs/PLAN.md`](../docs/PLAN.md).

---

## Read this first

> ### Load tests NEVER run against real upstream providers.
>
> [`PLAN.md` section 8](../docs/PLAN.md): the original Gate 7 specified a cold-cache run at
> 50k-equivalent load with "max upstream resolution pressure" against live APIs.
> **Running that would have ended the project.** MusicBrainz allows **1 req/s globally, per IP**.
> iTunes Search allows **~20 calls/minute, per IP**. Last.fm and MusicBrainz revoke access
> **without appeal or SLA**. One 30 minute run is a product-ending event.
>
> **There is no environment variable that points the BFF at mock upstreams.** Provider origins
> are hardcoded module constants in `packages/upstream` and `apps/bff/src/services/upstream.ts`
> never passes a `baseUrl`. An earlier revision of this file claimed a `MUSICBRAINZ_BASE_URL`
> knob existed. It never did: the suite had only ever been pointed at a fake BFF that had no
> upstream clients in it. **A normally launched BFF under load calls the real providers.**
>
> Three mechanical guards enforce the rule, none of which relies on anybody remembering:
>
> 1. `safety/upstream-guard.mjs` is loaded into the BFF process with `--import`. It wraps
>    `globalThis.fetch`, rewrites every provider origin to the mock, and **refuses** any host
>    that is neither a known provider nor loopback. `bin/stack-up.sh` always passes it.
> 2. Every scenario preflights `GET /__guard/health` and **aborts** when the guard is absent or
>    is in `PULLFM_ALLOW_REAL_UPSTREAMS` mode. Forgetting the guard is a failed run, not a
>    revoked API key.
> 3. `lib/config.js` **refuses to start** if `BASE_URL` resolves to a real provider host. There
>    is no environment variable that overrides this check.
>
> The mock server itself still makes **zero outbound network connections**: no proxy mode, no
> record-and-replay, no fallback, and an import list of `node:http`, `node:crypto` and local
> files.
>
> ### Never point this at production.
>
> The suite generates sustained load and **writes** to `/v1/wishlist`. `BASE_URL` must be
> localhost, a `staging` host, or a `.test` / `.local` name. Anything else refuses to run
> unless you set `I_KNOW_THIS_IS_PROD=1`, which you should not do.

---

## Quick start

The whole stack, against the REAL BFF:

```bash
pnpm stack:up                       # postgres, pgbouncer, redis, redis-quota
cp load/.env.load.example load/.env.load   # then generate your own KEK into it
pnpm build
load/bin/stack-up.sh --count 200    # mock, IdP, migrations, GUARDED BFF, subjects

mkdir -p k6-results
k6 run load/scenarios/coalescing.js
k6 run load/scenarios/steady-10k.js
```

Full instructions, including how a runner obtains a personal API token, are in
[`docs/RUNBOOK-SCALE.md`](../docs/RUNBOOK-SCALE.md).

The fake BFF (`--bff-stub`) still exists for exercising the harness with no database, and any run
that touches it is recorded `gate_valid: false`.

Every scenario preflights `GET /healthz` and aborts with an actionable message if the BFF is
not up, instead of producing 30 minutes of connection errors.

Requires **k6 v2.x** (`k6 version`) and **Node 22+**. No npm install: the mock has zero
dependencies and the k6 scripts import nothing remote.

---

## Layout

```
load/
  README.md                  this file
  package.json               convenience scripts, no dependencies
  lib/                       shared k6 modules (no scenario duplicates logic)
    catalog.js               deterministic synthetic catalog, shared with the mock
    config.js                env parsing, safety guards, preflight
    metrics.js               every custom metric, declared once
    http.js                  the single request path: auth, tags, cache accounting
    users.js                 synthetic users, popularity distribution, think time
    journey.js               the weighted endpoint mix and the session
    thresholds.js            SLO profiles as pass/fail gates
    phase.js                 warm-up versus measured windows
    chaos-plan.js            the Gate 7 fault matrix
    mock-control.js          client for the mock's control plane
    summary.js               JSON gate record plus the text summary
  scenarios/
    steady-10k.js            sustained representative traffic      (pre-launch gate)
    cold-cache.js            maximum upstream resolution pressure  (pre-launch gate)
    soak.js                  4 hours, leak and drift detection     (pre-launch gate)
    chaos.js                 Gate 7 failure-injection matrix       (pre-launch gate)
    burst-50k.js             DEFERRED to post-launch, see below
  mock-upstreams/
    server.js                the mock, entry point
    config.js                per-provider latency, quota and refusal profiles
    bff-stub.js              a FAKE BFF, for exercising the suite before apps/bff exists
    providers/               one module per provider, realistic response shapes
    lib/                     latency sampling, rate limiting, stats, URL signing
```

---

## The traffic model

Encoded in `lib/journey.js` and `lib/users.js`. Derived from `PLAN.md` section 3.

| Input                     | Value       | Source              |
| ------------------------- | ----------- | ------------------- |
| Registered users          | 10,000      | scale target        |
| Daily active              | 2,000 (20%) | `PLAN.md` section 3 |
| Sessions per user per day | ~1.5        | `PLAN.md` section 3 |
| Sessions per day          | ~3,000      | derived             |
| Requests per session      | ~22         | below               |

Per session, drawn from a weighted table (`MIX` in `lib/journey.js`):

| Action          | Weight | Endpoint                        | Credential |
| --------------- | ------ | ------------------------------- | ---------- |
| preview resolve | 15     | `GET /v1/tracks/:mbid/preview`  | session    |
| artist view     | 2      | `GET /v1/artists/:mbid`         | session    |
| recommendations | 2      | `GET /v1/recommendations?seed=` | **token**  |
| track lookup    | 1.5    | `GET /v1/tracks/:mbid`          | session    |
| search          | 1.5    | `GET /v1/search?q=`             | session    |
| station tracks  | 1.5    | `GET /v1/stations/:id/tracks`   | **token**  |
| similar artists | 1      | `GET /v1/artists/:mbid/similar` | session    |
| album lookup    | 1      | `GET /v1/albums/:mbid`          | session    |
| stations        | 1      | `GET /v1/stations`              | **token**  |
| wishlist read   | 1      | `GET /v1/wishlist`              | **token**  |
| wishlist add    | 0.6    | `POST /v1/wishlist`             | session    |
| wishlist delete | 0.15   | `DELETE /v1/wishlist/:id`       | session    |

The credential column is not decoration. `requireAuth` admits a personal API token on seven
routes and answers **403** everywhere else, so a mix that guessed would report a third of its
requests as failures and blame the system.

plus exactly one `GET /v1/config` and one `GET /v1/feed` at session start. Twenty draws are
taken with replacement, so the expected composition matches the weights.

### Why 250 concurrent and not 25

The honest arithmetic: 3,000 sessions/day x ~22 requests = ~66,000 requests/day, which is
**0.76 req/s averaged over 24 hours**. Even concentrating 25% of a day into one peak hour gives
about **25 concurrent sessions**. That is not a load test, it is a smoke test.

The default `ARRIVAL_RATE=2.3` sessions/s holds roughly **250 concurrent sessions**, about 10x
the modeled peak. That headroom is deliberate and is the number to argue with if you disagree:

1. **The DAU estimate is a guess.** It has no measurement behind it. A 10x factor covers being
   wrong by an order of magnitude, which is the normal outcome for a pre-launch estimate.
2. **Consumer music traffic is spiky.** A playlist going around, a press mention, or a push
   notification produces a step, not a ramp.
3. **The scale trigger needs headroom to be meaningful.** `PLAN.md` section 8 sets it at
   "sustained 60% CPU or p95 > 250ms". You cannot observe where that trigger fires by testing
   at the level where nothing happens.

To test the literal modeled peak instead: `ARRIVAL_RATE=0.23`.

### Popularity distribution

Requests are **not** spread uniformly over the catalog. 95% of content requests come from a
2,000 item head; the remaining 5% come from a bounded 100,000 item tail. Music consumption is
extreme power law, and more importantly the feed is a recommender output, so what 2,000 DAU
actually see is far more concentrated than the catalog.

This matters because uniform sampling over 2,000,000 recordings would drive the cache hit rate
toward zero no matter how correct the cache is, and the ">90% warm hit" gate would be
unreachable by construction. Tune with `HOT_SET_SIZE`, `HOT_SET_SHARE`, `TAIL_SET_SIZE`.

### Warm-up is excluded from measurement

"Warm cache hit > 90%" presumes a warm cache. The crosswalk is permanent (`PLAN.md` section 3:
resolved once, served from Postgres forever), so in steady state almost every track a user meets
has already been resolved by somebody.

Every warm scenario therefore runs `WARMUP` (default 5m) at **full load before measurement
starts**. Those requests are tagged `phase:warmup` and are excluded from the SLO sub-metrics and
from the cache metrics. They still hit the system, which is the point.

Without this, the hit rate is decided by run length rather than by the cache working: the hit
rate over N draws from a head of H items is roughly `1 - H/N`.

### What the cache gate measures

`cache_hit_rate` is recorded **only** for the crosswalk-backed reads: `preview`, `artist`,
`search`. Not `/v1/feed` (composed per user, per moment, and legitimately a miss on most
sessions) and not `/v1/config` (a static document whose guaranteed hit would pad the ratio).
Gate 2's "warm cache hit >= 90%" is about the MBID-keyed cache that spends upstream quota.

---

## Scenarios

| Scenario       | Question it answers                                              | Gate                                   |
| -------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `steady-10k`   | p95 at a warm cache, at 10x the modelled peak                    | p95<300ms, errors<0.1%                 |
| `coalescing`   | do N concurrent cold requests for one key produce exactly 1 call | `upstream_calls_per_key` max **<=1**   |
| `fail-closed`  | when the quota Redis refuses writes, do limits fail CLOSED       | `quota_fail_open_leaks` **==0**        |
| `pool-ceiling` | what happens at the connection-pool ceiling                      | `pool_exhaustion_errors` **==0**       |
| `breaker`      | what the API serves while a circuit breaker is open              | **Gate 7** (currently RED on recovery) |
| `chaos`        | each upstream forced to 429/500/timeout in turn                  | **Gate 7**                             |
| `cold-cache`   | what a cold cache costs                                          | Gate 2 (p95<2s)                        |
| `soak`         | does anything drift over four hours                              | pre-launch                             |
| `burst-50k`    | 50k burst                                                        | **DEFERRED**, see below                |

```bash
k6 run load/scenarios/steady-10k.js
k6 run load/scenarios/cold-cache.js
k6 run load/scenarios/soak.js
k6 run load/scenarios/chaos.js
```

or, from `load/`: `pnpm mock` in one terminal and `pnpm steady` / `pnpm cold` / `pnpm soak` /
`pnpm chaos` in another. `pnpm inspect` parse-checks every scenario without running it.

### steady-10k

The baseline every other scenario is compared against, and the source of the per-request costs
the capacity model extrapolates from.

Uses an **open model** (`ramping-arrival-rate`): sessions keep starting at the configured rate
even when the system slows down. A closed model quietly reduces load exactly when the system is
struggling, which is how a load test reports a healthy p95 for a service that is falling over.

### cold-cache

Empty crosswalk, maximum upstream pressure, **against mocks**. Two ways to make it cold:

```bash
# preferred: actually flush, so the run is cold end to end
docker compose -f docker-compose.dev.yml exec redis redis-cli FLUSHALL
# plus whatever truncates the crosswalk tables, once they exist

# secondary: shift the catalog window into MBIDs nothing has ever resolved
COLD_OFFSET=$RANDOM k6 run load/scenarios/cold-cache.js
```

The `cache_hit_rate` threshold is **inverted** here (`rate<0.50`). A cold run reporting a high
hit rate was not cold, and would otherwise be scored as an excellent result.

Expect this scenario to report **upstream quota violations** until the MusicBrainz queue,
crosswalk and preview worker exist. That is the finding, not a flake: it is `PLAN.md` section 3's
"cold-cache resolution against iTunes is arithmetically impossible" turned into a measurement.

### soak

Four hours at 60% of peak. k6 has no windowed thresholds, so requests are tagged with the phase
of the run they belong to and the **late** phase is held to the same SLO as the **early** phase.
A leak shows up as `http_req_duration{phase:late}` failing while the aggregate passes, which is
exactly the failure a whole-run p95 hides. The summary also prints the late/early p95 ratio;
anything above ~1.3 is worth investigating even when both phases pass.

Aborts early (`abortOnFail` after a 3m grace) rather than spending four hours confirming a
failure that was obvious at minute five.

### chaos (Gate 7)

Two k6 scenarios run concurrently: a **conductor** that walks the fault matrix, and **traffic**
that generates normal sessions throughout.

Default matrix: 6 providers x 3 faults (`429`, `500`, `timeout`) x (45s hold + 30s recovery
window), after a 60s warm-up. About 23 minutes.

The schedule is a pure function of the configuration (`lib/chaos-plan.js`), so traffic VUs can
tag their requests with the active fault without any coordination channel between them. Every
request is attributable to the fault in effect when it was made, which turns "p95 regressed" into
"p95 regressed while MusicBrainz was timing out".

**Recovery** is the time from clearing a fault until `/v1/feed` is fast and undegraded twice in a
row. Each probe uses a fresh subject and a cache-busting cursor, because probing a cached feed
would report instant recovery for a system that has not recovered.

```bash
# the whole matrix
k6 run load/scenarios/chaos.js

# one cell, for iterating on a fix
CHAOS_PROVIDERS=musicbrainz CHAOS_FAULTS=timeout k6 run load/scenarios/chaos.js
```

A recovery sample of `999` means the feed never came back inside the observation window.

### burst-50k: DEFERRED

**Not part of the pre-launch gate.** `PLAN.md` sections 8 and 9 defer it, and the file refuses to
run without an explicit acknowledgement:

```bash
I_UNDERSTAND_BURST_50K_IS_DEFERRED=1 k6 run load/scenarios/burst-50k.js
```

The reason is not difficulty. A 50k burst shaped by guesswork measures a load pattern that will
never occur, and produces a number that gets quoted later as if it were evidence. There is also a
ceiling no tuning moves: at 50k the binding constraint is **upstream API quota**, not our
infrastructure, and relieving it requires a local MusicBrainz mirror. A green burst-50k against
mocks says nothing about that.

The pre-launch replacement is the capacity model below.

---

## Thresholds and what they mean

A crossed threshold makes k6 **exit 99**, which fails the build. These are gates, not report
lines.

| Metric                           | @10k     | @50k burst | Meaning                                     |
| -------------------------------- | -------- | ---------- | ------------------------------------------- |
| `http_req_duration{slo:yes}` p95 | < 300 ms | < 800 ms   | user-visible latency at the 95th percentile |
| `http_req_duration{slo:yes}` p99 | < 600 ms | < 1500 ms  | the tail that produces support tickets      |
| `http_req_failed{slo:yes}`       | < 0.1%   | < 1%       | transport and 5xx failures                  |
| `api_error_rate`                 | < 0.1%   | < 1%       | narrower: an expected 404 is not an error   |
| `cache_hit_rate`                 | > 90%    | > 90%      | crosswalk hit rate, warm phase only         |
| `cache_header_present`           | > 99%    | > 99%      | the BFF actually emits `x-cache`            |

Per-endpoint budgets are applied as well, because an aggregate p95 can pass while the endpoint
that matters is slow: the fast endpoints outnumber it.

Correctness thresholds apply to every profile:

| Metric                            | Gate              | Why                                             |
| --------------------------------- | ----------------- | ----------------------------------------------- |
| `checks` > 99%                    | all               | any named check failing is a contract violation |
| `problem_json_violations` = 0     | section 6         | RFC 9457 problem+json on every error            |
| `feed_empty_responses` = 0        | Gate 7            | a 200 carrying no sections is not availability  |
| `upstream_quota_violations` = 0   | Gate 1, section 3 | we exceeded a provider's published ceiling      |
| `expired_preview_urls` = 0        | section 1a rule 4 | a signed Deezer URL was cached and went stale   |
| `chaos_recovery_seconds` p95 < 60 | Gate 7            | recovery after a fault clears                   |

**A note on tags and sub-metrics:** k6 only materialises a tagged sub-metric
(`http_req_duration{endpoint:feed}`) when a threshold references it. Requests carry richer tags
than the summary shows: `endpoint`, `slo`, and `phase` (warm-up, soak early/mid/late, and the
active chaos fault). To see the full breakdown, run with `--out json=run.json` or point k6 at a
time-series backend. The summary is the gate; the tagged stream is the diagnosis.

**A note on empty metrics:** k6 does not evaluate a threshold on a metric that received no
samples, and reports it as passing. Any gate that could legitimately have zero samples is paired
with a presence metric that always gets one. `cache_hit_rate` is paired with
`cache_header_present`, so a BFF that stops emitting `x-cache` fails loudly rather than passing
on no data.

`SMOKE=1` relaxes the thresholds so a 30 second shakeout does not fail on a cold JIT, shortens
sessions so they can complete, and **marks the result unusable as gate evidence**.

---

## Output and the gate record

Every run writes two files (both already covered by `.gitignore`):

```
k6-results/<scenario>-<timestamp>.json   the record, keep this one
k6-results/<scenario>-latest.json        stable path for CI
```

Create the directory first: k6 will not create it, and the summary write fails at the end of the
run if it is missing (`mkdir -p k6-results`, or use the `pnpm` scripts which do it for you).

The record carries the thresholds and their pass/fail, the run's parameters, the traffic model,
headline metrics and the full k6 metric set. Two fields matter most:

```json
{ "passed": true, "gate_valid": true }
```

`passed` is "did every threshold hold". **`gate_valid` is "is this run admissible as evidence"**,
and it is false when the run used `SMOKE=1`, `ALLOW_UNREACHABLE=1`, `THINK_SCALE=0`, the fake BFF
stub, or when the mock control plane was unreachable so upstream quota could not be verified. CI
should require both.

The mock's own egress accounting is printed at the end of the run and can be captured separately,
since k6 cannot make HTTP calls from `handleSummary`:

```bash
curl -s http://127.0.0.1:8787/__admin/stats > k6-results/steady-10k-upstream.json
```

---

## The mock upstream server

One process, six providers, no outbound network.

```bash
node load/mock-upstreams/server.js               # port 8787
node load/mock-upstreams/server.js --bff-stub    # plus the fake BFF
MOCK_PORT=9000 MOCK_VERBOSE=1 node load/mock-upstreams/server.js
```

**None of these environment variables exist.** An earlier revision of this section listed
`MUSICBRAINZ_BASE_URL` and five siblings as the way to point the BFF at the mock. The BFF has no
such knob: origins are hardcoded module constants and `buildUpstream` never passes a `baseUrl`.

The BFF is pointed at the mock by the egress guard instead, which rewrites at the `fetch`
boundary and needs no cooperation from the application:

```bash
node --import ./load/safety/upstream-guard.mjs apps/bff/dist/index.js
```

The mock's own path prefixes (`/musicbrainz`, `/listenbrainz`, `/lastfm`, `/itunes`, `/deezer`,
`/reccobeats`) are what the guard rewrites TO, and its host-header routing (`Host:
musicbrainz.org`) remains available for a target that must be redirected with `/etc/hosts`
instead.

### Modeled behavior

| Provider      | p50 / p95 / p99      | Quota        | Scope         | Refusal shape                                                       |
| ------------- | -------------------- | ------------ | ------------- | ------------------------------------------------------------------- |
| MusicBrainz   | 400 / 1200 / 2500 ms | 1 req/s      | global per IP | **503** + `X-RateLimit-Limit/Remaining/Reset`, **no** `Retry-After` |
| ListenBrainz  | 180 / 700 / 1800 ms  | 30 / 10s     | per token     | 429 + `X-RateLimit-Reset-In` + `Retry-After`                        |
| Last.fm       | 250 / 900 / 2000 ms  | ~5/s         | per API key   | 429 + `{"error":29,...}`                                            |
| iTunes Search | 270 / 600 / 1200 ms  | 20 / 60s     | global per IP | **403** + plain text                                                |
| Deezer        | 120 / 350 / 800 ms   | 50 / 5s      | global per IP | **HTTP 200** + `{"error":{"code":4}}`                               |
| ReccoBeats    | 200 / 800 / 2500 ms  | modeled 20/s | global        | 429                                                                 |

The refusal shapes deliberately differ, because they really do differ. **A client written against
"429 plus Retry-After" is wrong for four of the six.** The Deezer case is the one to stare at: it
answers HTTP 200 with an error object, so a client that branches on `res.ok` caches a quota error
as if it were a track. The BFF stub demonstrates the correct check.

Latency is sampled by piecewise-linear interpolation between the stated quantiles, so the
empirical p95 of a run is the p95 you configured. Fitting a lognormal to three numbers gets the
tail wrong, and the tail is what the gate measures.

Other modeled behavior worth knowing:

- **MusicBrainz enforces its `User-Agent` requirement.** A request without a descriptive agent
  gets 403, exactly as production does. Forgetting it is otherwise a silent failure.
- **ListenBrainz's broken endpoints are modeled as broken**: `/1/explore/lb-radio` and
  `/1/popularity/top-recordings-for-artist/*` return 500, and `/1/similar-artists` 404s on the
  main host because it lives on `labs.*`. A mock that served them would let us build a feed
  section on an endpoint that does not work.
- **ReccoBeats requires its two-call sequence.** Passing a Spotify id to
  `/v1/track/{uuid}/audio-features` returns 404, as it really does.
- **iTunes preview URLs are unsigned and never expire.** Deezer's are signed and do expire. Same
  code path in the BFF, two different rules, and only a mock that behaves differently can prove
  the BFF handles both.

### Signed, expiring Deezer preview URLs

Every Deezer track response carries a freshly signed preview URL
(`?hdnea=exp=...~acl=...~hmac=...`) valid for `MOCK_PREVIEW_TTL` seconds (default 300). The mock's
CDN path **verifies the signature and the expiry for real** and distinguishes three failures:

| Counter               | Means                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `previewExpired`      | a URL was cached somewhere and used after its TTL. This is the `PLAN.md` 1a rule 4 violation |
| `previewForged`       | the token was rewritten, truncated or attached to the wrong path                             |
| `previewMissingToken` | the query string was dropped, usually by URL normalisation                                   |

Set `VERIFY_PREVIEW_URL=1` to make the load generator actually play the URL it was handed, which
is the only way a wrongly cached URL becomes visible. It roughly doubles the request count.

### Control plane

```bash
curl  http://127.0.0.1:8787/__admin/health
curl  http://127.0.0.1:8787/__admin/config
curl  http://127.0.0.1:8787/__admin/stats
curl -X POST http://127.0.0.1:8787/__admin/reset            # ?what=all|config|stats

# force a fault (this is what the chaos conductor does)
curl -X POST http://127.0.0.1:8787/__admin/config \
  -d '{"musicbrainz":{"faults":{"force":"timeout"}},"_label":"mb-timeout"}'

# probabilistic background noise instead of a directed experiment
curl -X POST http://127.0.0.1:8787/__admin/config \
  -d '{"all":{"faults":{"errorRate":0.02,"timeoutRate":0.01}}}'

# brownout: no errors, just slow. this is what exhausts connection pools
curl -X POST http://127.0.0.1:8787/__admin/config \
  -d '{"lastfm":{"faults":{"latencyMultiplier":8}}}'

# retune a provider after a re-audit, no code change
curl -X POST http://127.0.0.1:8787/__admin/config \
  -d '{"itunes":{"latency":{"p50":400,"p95":900},"rateLimit":{"limit":15}}}'
```

`force` values: `429` (the provider's own refusal shape), `500`, `timeout` (accept the request and
never answer, so the client's own timeout is what ends it), `down` (reset the connection, which
exercises the connect-error path rather than the HTTP-error path).

`GET /__admin/stats` returns per provider: totals, status breakdown, refusals, peak observed
req/s and req/min, latency percentiles as served, and provider-specific counters. This is the
evidence for Gate 1's "<= 1.0 req/s egress at the network layer".

### The BFF stub

`--bff-stub` attaches a **fake BFF**. It is not a reference implementation and must never be
confused with one. It exists because the parts of a load harness that break are the metric wiring,
the threshold expressions, the summary export and the chaos choreography, and none of those can be
verified without something answering on the other end.

Guardrails: it only runs behind the explicit flag, every response carries `x-pullfm-stub: 1`, and
the summary marks any run that sees that header `gate_valid: false`.

It models the plan's architecture rather than a naive one, because a naive stub cannot be warmed
at all:

- **Pre-seeded crosswalk** (`MOCK_SEED_HOT_SET`, default 2000). Stands in for weeks of background
  resolution. Resolving a 2,000 item head through iTunes at 20 calls/minute takes 100 minutes,
  which is `PLAN.md` section 3's arithmetic and the reason synchronous resolution is forbidden.
- **Background resolution queue**, rate limited to stay inside each provider's ceiling, so a cache
  miss returns a fast `200` with `degraded: true, reason: "pending-resolution"` instead of holding
  the request open.

`MOCK_SYNC_RESOLVE=1` switches to the naive version that resolves inline on every miss. Run it
once: latency still looks fine, the cache hit rate still looks fine, and
`upstream_quota_violations` fails within a minute. That is the whole argument for the gate, and it
is the only way to see it.

---

## What the BFF must provide

The suite depends on four things from `apps/bff`. Each is asserted, so a regression fails a gate
rather than going unnoticed.

This list used to contain four items. Two of them described a BFF that does not exist, and both
were load-bearing, so they are corrected here rather than deleted.

1. **`x-cache: HIT | MISS | BYPASS`** on crosswalk-backed reads. **NOT IMPLEMENTED.** No route
   emits it, there is no cache-statistics endpoint, and `GET /metrics` is a stub carrying only
   `pullfm_build_info`. `cache_hit_rate` therefore had zero samples on every run ever made, and
   k6 scores a threshold over an empty metric as PASSING, so Gate 2's cache assertion was green
   over nothing. The gate is now removed rather than falsely green and replaced by **upstream
   calls per request**, measured at the egress guard. See `lib/thresholds.js`.
2. ~~**A load-test subject header** (`X-Load-Test-User`)~~. **NEVER EXISTED, and asking for it was
   a mistake.** No such header is read and no `LOAD_TEST_MODE` flag exists; `requireAuth` rejects
   any request carrying an `X-User-Id` header with a 400, because impersonation-by-header is
   exactly what it defends against. The suite now provisions **real credentials**: a session JWT
   through the documented JWKS seam plus a real personal API token minted through
   `POST /v1/tokens`. See `auth/` and the runbook.
3. **RFC 9457 `application/problem+json`** on every error response (`PLAN.md` section 6).
   Implemented, and gated at `problem_json_violations == 0`.
4. **`Idempotency-Key` honoured** on `POST /v1/wishlist`. Implemented, and required: the route
   rejects a request without one.

---

## Capacity model (the pre-launch replacement for burst-50k)

`PLAN.md` section 8 requires a written capacity model instead of an invented 50k burst. Fill this
in from a `steady-10k` run; the arithmetic is deliberately simple enough to argue with.

**Measured at 10k** (from `k6-results/steady-10k-latest.json` and the BFF's own metrics):

| Quantity                   | Where it comes from                               | Value     |
| -------------------------- | ------------------------------------------------- | --------- |
| Sessions/s sustained       | `sessions_completed` / duration                   | _fill in_ |
| Requests/s sustained       | `http_reqs` rate                                  | _fill in_ |
| CPU-ms per request         | BFF process CPU / `http_reqs`                     | _fill in_ |
| DB queries per request     | Postgres `pg_stat_statements` delta / `http_reqs` | _fill in_ |
| Upstream calls per request | `__admin/stats` totals / `http_reqs`              | _fill in_ |
| p95 at that load           | `http_req_duration{slo:yes}`                      | _fill in_ |

**Extrapolation to 50k**, which is 5x the users at the same per-user behavior:

```
requests/s at 50k   = requests/s at 10k x 5
CPU cores needed    = requests/s at 50k x CPU-ms per request / 1000 / 0.6   (60% target)
DB connections      = requests/s at 50k x DB queries per request x mean query ms / 1000
upstream calls/s    = requests/s at 50k x upstream calls per request
```

The last line is the one that decides the answer. Compare it against the ceilings: MusicBrainz
**1/s**, iTunes **0.33/s**, Last.fm **~5/s**. If the extrapolated rate exceeds any of them, the
constraint is not compute and no amount of hardware fixes it. The documented unlock is a local
MusicBrainz mirror (`PLAN.md` section 3), roughly 50 GB plus replication.

**Scale trigger** (`PLAN.md` section 8): add a BFF node at **sustained 60% CPU or p95 > 250ms**.
Both are observable from the Phase 4 dashboards; the p95 trigger fires at 250ms so it precedes the
300ms SLO rather than reporting the breach.

---

## Environment variables

| Variable                                       | Default                     | Purpose                                                            |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `BASE_URL`                                     | `http://127.0.0.1:3000`     | the BFF under test                                                 |
| `MOCK_URL`                                     | `http://127.0.0.1:8787`     | mock control plane                                                 |
| `DURATION`                                     | `30m` (`4h` for soak)       | measured window                                                    |
| `WARMUP`                                       | `5m`                        | unmeasured load before the window opens                            |
| `RAMP_UP` / `RAMP_DOWN`                        | `2m` / `1m`                 | ramp stages                                                        |
| `ARRIVAL_RATE`                                 | `2.3`                       | sessions started per second, the load level                        |
| `PRE_ALLOCATED_VUS` / `MAX_VUS`                | `300` / `800`               | k6 VU pool                                                         |
| `USER_POOL` / `DAU_SHARE`                      | `10000` / `0.2`             | synthetic population                                               |
| `ACTIONS_PER_SESSION`                          | `20` (`4` under SMOKE)      | draws from the weighted mix                                        |
| `MIX`                                          | see above                   | JSON patch of the action weights                                   |
| `THINK_SCALE`                                  | `1` (`0.2` under SMOKE)     | human pacing multiplier, `0` invalidates the run                   |
| `HOT_SET_SIZE` / `HOT_SET_SHARE`               | `2000` / `0.95`             | popularity head                                                    |
| `TAIL_SET_SIZE`                                | `100000`                    | universe the tail is drawn from                                    |
| `PREVIEW_SOURCE`                               | `hot`                       | `feed` follows the real feed payload instead                       |
| `VERIFY_PREVIEW_URL`                           | `0`                         | play the resolved preview URL, catches stale Deezer URLs           |
| `COLD_OFFSET`                                  | day-derived                 | catalog window shift for cold runs                                 |
| `SUBJECTS_FILE`                                | `../.subjects.json`         | provisioned credentials, from `auth/seed-subjects.mjs`             |
| `GUARD_URL`                                    | `http://127.0.0.1:8788`     | egress-guard control plane                                         |
| `GUARD_NOT_REQUIRED`                           | `0`                         | skip the guard preflight; marks the run inadmissible               |
| `LOAD_AUTH_TOKEN`                              | empty                       | single-credential probe, for targets with no manifest              |
| `RESULTS_DIR`                                  | `k6-results`                | where the record is written                                        |
| `SMOKE`                                        | `0`                         | relax thresholds, shorten sessions, invalidate the record          |
| `ALLOW_UNREACHABLE`                            | `0`                         | continue when the BFF is down                                      |
| `CHAOS_PROVIDERS` / `CHAOS_FAULTS`             | all six / `429,500,timeout` | trim the matrix                                                    |
| `CHAOS_HOLD_SECONDS` / `CHAOS_RECOVER_SECONDS` | `45` / `30`                 | per-cell timing                                                    |
| `SOAK_RATE_FACTOR` / `SOAK_EDGE_SHARE`         | `0.6` / `0.15`              | soak load and phase edges                                          |
| `MOCK_PORT` / `MOCK_HOST`                      | `8787` / `127.0.0.1`        | mock bind                                                          |
| `MOCK_PREVIEW_TTL`                             | `300`                       | Deezer preview URL lifetime                                        |
| `MOCK_HANG_MS`                                 | `120000`                    | how long a forced timeout is held open                             |
| `MOCK_SEED_HOT_SET`                            | `2000`                      | stub only: crosswalk entries pre-resolved at startup               |
| `MOCK_SYNC_RESOLVE`                            | `0`                         | stub only: resolve on the request path, which fails the quota gate |
| `MOCK_VERBOSE`                                 | `0`                         | log control-plane changes                                          |

---

## Known limitations

Stated plainly, because a load suite that oversells itself is worse than none.

- **The upstream latency profiles are modeled, not measured.** They come from typical observed
  behavior rather than a sampled distribution over time. They are the least trustworthy numbers
  here. Everything is retunable at runtime through `/__admin/config`, so correcting them after a
  re-audit needs no code change.
- **Some refusal shapes are modeled.** MusicBrainz's 503 and Last.fm's error 29 are documented.
  The iTunes 403 body and ReccoBeats' limit are inferred. Verify before quoting a gate result that
  depends on them.
- **The mock is not the upstream.** It reproduces latency, quota and error shape. It does not
  reproduce their data, their partial outages, or their occasional 200-with-garbage.
- **Multi-node behaviour cannot be measured at all.** `app_node_count > 1` fails `terraform plan`
  unless a separate Redis cache node is enabled, because Redis holds the shared MusicBrainz token
  bucket. Single-flight is a PER-PROCESS map, so its cross-node behaviour (two nodes, two calls)
  is unmeasured rather than merely untested. So is Gate 6's rolling deploy.
- **Gate 1's pooler assertion is unmeasurable locally.** The BFF cannot connect through the local
  PgBouncer at all: it passes `statement_timeout` as a connection parameter and PgBouncer answers
  `unsupported startup parameter`. One-line fix in `docs/RUNBOOK-SCALE.md` section 6.2.
- **The population is smaller than the model.** Runs used 200 provisioned subjects against a model
  that wants 2,000 daily-active, which overstates per-user cache locality. The run record says
  `boundBy: "fixtures"` when that applies.
- **No k6 result proves the absence of a leak**, only that latency did not drift during the
  window. Pair the soak with process RSS, Postgres connection counts and the Last.fm cache size
  from the Phase 4 dashboards.
