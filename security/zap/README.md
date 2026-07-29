# ZAP (DAST) configuration

Dynamic scanning for the Pull.fm platform API. Two plans, two purposes, one shared definition of
"what is in scope" and "what counts as a finding".

| File                                                                 | What it is                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`plans/baseline.yaml`](plans/baseline.yaml)                         | **Passive only.** The Gate 8 plan. Safe per-PR and safe against a local BFF. Sends no attacks. |
| [`plans/api-scan.yaml`](plans/api-scan.yaml)                         | **Active.** Nightly against staging. Sends attack payloads. Read its header before running it. |
| [`context/pullfm-api.context.yaml`](context/pullfm-api.context.yaml) | Canonical context: scope, exclusions, authentication method, technology filter.                |
| [`rules/alert-filters.yaml`](rules/alert-filters.yaml)               | Canonical rule thresholds and alert filters, with a justification per entry.                   |
| [`rules/baseline-rules.tsv`](rules/baseline-rules.tsv)               | The same decisions in the format the **packaged** scans and the GitHub Action take (`-c`).     |
| [`scripts/prune-openapi.mjs`](scripts/prune-openapi.mjs)             | Produces the DAST-safe spec. **Required.** See "Why the spec must be pruned" below.            |

The plans are self-contained: hand any one of them to `zap.sh -autorun` with no build step. The
context and alert-filter blocks are duplicated into each plan between `# region:shared` markers, and
`node security/scripts/check-zap-fragments.mjs` fails CI if a copy drifts from its canonical file.
That trade (duplication plus a drift check, rather than a build step) is deliberate: at 2am you want
to read the file that actually ran.

---

## Why the spec must be pruned

ZAP's `openapi` import job **sends a request for every operation it finds**, to seed the sites tree.
Point it at the real spec and it will issue `DELETE /v1/me` during import, destroying the scan
subject before a single alert is raised. Everything after that returns 401 and the report comes back
clean, which is the worst outcome available: a green DAST result that proves nothing.

ZAP context exclusions cannot fix this, because they are **URL-scoped, not method-scoped**. Excluding
`/v1/me` to protect the `DELETE` would also hide `GET /v1/me`, which is the plan's own authentication
sanity check.

So the filtering happens before ZAP sees the document. Every operation in the spec carries
`x-pullfm-dast: "include" | "exclude"`, and `prune-openapi.mjs` emits a document with the excluded
operations removed. It **fails** if any operation carries no annotation, because the convenient
default ("include unless told otherwise") is the one that gets a destructive route scanned.

Currently excluded, and why:

| Operation                                | Reason                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `DELETE /v1/me`                          | Irreversible cascade delete of the scan subject                       |
| `GET /v1/me/export`                      | Generates a full personal-data export per hit; floods the worker tier |
| `POST /v1/connections/{service}`         | Initiates a real OAuth flow against a third party                     |
| `DELETE /v1/connections/{service}`       | Tears down the connection the rest of the scan depends on             |
| `GET /v1/connections/{service}/callback` | Completing a callback mutates state and drives real provider traffic  |

`/metrics` is deliberately **not** excluded. Detecting that it answers from the public edge is one of
the findings this scan exists to produce.

---

## Before pointing the ACTIVE scan at anything

The active scanner mutates every parameter it finds, which for this API means thousands of malformed
MBIDs and search terms. Under the cache-first design in `docs/PLAN.md` §3, every one of those is a
cache **miss**, and a cache miss enqueues an upstream lookup. Per `docs/UPSTREAM-TERMS.md`,
MusicBrainz allows **1 request per second globally per IP** and iTunes about **20 calls per minute
per IP**. One unthrottled active scan can burn a day of quota and get the egress IP blocked, which
`PLAN.md` §8 correctly calls a product-ending failure mode.

**Two hard preconditions, both required:**

1. The target environment's upstream clients point at the **mock upstream layer** built for Gate 7,
   not at the real providers.
2. The provider kill switches (`PLAN.md` §3.4) are engaged for the duration of the scan.

The plan's `delayInMs: 200` throttle is a backstop for when someone forgets, not a substitute for
either precondition.

Never run the active plan against production.

---

## Running locally

Requires Docker. The image is `ghcr.io/zaproxy/zaproxy:stable`; the older `owasp/zap2docker-*`
Docker Hub images are deprecated.

**Pin the tag to a digest for anything whose result you intend to cite.** Gate 8 says "pinned tool
versions", and `:stable` moves. `docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/zaproxy/zaproxy:stable`
gives you the digest to pin.

### 1. Start the API

```bash
pnpm stack:up     # Postgres 17 + Redis 7
pnpm dev          # BFF on http://127.0.0.1:3000
```

### 2. Produce the DAST-safe spec

```bash
mkdir -p security/zap/work/reports
node security/zap/scripts/prune-openapi.mjs \
  <path-to-openapi.json> \
  security/zap/work/openapi.dast.json
```

Until the BFF emits its own spec, the fixture is a working stand-in:

```bash
node security/zap/scripts/prune-openapi.mjs \
  security/testdata/openapi/pullfm-v1.example.json \
  security/zap/work/openapi.dast.json
```

### 3. Mint a token for the DAST subject

Any valid bearer token for a throwaway account. Never a token belonging to a real person: the
scanner will happily delete that account's wishlist.

```bash
export PULLFM_ZAP_TOKEN="$(op read 'op://MCP/local/pull-fm/DAST_BEARER_TOKEN')"
```

### 4. Run the baseline plan

`host.docker.internal` is how the container reaches a BFF on the host. On Linux, add
`--add-host=host.docker.internal:host-gateway`.

```bash
docker run --rm \
  -v "$PWD/security/zap:/zap/wrk:rw" \
  -e PULLFM_ZAP_TARGET="http://host.docker.internal:3000" \
  -e PULLFM_ZAP_OPENAPI="/zap/wrk/work/openapi.dast.json" \
  -e PULLFM_ZAP_TOKEN="$PULLFM_ZAP_TOKEN" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap.sh -cmd -autorun /zap/wrk/plans/baseline.yaml
```

Reports land in `security/zap/work/reports/`. `security/zap/work/` is scratch; do not commit it.

### 5. Run the active plan (staging only)

```bash
docker run --rm \
  -v "$PWD/security/zap:/zap/wrk:rw" \
  -e PULLFM_ZAP_TARGET="https://api-staging.pull.fm" \
  -e PULLFM_ZAP_OPENAPI="/zap/wrk/work/openapi.dast.json" \
  -e PULLFM_ZAP_TOKEN="$PULLFM_ZAP_TOKEN" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap.sh -cmd -autorun /zap/wrk/plans/api-scan.yaml
```

### Quick packaged scan (no plan file)

For a fast look without the Automation Framework, `zap-api-scan.py` takes the TSV rules file
directly. It enables two extra passive rules (100000, 100001) that the AF plans do not, which is why
`rules/baseline-rules.tsv` carries entries for them.

```bash
docker run --rm -v "$PWD/security/zap:/zap/wrk:rw" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py \
    -t /zap/wrk/work/openapi.dast.json -f openapi \
    -c /zap/wrk/rules/baseline-rules.tsv \
    -J /zap/wrk/work/reports/quick.json \
    -r /zap/wrk/work/reports/quick.html \
    -I
```

`-I` means warnings do not fail the run; lines marked `FAIL` in the rules file still do.

---

## Exit codes and what fails the build

The `exitStatus` job at the end of each plan grades the run:

| Highest risk found | Exit | Effect                                                                                          |
| ------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| High               | 1    | **Build fails.** Gate 8: "zero high/critical".                                                  |
| Medium             | 0    | Reported, does not block. Fix it, or add it to `accepted-risks.md` with an owner and an expiry. |
| Low / Info         | 0    | Informational                                                                                   |

Medium is deliberately non-blocking. On a solo project a blocking medium produces filter-and-forget
behaviour, and a filtered finding is worse than a visible one. The register is where a medium goes
to stay visible with a deadline attached.

`env.parameters.failOnError: true` is separate and more important: a plan that could not run must
never report "no issues". A DAST job that silently no-ops is worse than no DAST job, because it
produces a green tick someone will later cite as evidence. The `requestor` auth sanity check exists
for the same reason.

---

## In CI

Two jobs, matching the split registered as `PULLFM-RISK-004`.

**Per pull request** - the passive baseline. Fast, non-destructive, no deployed environment needed
beyond staging being up.

```yaml
- name: ZAP baseline (passive)
  run: |
    node security/zap/scripts/prune-openapi.mjs openapi.json security/zap/work/openapi.dast.json
    docker run --rm -v "$PWD/security/zap:/zap/wrk:rw" \
      -e PULLFM_ZAP_TARGET -e PULLFM_ZAP_OPENAPI -e PULLFM_ZAP_TOKEN \
      ghcr.io/zaproxy/zaproxy@sha256:<digest> \
      zap.sh -cmd -autorun /zap/wrk/plans/baseline.yaml
  env:
    PULLFM_ZAP_TARGET: https://api-staging.pull.fm
    PULLFM_ZAP_OPENAPI: /zap/wrk/work/openapi.dast.json
    PULLFM_ZAP_TOKEN: ${{ secrets.ZAP_DAST_TOKEN }}

- name: upload SARIF
  if: always()
  uses: github/codeql-action/upload-sarif@<sha>
  with:
    sarif_file: security/zap/work/reports/zap-baseline.sarif
```

**Nightly** - the active plan, same shape with `plans/api-scan.yaml`, gated on the mock-upstream
preconditions above.

Alternatively the maintained actions `zaproxy/action-baseline` and `zaproxy/action-api-scan` wrap
the packaged scans and accept `rules_file_name: security/zap/rules/baseline-rules.tsv`. They do not
run Automation Framework plans, so they are the quick path rather than the gating one. Pin them by
commit SHA, not by tag, for the reason in `PULLFM-RISK-002`.

---

## Adding an alert filter

1. Edit [`rules/alert-filters.yaml`](rules/alert-filters.yaml), never a plan.
2. Copy the region into both plans (or re-run whatever generated them) and confirm
   `node security/scripts/check-zap-fragments.mjs` passes.
3. Mirror the decision into `rules/baseline-rules.tsv` if the packaged scans raise the same rule.
4. Write **why**, naming the concrete Pull.fm behaviour that produces the noise. A filter whose
   reason is "it was noisy" is an undocumented accepted risk, and those belong in
   `accepted-risks.md` with an expiry.

Prefer `newRisk: "Info"` over `"False Positive"`, and scope by `urlRegex` or `evidence` rather than
globally. An Info finding stays in the report where a human can see it change; a False Positive
disappears, and an alert that becomes real later is then invisible forever.
