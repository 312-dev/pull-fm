# Pull.fm

Music discovery that respects ownership.

Pull.fm blends [ListenBrainz](https://listenbrainz.org), [Last.fm](https://last.fm), and
[MusicBrainz](https://musicbrainz.org) into a discovery experience, plays 30-second previews,
and bridges to buying the music you love rather than renting it.

**Status: pre-alpha.** The backend is under active construction. There is no UI yet, by design
(see [Prime directive](#prime-directive)).

> Copyright 2026 312.dev LLC. Licensed under the [Apache License 2.0](LICENSE).

---

## Prime directive

The backend must be **running, observable, backed up, load-tested, and security-audited before
any UI work begins.** Progress is tracked against explicit, falsifiable gates in
[`docs/PLAN.md`](docs/PLAN.md). A gate is green only when a machine can check it.

This repository is **public**. No secret is ever committed. Credentials are referenced as
`op://` URIs and resolved at runtime; secret scanning blocks both the pre-commit hook and CI.

---

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/bff/` | Backend-for-frontend (Fastify + TypeScript). All third-party keys live here. |
| `packages/` | Shared TypeScript packages (DTOs, clients, config). |
| `infra/` | Terraform (Hetzner, Cloudflare, R2) and Nomad job specs. |
| `infra/local/` | Local development stack support files. |
| `load/` | k6 scalability scenarios. |
| `security/` | Semgrep rules, ZAP config, accepted-risk register. |
| `docs/` | Execution plan, architecture, runbooks, ADRs. |

---

## Local development

Requires Node 22+, pnpm 9+, and Docker.

```bash
pnpm install
pnpm stack:up      # Postgres 17 + Redis 7 on localhost
pnpm dev           # run the BFF against the local stack
```

Useful targets:

```bash
pnpm stack:reset   # wipe local volumes and restart (destroys local data)
pnpm typecheck
pnpm test
pnpm scan:all      # gitleaks + semgrep + trivy, the same gates CI runs
```

The local stack mirrors production settings that matter for correctness: the same Postgres
major version, `wal_level=replica` so backup and replication behavior is exercised locally,
and `allkeys-lru` on Redis so cache eviction degrades the way it will under load.

---

## Security

Security issues should **not** be filed as public GitHub issues. See
[`SECURITY.md`](SECURITY.md) for the disclosure process.

Gates enforced automatically on every commit and pull request:

- **Secrets** — gitleaks, with rules for the specific credential shapes this project handles.
- **SAST** — Semgrep (OWASP Top 10, TypeScript, Node) plus [project-specific rules](.semgrep/pullfm.yml)
  that mechanically enforce two invariants: no plaintext per-user token may reach a log sink,
  and all MusicBrainz traffic must route through the rate-limited client.
- **Dependencies and containers** — Trivy, high/critical blocking, with SBOM generation.
- **Infrastructure as code** — Trivy misconfiguration scanning.

---

## Upstream data sources and attribution

Pull.fm is built on community and public music data. Usage complies with each provider's terms,
including required attribution, rate limits, and the descriptive `User-Agent` MusicBrainz
requires. Provider terms are tracked in [`docs/UPSTREAM-TERMS.md`](docs/UPSTREAM-TERMS.md).

---

## Contributing

This is currently a solo build against a fixed plan and is not accepting feature contributions.
Bug reports and security disclosures are welcome.
