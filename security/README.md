# `security/`

Everything that makes a security claim about Pull.fm machine-checkable. `docs/PLAN.md` §7 states the
rule this directory serves: _"a gate is green only when a machine can check it."_ Documents that
cannot fail a build are commentary; the ones here are wired to something that can.

Vulnerability **reporting** is [`SECURITY.md`](../SECURITY.md) at the repository root. This
directory is the internal engineering material.

---

## What is here

```
security/
├── README.md                        you are here
├── THREAT-MODEL.md                  STRIDE decomposition, adversaries, attack trees, mitigations
├── API-SECURITY-CHECKLIST.md        OWASP API Top 10 (2023) mapped route by route
├── BOLA-TESTING.md                  how Gate 3's BOLA clause is met, and proven complete
├── accepted-risks.md                the Gate 8 risk register (YAML frontmatter + prose)
│
├── scripts/
│   ├── check-accepted-risks.mjs       validates the register; FAILS on an expired entry
│   ├── check-accepted-risks.test.mjs  its tests, one per way the register can be wrong
│   └── check-zap-fragments.mjs        fails if a ZAP plan drifts from its canonical fragment
│
├── lib/
│   └── openapi.mjs                    shared, dependency-free OpenAPI walker
│
├── bola/
│   ├── route-matrix.mjs               enumerates + classifies every operation from the spec
│   ├── route-matrix.test.mjs          including the negative cases that prove it fails closed
│   └── bola-suite.skeleton.mjs        the suite itself, as an executable specification
│
├── zap/                             DAST. See zap/README.md for the full runbook.
│   ├── plans/baseline.yaml            passive only, the Gate 8 plan
│   ├── plans/api-scan.yaml            active, nightly, staging only
│   ├── context/pullfm-api.context.yaml canonical scope and authentication
│   ├── rules/alert-filters.yaml       canonical thresholds and filters, justified per entry
│   ├── rules/baseline-rules.tsv       the same, for the packaged scans and the GitHub Action
│   └── scripts/prune-openapi.mjs      produces the DAST-safe spec (required, see zap/README.md)
│
└── testdata/                        fixtures for the tooling above. Not production data.
    ├── accepted-risks/                twelve registers: two valid, ten broken in a different way each
    └── openapi/                       a spec covering PLAN.md §6, plus six negative fixtures
```

Two things are **not** here, on purpose: the Semgrep rules live in
[`.semgrep/pullfm.yml`](../.semgrep/pullfm.yml) and the secret-scanning config in
[`.gitleaks.toml`](../.gitleaks.toml), both at the repository root where their tools expect them.
The work in this directory complements those rather than duplicating them.

---

## Read in this order

1. [`THREAT-MODEL.md`](THREAT-MODEL.md) - what we are defending, from whom, and why the controls are
   shaped the way they are. Start with §1 (trust boundaries) and §5 (attack trees).
2. [`API-SECURITY-CHECKLIST.md`](API-SECURITY-CHECKLIST.md) - the same analysis in OWASP's ordering,
   route by route, with the test for each claim.
3. [`BOLA-TESTING.md`](BOLA-TESTING.md) - the deepest dive, on the single highest risk.
4. [`accepted-risks.md`](accepted-risks.md) - what we consciously chose not to fix, and until when.

The one-paragraph summary of all four: **Pull.fm is a credential custodian that happens to recommend
music.** It stores per-user ListenBrainz tokens and Last.fm session keys under AES-256-GCM envelope
encryption, so a database or backup disclosure yields ciphertext. It does not protect against code
execution in the API tier, which by construction holds the key. Therefore the two things that matter
most are (a) object-level authorization, because the whole API is per-user data and a BOLA reaches
the vault through the application rather than around it, and (b) supply chain, because that is the
realistic path to code execution.

---

## Running every scan locally

```bash
pnpm scan:secrets   # gitleaks, full history, .gitleaks.toml
pnpm scan:sast      # semgrep: p/default, p/typescript, p/owasp-top-ten, .semgrep/
pnpm scan:deps      # trivy: vuln + secret + misconfig, HIGH/CRITICAL, --ignore-unfixed
pnpm scan:all       # all three, the same gates CI runs
```

Plus the checks this directory adds, which are plain Node with no dependencies and no
`pnpm install` required:

```bash
# Gate 8: the accepted-risk register is well formed and nothing has expired
node security/scripts/check-accepted-risks.mjs

# Gate 8: no ZAP plan has drifted from its canonical context / alert filters
node security/scripts/check-zap-fragments.mjs

# Gate 3: every operation in the spec is classified, and the BOLA matrix builds
node security/bola/route-matrix.mjs <openapi.json> --summary > /dev/null

# The tests for all of the above
node --test security/scripts/check-accepted-risks.test.mjs security/bola/route-matrix.test.mjs
```

DAST needs Docker and a running API. Full runbook in [`zap/README.md`](zap/README.md):

```bash
node security/zap/scripts/prune-openapi.mjs <openapi.json> security/zap/work/openapi.dast.json
docker run --rm -v "$PWD/security/zap:/zap/wrk:rw" \
  -e PULLFM_ZAP_TARGET -e PULLFM_ZAP_OPENAPI -e PULLFM_ZAP_TOKEN \
  ghcr.io/zaproxy/zaproxy:stable zap.sh -cmd -autorun /zap/wrk/plans/baseline.yaml
```

### Suggested `package.json` scripts

`package.json` is owned outside this directory, so these are proposed rather than added. They keep
the existing `scan:*` naming:

```jsonc
"scan:risks":  "node security/scripts/check-accepted-risks.mjs",
"scan:zap-cfg": "node security/scripts/check-zap-fragments.mjs",
"test:security": "node --test security/scripts/check-accepted-risks.test.mjs security/bola/route-matrix.test.mjs",
"scan:all": "pnpm scan:secrets && pnpm scan:sast && pnpm scan:deps && pnpm scan:risks && pnpm scan:zap-cfg"
```

---

## What Gate 8 requires, exactly

Verbatim from `docs/PLAN.md` §7:

> **8** | Zero high/critical from Semgrep, Trivy, gitleaks, ZAP baseline with **pinned tool
> versions**; every accepted risk in `security/accepted-risks.md` has an owner and **expiry date**,
> and CI fails on an expired entry; Observatory >= A+

Broken into its five separately-checkable clauses:

| #   | Clause                                                      | Checked by                                                      | Status today                                                                                                                        |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Zero high/critical from **Semgrep**                         | `.github/workflows/security.yml` job `sast`, `--severity=ERROR` | wired                                                                                                                               |
| 2   | Zero high/critical from **Trivy**                           | jobs `deps` and `iac`, `exit-code: 1`                           | wired                                                                                                                               |
| 3   | Zero high/critical from **gitleaks**                        | job `secrets`, full history                                     | wired                                                                                                                               |
| 4   | Zero high/critical from the **ZAP baseline**                | `zap/plans/baseline.yaml`, `exitStatus` with `errorLevel: High` | plan written; needs a deployed staging API and a CI job                                                                             |
| 5   | **Pinned tool versions**                                    | manual review of the workflow, plus a proposed `uses:` lint     | **NOT MET.** `gitleaks-action@v2`, `actions/checkout@v4`, `semgrep/semgrep:latest` are all mutable. Registered as `PULLFM-RISK-002` |
| 6   | Every accepted risk has an **owner** and an **expiry date** | `scripts/check-accepted-risks.mjs`                              | done, and tested                                                                                                                    |
| 7   | **CI fails on an expired entry**                            | same script, exit 1                                             | done; needs a CI step to invoke it                                                                                                  |
| 8   | **Observatory >= A+**                                       | Mozilla HTTP Observatory against `api.pull.fm`                  | needs a deployed API                                                                                                                |

Two honest notes on this table:

- **Clause 5 is currently false**, which is why it is `PULLFM-RISK-002` with the shortest expiry in
  the register. The gate cannot be marked green on a technicality while its own tooling is
  unpinned, and writing that down is cheaper than remembering it.
- The register validator goes beyond the literal wording. Gate 8 asks only for an owner and an
  expiry, but `expires_on: 2099-01-01` satisfies that literally while defeating it entirely. The
  validator therefore also enforces a **severity-scaled maximum acceptance window** (critical 30
  days, high 90, medium 180, low 366) and minimum lengths on the reasoning fields. Rationale is in
  [`accepted-risks.md`](accepted-risks.md).

### Gate 3, for completeness, since most of this directory serves it

> **3** | E2E signup -> connect -> non-empty feed passes in CI; **BOLA suite enumerates every
> user-scoped route from the OpenAPI spec** and asserts 403/404 for a foreign subject on 100% of
> them, failing CI if any route lacks a test; `pg_dump | grep <known-test-token>` returns 0; 24h of
> logs grep to 0

The enumerator ([`bola/route-matrix.mjs`](bola/route-matrix.mjs)) is complete and tested today. The
suite ([`bola/bola-suite.skeleton.mjs`](bola/bola-suite.skeleton.mjs)) is a specification until the
BFF exists. [`BOLA-TESTING.md`](BOLA-TESTING.md) explains how each of the clause's three obligations
is met, including the one that is usually skipped: proving no route lacks a test.

---

## Keeping this current

| Trigger                                                | Do this                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| A new route                                            | Add `x-pullfm-authz` and `x-pullfm-dast` to the operation. The enumerator and the pruner both fail closed without them. |
| A new upstream provider                                | Add it to `THREAT-MODEL.md` TB5 and to `docs/UPSTREAM-TERMS.md` before the first call is written.                       |
| A new ZAP alert filter                                 | Edit `zap/rules/alert-filters.yaml`, re-sync the plans, justify it. See `zap/README.md`.                                |
| A medium ZAP or Semgrep finding you are not fixing now | Add a register entry with an owner and an expiry. That is what the register is for.                                     |
| An accepted risk expires                               | CI goes red. Renew with fresh reasoning, retire the entry, or fix the thing.                                            |
| Quarterly                                              | Re-audit `docs/UPSTREAM-TERMS.md` (it mandates this itself) and re-read `THREAT-MODEL.md` §7 residual risk.             |

`THREAT-MODEL.md` marks each mitigation `spec`, `partial`, or `done`. Almost everything is `spec`
today, because the BFF does not exist. The value of writing it now is that the design is reviewable
in public before there is code to defend, which is the cheapest moment to be wrong.
