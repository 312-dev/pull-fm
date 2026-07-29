# DAST runbook

How to run a dynamic scan against Pull.fm, how to read what comes back, and what to do when the
gate goes red.

**Read the scope section before you run anything.** MusicBrainz permits **1 request per second
globally per IP** and revokes without appeal. `docs/PLAN.md` section 8 calls exceeding it
product-ending. A DAST crawler sends garbage identifiers by construction, and under a cache-first
design every garbage identifier is a guaranteed cache miss, so the scanner is the single most
dangerous client this API will ever have.

---

## 1. Run it

```bash
export PULLFM_ZAP_TOKEN="$(op read 'op://MCP/pull-fm/staging/PROTOTYPE_API_TOKEN/password')"
./security/scripts/run-dast.sh baseline https://api-staging.pull.fm
```

That is the whole thing. It fetches the live spec, filters it twice, checks the credential, runs
ZAP, and compares upstream state before and after.

| Command                                                | What it is                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `run-dast.sh baseline <target>`                        | **Passive only. Sends no attack payloads.** This is the Gate 8 plan. About 3 minutes. |
| `run-dast.sh active <target>`                          | Sends attack payloads. Read section 6 before running it against anything.             |
| `node security/scripts/observatory-grade.mjs <origin>` | The Gate 8 header grade, official verdict plus a local equivalent.                    |
| `node security/scripts/summarise-zap.mjs <sarif>`      | Re-read an existing report without rescanning.                                        |

Reports land in `security/zap/work/`, which `security/.gitignore` excludes. **Do not commit them.**
They contain request and response bodies from an authenticated scan and this repository is public.
Note that the root `.gitignore`'s `*.sarif` does **not** match `zap-baseline.sarif.json`, which is
the filename ZAP actually writes, so the directory ignore is the thing protecting you.

### Environment

| Variable               | Required | Purpose                                                           |
| ---------------------- | -------- | ----------------------------------------------------------------- |
| `PULLFM_ZAP_TOKEN`     | yes      | Bearer token for the DAST subject.                                |
| `PULLFM_TOKEN_OP_REF`  | no       | 1Password reference, read when the above is unset.                |
| `PULLFM_METRICS_URL`   | no       | Reachable `/metrics`, to watch the MusicBrainz pacer. Section 3.  |
| `PULLFM_METRICS_TOKEN` | no       | Bearer for the above.                                             |
| `PULLFM_SPEC_FILE`     | no       | Scan against a locally built spec instead of the target's.        |
| `PULLFM_DAST_OUT`      | no       | Report directory. Defaults to the gitignored `security/zap/work`. |

### The scan subject

Mint a personal API token for a subject that **holds no provider connections**. This is not
hygiene, it is the control that makes four routes safe (section 2). The runner reads
`connectionCount` from `GET /v1/me` and excludes those routes if it is not zero, so a subject that
later links an account degrades the scan instead of causing egress. Never commit the token; it goes
in 1Password and in the `PULLFM_DAST_TOKEN` repository secret.

---

## 2. What is excluded from the scan, and why

Two independent filters run over the spec before ZAP sees it. They answer different questions and
neither one is sufficient alone.

### Filter 1: `prune-openapi.mjs`, reading `x-pullfm-dast`

Answers **"would the scanner destroy the subject it is testing?"** Removes 13 operations, including
`DELETE /v1/me`, `POST /v1/tokens` and the auth flow. Without it, ZAP's OpenAPI import deletes the
scan subject during import and the rest of the run is 401s and a clean report.

### Filter 2: `scope-upstream.mjs`, reading `upstream-scope.tsv`

Answers **"can the scanner reach a third party?"** These are different questions, and trusting the
first for the second was a real gap: **three operations annotated `x-pullfm-dast: include` egress to
a provider on scanner-shaped input.**

| Route                                    | Class           | Reaches                    | Why it is out                                                                                                                                                              |
| ---------------------------------------- | --------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/artists/{mbid}/similar`         | `egress`        | ListenBrainz labs, Last.fm | **The dangerous one.** Fires on _any_ well-formed UUID with no existence check. A random UUID is a guaranteed cache miss, so a scanner gets one outbound call per request. |
| `GET /v1/artists/{mbid}/events`          | `egress`        | SeatGeek                   | The cache key includes `city`/`state`/`country`, so fuzzing geo parameters against **one** valid artist is one SeatGeek call per combination.                              |
| `GET /v1/tracks/{mbid}/preview`          | `egress`        | Deezer                     | Deezer resolution on the request path, never cached (signed URLs expire). A garbage mbid does not egress _today_, which is an accident of cache state, not a control.      |
| `POST /v1/connections/{service}`         | `egress`        | ListenBrainz               | One **uncached** `validate-token` call per request. No cache, no gate.                                                                                                     |
| `GET /v1/connections/{service}/callback` | `egress`        | Last.fm                    | `auth.getSession`. Guarded by a signed single-use state, so a scanner is rejected first, but that guard is the only thing between a fuzzer and Last.fm.                    |
| `GET /v1/feed`                           | `subject-gated` | ListenBrainz, Last.fm      | Egresses only when the **calling subject** holds a stored credential. Scanned only when the runner has proved `connectionCount == 0`.                                      |
| `GET /v1/recommendations`                | `subject-gated` | ListenBrainz, Last.fm      | Same gate.                                                                                                                                                                 |
| `GET /v1/stations`                       | `subject-gated` | ListenBrainz               | Same gate.                                                                                                                                                                 |
| `GET /v1/stations/{id}/tracks`           | `subject-gated` | ListenBrainz               | Same gate, plus an HMAC on the station id.                                                                                                                                 |

**MusicBrainz is not on that list, and that is the important finding.** No HTTP route reaches the
MusicBrainz client at all. Every request-path MusicBrainz read goes through `CachedUpstream.peek`,
which is database-only and returns `null` on a miss rather than calling `load()`. The MusicBrainz
client is reached only by the background cache-warmer job and the offline warm-cache script. So the
1 req/s ceiling cannot be breached by a scanner **as the code stands today**, and the register plus
the reconciliation test exist to notice the day that stops being true.

### It fails closed, in both directions

`scope-upstream.mjs` refuses to run if an operation in the spec has no row, if a row has no
operation, or if every operation was removed. `apps/bff/test/security/upstream-scope.test.ts`
reconciles the register against the real router on every pull request, so **adding a route without
classifying its egress is a red build**, not an unthrottled scanner.

The stronger fix is to make egress a required field of `PullfmAnnotations` next to `dast`, so the
classification lives where the `fetch` lives. That is 38 route edits and is recorded in the header
of `upstream-scope.tsv` as the recommended follow-up.

---

## 3. Did the scan hurt anyone upstream?

The runner answers this three ways, and prints which one it actually managed.

1. **Provider status**, from `/v1/config`, before and after. Always available. Coarse: a provider
   flipping away from `ok` is loud, but staying `ok` proves only that nothing broke.
2. **Egress counters**, from `/metrics`. Definitive. `pullfm_musicbrainz_pacer_dispatched_total` and
   `pullfm_upstream_requests_total{provider}` count requests that actually left the process. Any
   rise fails the run.
3. **The code argument** in section 2, which is why the scan is safe by construction.

**`/metrics` is not reachable from the public edge, by design.** `metricsAllowed()` requires either a
loopback socket peer or `Authorization: Bearer $METRICS_TOKEN`, `METRICS_TOKEN` defaults to empty,
and nginx additionally has `location = /metrics { deny all; }`. So on a normal run the tool prints:

```
UNKNOWN MusicBrainz pacer counters were NOT observed.
```

**That is the correct output and it must not be recorded as "the pacer stayed flat".** "Not
measured" and "measured flat" are different answers, and treating them as the same is the defect
this whole tree keeps rediscovering. To upgrade it to a measurement, set `METRICS_TOKEN` on the node
and pass `PULLFM_METRICS_URL` plus `PULLFM_METRICS_TOKEN`. If you set `PULLFM_METRICS_URL` and the
scrape fails, the runner **refuses to scan** rather than falling back to the weaker answer.

Note when reading a rise: the background cache-warmer also moves the MusicBrainz pacer. Confirm
attribution before panicking, and confirm it quickly.

---

## 4. Reading the output

`summarise-zap.mjs` groups by severity and collapses duplicates, so a header missing on twelve
routes reads as one finding rather than twelve.

### Gate grading

| ZAP risk       | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| **High**       | **Blocks.** The plan's `exitStatus` job exits 1 and the workflow fails.                              |
| **Medium**     | Reported, does not block. Must be fixed or written into `security/accepted-risks.md` with an expiry. |
| **Low / Info** | Reported. Read them; several are the controls working.                                               |

Medium is deliberately non-blocking. A blocking medium on a solo project produces filter-and-forget
behaviour, which is worse than a finding somebody has to look at.

### Real finding versus noise

**Always real, never filter these:**

- **10098 Cross-Domain Misconfiguration.** A permissive `Access-Control-Allow-Origin` on a
  bearer-token API that also sends `Access-Control-Allow-Credentials: true` turns any page on the
  internet into an authenticated client. There is no benign version of this alert here.
- **10024 Sensitive Information in URL.** A ListenBrainz token or Last.fm session key in a query
  string is asset A1 (`THREAT-MODEL.md`) on the wire and in every intermediary's logs.
- **10023 / 90022 Debug and application errors.** RFC 9457 problem bodies must carry no stack trace
  and no SQL text.
- **10021 X-Content-Type-Options.** Load-bearing rather than cosmetic: upstream-supplied artist
  names and biographies are echoed in our responses, so sniffing is a real path from an upstream
  value to script execution in a browser client.
- **10015 Re-examine Cache-control.** Every authenticated response is per-subject. A shared cache
  holding a `/v1/me` or `/v1/feed` body is a cross-subject disclosure (`THREAT-MODEL.md` T12). This
  fired on the first real scan and it was a true positive; see section 7.

**Known noise, already downgraded to Info with a reason in `rules/alert-filters.yaml`:**

- **10096 Timestamp Disclosure.** Every body in this API is timestamped by design.
- **10027 Suspicious Comments.** Matches SQL keywords inside response bodies, and our bodies are
  artist names and biographies from MusicBrainz and Last.fm. There are no comments in JSON.
- **10036 Server Header**, scoped by evidence to `cloudflare` only. A `Server:` header leaking
  Fastify, Node or a version number still alerts at full risk.
- **100001 Unexpected Content-Type**, scoped by evidence to `application/problem+json`, which
  `docs/PLAN.md` section 6 mandates. An unexpected `text/html` still surfaces, and it would mean
  requests are reaching something other than the app.

**Not filtered on purpose**, so the decision is not relitigated each time: 10202 Anti-CSRF and 90005
Fetch Metadata are false positives if sessions are bearer-only and true positives if the sealed
cookie becomes the browser credential. That is undecided, so suppressing them now would pre-commit
the answer in the wrong direction.

### Alerts that are the design working

A 401, 403 or 404 to a foreign subject is the **observable proof** of the BOLA design
(`BOLA-TESTING.md`), which is exactly why rule 100000 is scoped to `/v1/artists/{mbid}/events`
rather than filtered across the context. Do not silence error-code alerts globally.

---

## 5. When the gate goes red

**First, decide whether the scan ran.** More gates are broken by a scan that did not happen than by
a scan that found something.

| Symptom                                                    | It means                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SUSPECT the report contains zero results of any severity` | No requests were scanned. Check the OpenAPI import and the auth check. **Not a pass.**            |
| `FAIL cannot read ...sarif`                                | The plan never reached its report job. A scan failure, not a clean scan.                          |
| `Job requestor ... Expected : 200 Received : 401`          | The credential is not reaching the target. See section 7 on the replacer.                         |
| `FAIL ... is not in the replacer host allowlist`           | You are scanning a host the plan will not authenticate against. Add it to the plan, deliberately. |
| `UNSCOPED ... has no row in upstream-scope.tsv`            | Somebody added a route. Classify its egress before scanning.                                      |
| `FAIL every operation was removed as provider-reaching`    | ZAP would import an empty spec and report clean. Not a passing scan, an absent one.               |
| `ROSE pullfm_upstream_requests_total{...}`                 | **Stop.** The register is wrong or a new route egresses. Investigate before running again.        |

**If it is a real High**, fix it. There is no accepted-risk path for a High on this gate; the gate
clause is "zero high/critical".

**If it is a Medium you intend to keep**, it needs an entry in `security/accepted-risks.md` with an
owner and an expiry, and `check-accepted-risks.mjs` will fail CI when that expiry passes. A Medium
with neither is an undocumented accepted risk.

**If you are tempted to add an alert filter**, read the ground rules at the top of
`rules/alert-filters.yaml`. Downgrade to `Info`, never `False Positive`, unless the alert is
provably impossible; scope by `urlRegex` rather than globally; and name the concrete Pull.fm
behaviour that produces the noise. A filter whose reason is "it was noisy" is an accepted risk in
the wrong file.

---

## 6. The active scan

`run-dast.sh active` sends attack payloads. Its plan header states two hard preconditions: upstreams
pointed at the Gate 7 mock layer, and provider kill switches engaged.

**Neither precondition is satisfiable on staging today.** Staging points at the real providers
(`/v1/config` reports `musicbrainz: ok`, `previews: ok`), and the runtime `KillSwitch` is
constructed with an empty disabled list and has no admin route, env var or config path that throws
it. It is dead capability.

What makes an active scan defensible anyway is filter 2: ZAP is never told that the
provider-reaching routes exist, and there is no spider, so it cannot discover them. That is a
stronger control than a kill switch nobody can reach. It is still the weaker footing, so:

- Expect the result to be dominated by rate limiting. The global limiter is 300 per minute per IP
  and the per-token budget is tighter still, while `delayInMs: 200` puts the scanner at about 5
  req/s. Most of an active run against staging measures the rate limiter, not the application.
- Run it against a **local** stack for real coverage: `pnpm stack:up`, then point the runner at
  `http://host.docker.internal:3000`. The host is already in the plan's replacer allowlist.

---

## 7. What the first real run found

The first execution of this configuration, on 2026-07-29, found four defects **in the scan
configuration itself** before it found anything in the application. All four are recorded in the
files they affect. They are listed here because they are the reason to distrust a scan that has
never been run:

1. **The credential was never injected.** ZAP's Automation Framework substitutes `${VAR}` into a
   job's `parameters` but **not** into the `replacer` job's `rules` list, neither for `url` nor for
   `replacementString`. Verified against a local echo server: a literal value arrives, a variable
   arrives verbatim. The plan aborted on an invalid URL before authenticating, and had it not
   aborted it would have scanned the whole API unauthenticated and reported clean.
2. **Three invalid technology tags.** `C` is not a ZAP tech tag, and the correct names are
   `IBM DB2` and `Microsoft SQL Server`, not `Db2` and `MsSQL`. ZAP ignores an unrecognised name
   rather than rejecting it, so the rules those entries were meant to disable had been enabled all
   along. The file's own comment warned about exactly this failure mode.
3. **The auth sanity check could never have passed.** A `url` test can assert presence of a URL in
   the sites tree, but every response-content regex against a requestor-issued message fails,
   including a trivial `(?s).*"id".*`. That assertion now lives in the runner, which parses the JSON.
4. **The SARIF file had a different name than the plan claimed.** ZAP appends the template extension,
   so `zap-baseline.sarif` is written as `zap-baseline.sarif.json` — which the root `.gitignore`'s
   `*.sarif` rule does not match.

And in the application, one true positive: **no `Cache-Control` header on any user-scoped response.**
Fixed by a default in `server.ts`, with regression tests in
`apps/bff/test/security/cache-control.test.ts` that were confirmed to fail without it.
