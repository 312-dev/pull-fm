# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue for a security problem.** This repository is public, and a
public report discloses the issue to everyone before it can be fixed.

Report privately via either:

- **GitHub Security Advisories** - [open a private report](https://github.com/312-dev/pull-fm/security/advisories/new)
  (preferred; it gives us a private fix branch and a coordinated disclosure path)
- **Email** - `ope@312.dev`

Please include: what you found, how to reproduce it, the impact you believe it has, and any
suggested remediation. If you have a proof of concept, include it.

### What to expect

| Stage                                          | Target                 |
| ---------------------------------------------- | ---------------------- |
| Acknowledgement                                | within 3 business days |
| Initial assessment and severity                | within 7 business days |
| Fix or documented mitigation for high/critical | within 30 days         |

Pull.fm is operated by a single maintainer (312.dev LLC). Response times reflect that honestly
rather than promising a 24/7 rotation that does not exist.

We will credit reporters in the advisory unless you prefer to remain anonymous. There is no paid
bug bounty program at this time.

## Scope

**In scope**

- The Pull.fm backend API (`api.pull.fm`, `api-staging.pull.fm`)
- This repository: application code, infrastructure as code, CI workflows
- Authentication, session handling, and the per-user credential vault
- Object-level authorization (BOLA/IDOR) on any user-scoped endpoint

**Out of scope**

- Third-party services we depend on (report those to the provider): ListenBrainz, Last.fm,
  MusicBrainz, Apple/iTunes, Deezer, Cloudflare, Hetzner, WorkOS
- Denial of service through raw volume, automated scanner output without a demonstrated impact,
  and findings that require a compromised user device or physical access
- Missing hardening headers with no demonstrated exploit path (still welcome, just triaged lower)

## Safe harbour

We will not pursue legal action against researchers who act in good faith: who avoid privacy
violations, service degradation, and data destruction; who only interact with accounts they own
or have explicit permission to test; and who give us reasonable time to remediate before public
disclosure.

## Handling of user credentials

Pull.fm stores per-user third-party credentials (for example ListenBrainz tokens and Last.fm
session keys). These are encrypted at rest and are never written to logs, traces, or error
reports. Any finding that exposes one of these values is treated as **critical** and takes
priority over all other work.
