# Pull.fm threat model

**Method:** STRIDE per interaction, over a data-flow decomposition, with attack trees for the
four risks whose realisation would be unrecoverable. Written 2026-07-28 against
[`docs/PLAN.md`](../docs/PLAN.md) v2 and [`docs/UPSTREAM-TERMS.md`](../docs/UPSTREAM-TERMS.md).

**Why STRIDE and not a checklist.** A checklist tells you whether you did the usual things. This
system's dominant risk is not "did we set HSTS", it is "can one bug in one route hand an attacker
a few thousand people's Last.fm session keys". That question is only answerable by decomposing
where the credentials live, who can reach each store, and which single compromises collapse two
trust boundaries into one. The checklist form of that analysis lives separately in
[`API-SECURITY-CHECKLIST.md`](API-SECURITY-CHECKLIST.md); this document is the reasoning that
produced it.

**The one-sentence version.** Pull.fm is a credential custodian that happens to recommend music.
Every design decision below is downstream of the fact that a single database disclosure must not
be a mass third-party account compromise, and that the operator is one person with no 24/7
response capability (`PLAN.md` §10), so controls have to fail closed without a human in the loop.

**Status.** The BFF is a route skeleton at the time of writing: the contract, status codes, and
error shapes are declared in `apps/bff/src/routes/v1.ts`, but the handlers, the auth plugin, and the
data layer are Phase 2 work. Mitigations are therefore marked
`spec` (a design rule this document imposes), `partial` (some enforcement exists today, usually a
scanner rule), or `done`. This is a design-time threat model whose job is to be wrong in public
before the code is written, not a post-hoc audit.

---

## 1. Decomposition and trust boundaries

```
                          ADV-1 scanner   ADV-3 malicious user   ADV-2 targeted
                                 |               |                    |
                                 v               v                    v
   +--------------------------------------------------------------------------+
   |  TB1  Public internet -> Cloudflare edge                                  |
   |       WAF, bot mgmt, TLS termination, per-IP rate limit, maintenance      |
   |       worker. Everything above this line is hostile input.                |
   +--------------------------------------------------------------------------+
                                 |
                     (TB2) Cloudflare -> Hetzner origin
                     mTLS authenticated origin pull + hcloud firewall.
                     Bypassing this bypasses ALL edge controls.
                                 |
                                 v
   +--------------------------------------------------------------------------+
   |  Nomad allocation: BFF (Fastify, Node 22, ARM64)                          |
   |    - holds the KEK in process memory (Nomad variable -> env)              |
   |    - holds the shared upstream API keys (Last.fm secret, MB User-Agent)   |
   |    - holds the WorkOS API key and webhook signing secret                  |
   |    * this process is the single point where plaintext credentials exist   |
   +--------------------------------------------------------------------------+
        |                    |                      |                  |
        | TB3                | TB4                  | TB5              | TB6
        v                    v                      v                  v
   +----------+        +-----------+        +--------------+   +----------------+
   | PgBouncer|        |   Redis   |        | Upstream APIs|   |     WorkOS     |
   | Postgres |        | cache +   |        | LB / Last.fm |   | AuthKit, JWKS, |
   | 17       |        | ratelimit |        | MB / iTunes  |   | webhooks in    |
   |          |        |           |        | Deezer /     |   |                |
   | CIPHER-  |        | plaintext |        | ReccoBeats   |   | (identity is   |
   | TEXT     |        | catalogue |        |              |   |  outsourced)   |
   | ONLY     |        | + counters|        | UNTRUSTED    |   |                |
   +----------+        +-----------+        | RESPONSES    |   +----------------+
        |                                   +--------------+
        | TB7 (backup)
        v
   +--------------------------+
   | pgBackRest -> Cloudflare |
   | R2 (WAL + full backups)  |
   +--------------------------+

   TB8  Operator / CI -> everything
        GitHub Actions, Terraform, Nomad ACL, 1Password, Cloudflare account
        (SHARED with the personal fleet, PLAN.md §10), Hetzner, WorkOS admin.
        Bus factor 1. This boundary crosses every other boundary.
```

| ID  | Boundary                      | What changes across it                                                                                      |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TB1 | Internet -> Cloudflare        | Anonymous -> rate-limited, WAF-filtered, TLS-terminated                                                     |
| TB2 | Cloudflare -> origin          | Edge-filtered -> trusted-as-filtered. **The origin must not be reachable any other way.**                   |
| TB3 | BFF -> PgBouncer/Postgres     | Plaintext KEK domain -> ciphertext-only domain. This is the boundary the envelope design exists to create.  |
| TB4 | BFF -> Redis                  | Authenticated request context -> shared cache and counter namespace                                         |
| TB5 | BFF -> upstream providers     | Our trust domain -> someone else's. Data crossing back is untrusted; credentials crossing out are spendable |
| TB6 | BFF <-> WorkOS                | Our authorization -> their authentication. Includes an **inbound, unauthenticated-by-default** webhook      |
| TB7 | Postgres -> R2                | Live data under Nomad/network controls -> object storage under a different credential and vendor            |
| TB8 | Operator/CI -> infrastructure | Human/automation identity -> production authority. Crosses TB2 through TB7 simultaneously                   |

**The property TB3 is designed to provide, stated precisely, because it is easy to overclaim:**

> Disclosure of the Postgres data (a stolen backup, an R2 bucket leak, a read-only SQL injection,
> a `pg_dump` from a compromised database host, a mis-restored replica) yields AES-256-GCM
> ciphertext and nothing else, because the KEK never enters the database trust domain.
>
> It does **not** protect against compromise of the BFF process, which by construction holds the
> KEK and can decrypt anything. Envelope encryption raises the bar from "one leaked dump" to "code
> execution in the API tier". Anyone who claims more than that is selling something.

---

## 2. Assets, ranked by loss

| ID  | Asset                                                                                                                                                        | Where it lives                                       | Loss if compromised                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Per-user third-party credentials** (ListenBrainz tokens, Last.fm session keys)                                                                             | `user_oauth_connections` ciphertext + KEK in BFF RAM | **Unrecoverable and multi-party.** Last.fm session keys do not expire and grant write scrobbling on the victim's real account. We would be the breach vector for N third-party accounts we do not control and cannot revoke. |
| A2  | **KEK** (256-bit app key)                                                                                                                                    | Nomad variable, 1Password, offline escrow            | A1 in full, retroactively, including from any historical backup. Loss (as opposed to disclosure) is equally terminal: every user's tokens become permanent ciphertext (`PLAN.md` §5).                                        |
| A3  | Session and identity material: WorkOS access/refresh tokens, session cookie, WorkOS API key, webhook signing secret                                          | Client, Redis, BFF env                               | Account takeover of arbitrary users; forged `user.deleted` events cause irreversible cascade deletion (`on delete cascade`).                                                                                                 |
| A4  | Shared upstream credentials and reputation: Last.fm API secret, our egress IPs, MusicBrainz `User-Agent` identity                                            | BFF env, egress NAT                                  | **Existential, not merely operational.** `UPSTREAM-TERMS.md` L1: Last.fm and MusicBrainz revoke without appeal or SLA. Losing MusicBrainz access ends the product; there is no second supplier of MBIDs.                     |
| A5  | User personal data: email, listening history, wishlist, generated feed                                                                                       | Postgres (plaintext), Redis cache, logs              | GDPR/CCPA exposure, and the listening history is itself sensitive (it reveals taste, mood, and often more).                                                                                                                  |
| A6  | Infrastructure credentials: Hetzner token, **Cloudflare token (shared account)**, Nomad ACL, R2 keys, pgBackRest repo cipher key, GitHub Actions permissions | 1Password, Nomad, GH secrets                         | Total. Cloudflare in particular takes the personal fleet down with it (`PLAN.md` §10).                                                                                                                                       |
| A7  | Backup repository in R2                                                                                                                                      | Cloudflare R2                                        | A1 ciphertext + A5 plaintext in one object, under a credential that is not the database credential. Only useful to an attacker who also has A2, which is the point.                                                          |
| A8  | Availability                                                                                                                                                 | everywhere                                           | Lowest rank **by explicit product decision**: `PLAN.md` §10 publishes a best-effort SLO. Design target is auto-degradation, not paging.                                                                                      |

Ranking rationale: A1 outranks everything because it is the only asset whose compromise harms
people who are not our users on systems we do not operate, and the only one we cannot remediate by
rotating something we control. A2 is ranked second only because it is a means to A1.

---

## 3. Adversaries

Modelled as capability sets, because "hacker" is not a threat model.

### ADV-1 Opportunistic scanner

Mass, untargeted, automated. Probes `/.env`, `/.git/config`, `/actuator`, default Nomad (4646),
Postgres (5432), Redis (6379) on every Hetzner IP, and fires public CVE PoCs at whatever banner
responds. **Does not know Pull.fm exists.** Wins only against defaults and unpatched surface.

Relevant here because the Hetzner box has a public IPv4 and Nomad's HTTP API is a
credential-to-RCE pipeline if it is exposed (`nomad var get` returns the KEK).

### ADV-2 Targeted attacker after the vault

Assumes an attacker who has read this file, the schema in `PLAN.md` §5, the Semgrep rules, and the
CI workflows, because **the repository is public**. Knows exactly which column holds the ciphertext
and exactly which mitigation to test first. Patient, will chain low-severity findings.

Openness is a net positive here (it is what makes the design reviewable at all), but it removes
"attacker does not know our architecture" from the mitigation set entirely. **No control in this
document may depend on obscurity.**

Primary paths: BOLA on any user-scoped route, SSRF from the upstream-fetch layer, the R2 backup
bucket, the CI supply chain, and the operator's identity.

### ADV-3 Malicious authenticated user

The most important adversary, because signup is free, social/magic-link only, and instant. This
adversary holds a **valid subject** and a valid session. Every server-side authorization check is
exposed to them directly.

Attempts, in rough order of expected yield:

1. Object-id substitution on `/v1/wishlist/:id`, `/v1/connections/:service`, `/v1/me/export`.
2. `Idempotency-Key` collision to read a cached response belonging to another subject.
3. Cursor tampering on `/v1/wishlist` and `/v1/feed` to page into foreign rows.
4. OAuth connect-flow abuse: bind their own Last.fm account to a victim's Pull.fm subject
   (scrobble-poisoning and, worse, a persistent read channel), or bind a victim's to themselves.
5. Quota arson: script `/v1/tracks/:mbid/preview` and `/v1/search` to burn the shared iTunes
   (~20 calls/min per IP) and MusicBrainz (1 req/s **global**) budgets, so as to break the service
   for everyone or get it blocked. Cheap, effective, and **not covered by classic API security
   guidance** because the resource being exhausted belongs to a third party.
6. `DELETE /v1/me` aimed at another subject.

### ADV-4 Compromised dependency or build

npm is the highest-probability path to A2 in the entire model, and it needs no skill against us
specifically. A transitive package with a `postinstall` script, or a runtime package that reads
`process.env` on import, exfiltrates the KEK the first time production starts. A mutable GitHub
Action tag (`@v4`, `@v2`) or a `:latest` scanner image (both present in
[`.github/workflows/security.yml`](../.github/workflows/security.yml) today) is the same class of
problem aimed at CI.

Note the specific interaction: **the KEK is delivered as an environment variable**, which is the
one storage location every supply-chain payload already knows how to read.

### ADV-5 Operator account compromise (bus factor 1)

`PLAN.md` §10 states it plainly: one person holds 1Password, Cloudflare, Hetzner, GitHub, WorkOS,
the registrar, and the LLC bank. A single successful phish or a compromised laptop is a total loss
of every asset simultaneously, including A2 in both its live and escrowed copies.

There is no separation-of-duties control available to a solo operator. The available controls are
phishing-resistant MFA everywhere, a hardware key, reducing standing authority (short-lived CI
credentials instead of long-lived tokens), and making the blast radius auditable after the fact.

### ADV-6 Upstream provider as a threat source

Not malicious, but it belongs in the model because it produces two real threats that no
attacker-centric analysis catches:

1. **Revocation.** Last.fm, MusicBrainz, Apple, and Deezer can terminate access unilaterally
   (`UPSTREAM-TERMS.md`). `PLAN.md` §8 already treats this as a product-ending failure mode and is
   why load tests use mocked upstreams.
2. **Hostile or degraded responses.** `labs.api.listenbrainz.org` has no SLA; ReccoBeats has an
   anonymous operator, no status page, and no revenue model. Their JSON lands in our database and
   is then served to our clients. Treating an upstream response as trusted input is OWASP
   API10:2023, and here it is a design fact rather than a hypothetical.

---

## 4. STRIDE per boundary

Threat IDs are referenced by the mitigation register in §6. Severity is the residual-if-unmitigated
rating, using the asset ranking in §2.

### TB1/TB2 - Internet -> Cloudflare -> origin

| ID   | S   | Threat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Sev    |
| ---- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T01  | S   | Origin IP discovered (historical DNS, certificate transparency, an outbound connection from the box) and requested directly, bypassing WAF, bot management, per-IP rate limits, and the maintenance worker in one move. **Re-rated 2026-07-29: the direct-dial half is covered, the via-Cloudflare half is not. See T01b.**                                                                                                                                                                                                                                                                                                                                                                                                                          | High   |
| T01b | S   | **The origin cannot distinguish OUR Cloudflare zone from ANY Cloudflare zone.** All three ingress layers (hcloud firewall on Cloudflare ranges, nginx `$remote_addr` allowlist, Authenticated Origin Pulls) test the same predicate: the peer is a Cloudflare edge. Zone-level AOP presents a certificate that is **shared by every Cloudflare customer**, so the subject check in `nginx-pullfm.conf.in` does not narrow it, although the configuration states that it does. An attacker who learns the origin IP creates a free Cloudflare zone, proxies an A record at it, and passes all three layers. Fixed by per-hostname AOP with our own certificate, or a high-entropy header injected by a Transform Rule. See `AUDIT-2026-07-29.md` F10. | High   |
| T02  | T   | Request smuggling or header injection between the edge and origin, allowing a forged `CF-Connecting-IP` so per-IP quotas and abuse attribution key off attacker-controlled input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | High   |
| T03  | D   | Volumetric or slow-loris DoS. Explicitly out of scope per `SECURITY.md`, but relevant because it is indistinguishable at the origin from T09 quota arson.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Low    |
| T04  | I   | TLS downgrade or a mis-issued certificate. Gate 0 requires testssl.sh >= A; Gate 8 requires Observatory >= A+.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Medium |

### TB3 - BFF -> Postgres (the vault boundary)

| ID  | S   | Threat                                                                                                                                                                                                                                                                                                   | Sev          |
| --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| T05 | I   | **SQL injection reaching `user_oauth_connections`.** Highest-value single bug in the system. Candidate sinks: `q` on `/v1/search`, `seed` on `/v1/recommendations`, cursor parameters, and any ORDER BY built from a sort parameter.                                                                     | **Critical** |
| T06 | E   | **BOLA / IDOR**: a query filtered by a client-supplied id without an ownership predicate. The entire API is per-user data, so this is the default failure mode, not an edge case.                                                                                                                        | **Critical** |
| T07 | I   | Credentials leaking through database observability: `log_statement`, `log_min_duration_statement` capturing bound parameters, `pg_stat_activity`, or an APM span carrying query arguments. This is exactly why `PLAN.md` §5 rejects pgcrypto, and the same trap applies to any ORM that logs parameters. | High         |
| T08 | T   | Ciphertext row-swap by an attacker with write access to Postgres but not the KEK: move user B's `access_token_ct` onto user A's row so the BFF decrypts B's token in A's session.                                                                                                                        | High         |
| T09 | I   | Ciphertext-only exfiltration (backup, replica, dump). Downgraded to Medium **only because** the envelope design holds; it becomes Critical the moment A2 also leaks.                                                                                                                                     | Medium       |
| T10 | D   | Connection-pool exhaustion via a slow or unbounded query, taking the API down. PgBouncer transaction mode plus statement timeouts is the control.                                                                                                                                                        | Medium       |

### TB4 - BFF -> Redis

| ID   | S   | Threat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Sev  |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| T11  | E   | **Rate-limit counters evicted under cache pressure, silently disabling rate limiting.** [`docker-compose.dev.yml`](../docker-compose.dev.yml) configures a single Redis with `maxmemory 256mb` and `maxmemory-policy allkeys-lru`. If production mirrors that, a cache-fill event (a crawl, a feed rebuild) evicts the quota keys, and every per-user and per-IP limit fails **open** with no error and no alert. This is the highest-likelihood misconfiguration in the whole model because the setting is deliberate and correct for its other job.                                                                                                                          | High |
| T11b | E   | **The same eviction failure, in process memory rather than in Redis.** T11 reasons about eviction only where it was expected, which is the one place it is now handled correctly. The GLOBAL per-IP limiter is not in Redis at all: `server.ts` registers `@fastify/rate-limit` with no store, so it uses a 5,000-entry in-process LRU. Rotating through more than 5,000 source addresses evicts the attacker's own counter and restores a full budget, which was demonstrated against the real registration. A single IPv6 /64 supplies more addresses than the cache holds. Fixed by pointing the limiter at the `noeviction` quota instance. See `AUDIT-2026-07-29.md` F12. | High |
| T12  | I   | Cached response objects keyed without the subject, so user A's feed or export is served to user B. Same bug class as T14 but in the cache layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | High |
| T13  | I   | Redis reachable without auth or TLS on the private network, or exposed publicly. Redis has no meaningful default authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | High |
| T14  | E   | **`Idempotency-Key` records not scoped per subject.** `PLAN.md` §6 mandates `Idempotency-Key` on every mutating call. If the stored response is keyed on the header value alone, an attacker replays a guessed or observed key and is handed the previous caller's response body. A mandatory cross-cutting header turns one caching mistake into a BOLA on every mutating route at once.                                                                                                                                                                                                                                                                                      | High |

### TB5 - BFF -> upstream providers

| ID  | S   | Threat                                                                                                                                                                                                                                                                                                                                                                                                   | Sev          |
| --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| T15 | I   | **SSRF with credential attachment.** `/v1/artists/:mbid`, `/v1/tracks/:mbid`, and `/v1/albums/:mbid` interpolate a client-supplied identifier into an upstream URL. An unvalidated `mbid` containing `@`, `/`, `?`, `#`, or CRLF redirects the request, and any per-user token or shared API key on that request goes with it. This is the cheapest known path from an unauthenticated request to A1/A4. | **Critical** |
| T16 | E   | **Upstream quota exhaustion (ADV-3 #5, ADV-6 #1).** MusicBrainz is 1 req/s **globally**; iTunes ~20 calls/min per IP. Any synchronous user-triggered upstream call is a remote kill switch for the entire service, and sustained abuse gets us blocked, which `PLAN.md` §8 correctly calls product-ending.                                                                                               | High         |
| T17 | T   | Malicious or malformed upstream response persisted and re-served: script payloads in artist names or bios, a decompression bomb, an unbounded array exhausting memory, or a `Location` chain into our own private network.                                                                                                                                                                               | Medium       |
| T18 | I   | Shared Last.fm API secret disclosure via a client-visible signature construction, a log line, or an error body.                                                                                                                                                                                                                                                                                          | High         |
| T19 | S   | Upstream DNS hijack or TLS interception causing per-user tokens to be sent to an impostor.                                                                                                                                                                                                                                                                                                               | Medium       |

### TB6 - BFF <-> WorkOS (authentication and connect flows)

| ID  | S   | Threat                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Sev          |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| T20 | S   | **Forged WorkOS webhook.** `POST /v1/webhooks/workos` is unauthenticated by definition and handles `user.deleted`, which cascades (`on delete cascade`) through the vault. An unsigned or unverified handler is an unauthenticated mass-deletion endpoint, published in the public API surface.                                                                                                                                                        | **Critical** |
| T21 | S   | Access-token forgery: `alg: none`, a `kid` pointing at an attacker JWKS, or missing `iss`/`aud`/`exp` validation. WorkOS access tokens are JWTs verified against `https://api.workos.com/sso/jwks/{client_id}`.                                                                                                                                                                                                                                        | **Critical** |
| T22 | E   | **OAuth connect-flow CSRF / connection grafting.** `GET /v1/connections/:service/callback` exists because Last.fm's `auth.getSession` needs it (`PLAN.md` §6). Without a subject-bound, single-use, expiring `state`, an attacker can cause a victim's browser to complete a connect flow that binds the attacker's Last.fm account to the victim's subject, or vice versa. Last.fm session keys do not expire, so the resulting channel is permanent. | **Critical** |
| T23 | I   | Magic-link account enumeration through differential responses or timing on the signup and login paths.                                                                                                                                                                                                                                                                                                                                                 | Low          |
| T24 | R   | No durable record of which subject connected or disconnected which provider, so credential misuse cannot be reconstructed. Repudiation is normally a low-value STRIDE letter; here it is the difference between a scoped disclosure notice and telling every user to rotate.                                                                                                                                                                           | Medium       |
| T25 | D   | WorkOS outage or suspension. `PLAN.md` §4 already mandates a scheduled export of the WorkOS user list into our own backups so a vendor suspension cannot leave us unable to identify our own users.                                                                                                                                                                                                                                                    | Medium       |

### TB7/TB8 - backups, operator, CI

| ID  | S   | Threat                                                                                                                                                                                                                                             | Sev          |
| --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| T26 | I   | R2 bucket or credential disclosure yielding backups. Mitigated to "ciphertext plus A5 plaintext" by pgBackRest repository encryption; unmitigated it is A5 in full.                                                                                | High         |
| T27 | E   | **Supply-chain execution in the BFF or in CI reading `process.env`, therefore A2.** See ADV-4.                                                                                                                                                     | **Critical** |
| T28 | E   | Nomad HTTP API (4646) reachable, or a leaked Nomad ACL token: `nomad var get nomad/jobs/pull-fm` returns the KEK directly, converting an infrastructure finding into A1.                                                                           | **Critical** |
| T29 | E   | GitHub Actions token or a mutable action tag used to push a backdoored image or read repository secrets.                                                                                                                                           | High         |
| T30 | D   | **KEK loss** rather than disclosure: 1Password lockout plus a lost offline escrow makes every user's tokens permanently undecryptable. `PLAN.md` §5 flags this as unrecoverable; it is the only threat here whose mitigation is purely procedural. | High         |
| T31 | I   | Cloudflare account compromise, shared with the personal fleet (`PLAN.md` §10, open decision 4). Accepted and registered rather than mitigated: see [`accepted-risks.md`](accepted-risks.md) `PULLFM-RISK-001`.                                     | High         |

---

## 5. Attack trees

Trees are written goal-first. `AND` means all children are required; children are otherwise `OR`.
Leaves marked `[X]` are believed closed by a mitigation in §6; `[!]` are open or only partly closed.

### AT-1: Obtain plaintext third-party credentials for many users

This is the tree that matters. Everything else in this document is supporting material.

```
GOAL: bulk plaintext of A1
|
+-- 1. Decrypt the vault offline                                    (AND)
|   +-- 1a. Obtain ciphertext
|   |   +-- SQLi with read on user_oauth_connections        T05 [X] parameterised queries + Semgrep
|   |   +-- Steal an R2 backup                              T26 [X] pgBackRest repo cipher, scoped R2 key
|   |   +-- pg_dump on a compromised DB host                T09 [!] depends on host hardening
|   |   +-- Postgres/PgBouncer exposed to the internet      T13 [X] hcloud firewall, private network only
|   |   +-- Read a mis-restored or unsecured replica        T09 [X] replica deferred (PLAN.md §9)
|   +-- 1b. Obtain the KEK  ** the load-bearing leaf **
|       +-- RCE in the BFF -> process.env                   T27 [!] residual: RCE beats envelope by design
|       +-- Nomad API 4646 exposed / ACL token leak         T28 [X] firewall + ACL + no public bind
|       +-- Malicious dependency reads env on import        T27 [!] see AT-4
|       +-- 1Password compromise (ADV-5)                    T27 [!] hardware MFA only
|       +-- Offline escrow theft                            T30 [!] physical
|       +-- KEK printed to logs/CI output                   T07 [X] gitleaks + Semgrep + redacting logger
|       +-- Heap snapshot / core dump written to disk       T27 [!] disable --inspect, no core dumps
|
+-- 2. Skip decryption: make the application decrypt for you        (OR)
|   +-- 2a. An API response that contains a token
|   |   +-- GET /v1/connections leaks the token field       T06 [X] hard rule: no route ever returns a
|   |   |                                                            credential, enforced by the Fastify
|   |   |                                                            response schema (see M12)
|   |   +-- GET /v1/me/export includes decrypted tokens     T06 [X] export excludes credential columns
|   |   +-- An error/debug body echoes the decrypted value  T07 [X] RFC 9457 problem+json, no internals
|   +-- 2b. Make the BFF use a victim's credential on your behalf
|   |   +-- connection_id taken from the request body       T06 [!] design rule M10: connection is
|   |   |                                                            resolved from the subject, never
|   |   |                                                            addressed by the client
|   |   +-- AAD not bound -> row-swap a ciphertext          T08 [X] AAD = user_id||provider||column
|   +-- 2c. SSRF: redirect the credentialed upstream call to your host
|       +-- unvalidated :mbid in the upstream URL           T15 [X] strict UUID validation + egress
|                                                                    allowlist + URL built from
|                                                                    components, never concatenation
|
+-- 3. Steal at the source, before encryption                       (OR)
|   +-- Connect-flow CSRF / connection grafting             T22 [X] signed single-use state bound to
|   |                                                                the subject, 10 min TTL
|   +-- Open redirect on the callback -> code/token to attacker T22 [X] redirect_uri allowlist, exact match
|   +-- Session takeover, then read the connect flow        T21 [X] JWKS verification, short-lived tokens
|
+-- 4. Compel or impersonate the operator (ADV-5)                   [!] out of technical scope
```

**What this tree says, and it is uncomfortable:** every branch except 1b and 4 is closable by
code. Branch 1b is not, because the BFF must hold the KEK to do its job. Therefore the honest
security posture is: **the envelope defends the database, and the supply chain plus host hardening
defend the envelope.** Investment should follow that order, which is why AT-4 gets its own tree
despite being "just dependencies".

### AT-2: Read or modify another user's data (BOLA)

```
GOAL: access data owned by another subject
+-- Substitute an object id
|   +-- DELETE /v1/wishlist/:id with a foreign id                    [X] owner predicate in the DML
|   +-- GET /v1/wishlist/:id                                         [X] same
|   +-- DELETE /v1/connections/:service with a foreign connection    [X] resolved from subject only
+-- Replay an Idempotency-Key                                T14     [X] cache key = sha256(subject||key||route||body)
+-- Tamper with a pagination cursor to encode a foreign key   T06    [X] keyset predicate always ANDs
|                                                                        user_id = $subject; cursor is
|                                                                        opaque and integrity-checked
+-- Confuse the subject
|   +-- Trust a client-supplied X-User-Id / user_id body field       [X] subject comes from the verified
|   |                                                                    JWT only, never from input
|   +-- Mass assignment: POST /v1/wishlist {user_id: victim}         [X] additionalProperties:false on
|                                                                        every request schema
+-- Reach a route with no authz at all (API5, BFL)
    +-- an undocumented/forgotten route                              [!] mitigated by "OpenAPI is the
                                                                         source of truth" + a spec-diff
                                                                         test, not by the BOLA suite
```

Proof obligation for the whole tree is Gate 3, mechanised in
[`BOLA-TESTING.md`](BOLA-TESTING.md). The Semgrep rule `pullfm-bola-missing-owner-predicate` is a
tripwire for the common shape, not the proof.

### AT-3: KEK compromise or unrotatable KEK

```
GOAL: possess, or permanently deny us, the KEK
+-- Disclosure  -> see AT-1 branch 1b
+-- Loss (T30)
|   +-- 1Password account lockout AND offline escrow destroyed       [!] two escrows, Emergency Kit
|                                                                        printed (PLAN.md §10)
+-- Rotation failure
    +-- kek_id column omitted -> cannot re-wrap (the published Nango failure)  [X] column mandated day one
    +-- Rotation implemented but never rehearsed                     [!] drill required before Gate 8
    +-- Partial rotation leaves rows on a retired KEK                [X] index on kek_id drives the
                                                                         backfill; alert on
                                                                         count(distinct kek_id) > 1
                                                                         for longer than the rotation
                                                                         window
```

Rotation matters beyond hygiene: it is the **only** incident response available for A1. If a KEK
disclosure is suspected and rotation does not work, the sole remaining option is to invalidate
every connection and ask every user to re-authorise, which is a public breach event.

### AT-4: Supply chain to the KEK

```
GOAL: execute attacker code in a context that can read the KEK
+-- Runtime dependency
|   +-- postinstall script at build time                             [X] pnpm side-effect scripts
|   |                                                                    disabled by default in
|   |                                                                    pnpm 10+; must be explicitly
|   |                                                                    allowlisted per package
|   +-- Package reads process.env on import                          [!] no practical prevention;
|   |                                                                    reduce by egress allowlist so
|   |                                                                    exfiltration has nowhere to go
|   +-- Typosquat / hijacked maintainer                              [X] --frozen-lockfile, lockfile
|                                                                        review, Trivy, SBOM, a minimum
|                                                                        release age before adoption
+-- Build/CI
|   +-- Mutable action tag repointed (@v4, @v2)                      [!] currently unpinned; see
|   |                                                                    PULLFM-RISK-002
|   +-- semgrep/semgrep:latest image swapped                         [!] same; Gate 8 explicitly says
|   |                                                                    "pinned tool versions"
|   +-- Workflow with write permissions on pull_request_target       [X] permissions: contents: read
+-- Base image
    +-- Node/Alpine base image compromise                            [X] digest-pinned images, Trivy
```

The egress allowlist deserves emphasis. It is the only control in this tree that works against an
attacker who already has code execution in the BFF: the KEK is useless if the process cannot open a
connection to anywhere except Postgres, Redis, WorkOS, and the six known upstream hosts.

### AT-5: Burn the upstream quota (product-ending, low skill)

```
GOAL: get Pull.fm rate-limited or banned by MusicBrainz / iTunes / Last.fm
+-- Drive synchronous upstream calls from the request path
|   +-- /v1/search fanning out to iTunes (~20/min per IP)            [X] cache-first, PLAN.md §3;
|   |                                                                    search never reaches iTunes live
|   +-- /v1/tracks/:mbid/preview resolving on demand                 [X] preview resolution is a
|   |                                                                    background job (PLAN.md §3.3)
|   +-- /v1/artists/:mbid cache-missing to MusicBrainz               [X] queue with a measured <=1.0
|                                                                        req/s egress (Gate 1)
+-- Distributed low-rate abuse under the per-IP limit                [!] per-subject quota + Radar;
|                                                                        residual, accepted
+-- Hit the origin directly, bypassing edge rate limits       T01    [X] mTLS origin pull + firewall
+-- Get us reported for ToS breach (affiliate tag, cached previews)  [X] lint rule per PLAN.md §1a.1;
                                                                         Apple previews streamed never
                                                                         cached; Deezer URLs never stored
```

Worth stating explicitly because it inverts normal priorities: **the cheapest catastrophic attack
on Pull.fm is not stealing anything, it is spending our upstream quota.** No credential is
compromised, no data leaks, and the product is dead. The cache-first architecture in `PLAN.md` §3
is therefore a security control, not only a performance one, and should be understood that way
when someone later proposes "just call iTunes directly, it is simpler".

---

## 6. Mitigation register

`Where` names the layer or file the control lives in. `Proof` names the machine check that
demonstrates it, using the gate numbering from `PLAN.md` §7. A control with no proof is an
intention, not a mitigation.

### Vault and cryptography

| ID  | Threats  | Control                                                                                                                                                                     | Where                                       | Proof                                                                                        | Status  |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| M01 | T09, T26 | AES-256-GCM envelope: per-row DEK, DEK wrapped by an app-wide KEK, ciphertext only in Postgres                                                                              | `packages/crypto`, `user_oauth_connections` | Gate 3 `pg_dump \| grep <test-token>` = 0                                                    | spec    |
| M02 | T08      | AAD binds `user_id \|\| provider \|\| column` into the GCM tag, so ciphertext moved between rows or columns fails to authenticate                                           | `packages/crypto`                           | Unit test: swap ciphertext across rows, expect decrypt failure                               | spec    |
| M03 | T09      | Fresh 96-bit nonce per encryption, fresh DEK per row, never reused across users                                                                                             | `packages/crypto`                           | Unit test asserting nonce uniqueness over 10k encryptions                                    | spec    |
| M04 | AT-3     | `kek_id` column from day one plus an index to drive rotation backfill; documented and rehearsed rotation runbook                                                            | schema, `docs/runbooks/kek-rotation.md`     | Rotation drill executed before Gate 8; alert on `count(distinct kek_id) > 1` past the window | spec    |
| M05 | T30      | Dual escrow of the KEK: 1Password plus an offline copy, and a printed 1Password Emergency Kit                                                                               | procedural (`PLAN.md` §10)                  | Restore drill: reconstruct the KEK from escrow alone                                         | spec    |
| M06 | T05, T07 | No pgcrypto. Keys never travel as query parameters                                                                                                                          | design rule (`PLAN.md` §5)                  | Semgrep rule forbidding `pgp_sym_encrypt`/`encrypt(` in SQL                                  | spec    |
| M07 | T05      | Parameterised queries only; no string-concatenated SQL anywhere                                                                                                             | `apps/bff`                                  | Semgrep `p/owasp-top-ten` + `pullfm-bola-missing-owner-predicate`                            | partial |
| M08 | T07      | Redacting logger with an allowlist serializer; production Postgres runs `log_statement = none`, and `log_min_duration_statement` logs duration only, never bound parameters | logger config, Postgres config              | Gate 3 "24h of logs grep to 0"; Semgrep `pullfm-no-token-in-logs`                            | partial |
| M09 | T07      | Decrypted credentials are function-local and passed positionally into the upstream client; never assigned to `request`, `reply`, or any long-lived object                   | `apps/bff`                                  | Semgrep `pullfm-no-decrypted-token-on-request`                                               | done    |

### Authorization (the BOLA surface)

| ID  | Threats      | Control                                                                                                                                                                                                                                                                    | Where                         | Proof                                                                                           | Status |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| M10 | T06, AT-1 2b | Connections are **resolved from the subject**, never addressed by a client-supplied connection id. The only client-supplied key is `:service`, and the lookup is always `where user_id = $subject and provider = $service`.                                                | `apps/bff/routes/connections` | BOLA suite                                                                                      | spec   |
| M11 | T06          | Every user-owned read and write carries an ownership predicate in the same statement as the id predicate. Never fetch-then-check                                                                                                                                           | repository layer              | BOLA suite + Semgrep tripwire                                                                   | spec   |
| M12 | AT-1 2a      | **No route returns a credential, ever, not even to its owner.** Enforced structurally: every response has a JSON schema and Fastify's `fast-json-stringify` serialiser emits only declared properties, so an accidentally selected `access_token_ct` cannot reach the wire | route response schemas        | Contract tests (Gate 2) + a property test asserting no response body matches a credential shape | spec   |
| M13 | T14          | Idempotency records keyed on `sha256(subject \|\| key \|\| method \|\| route \|\| body-hash)`; a key reused with a different body returns 422, never a cached foreign response                                                                                             | idempotency middleware        | BOLA suite includes a cross-subject key replay case                                             | spec   |
| M14 | AT-2         | Subject is derived exclusively from the verified JWT. `X-User-Id`-style headers and `user_id` body fields are rejected, not ignored                                                                                                                                        | auth plugin                   | BOLA suite; `additionalProperties:false`                                                        | spec   |
| M15 | AT-2         | Opaque, integrity-protected cursors; the keyset predicate always ANDs `user_id = $subject` so a forged cursor cannot escape the subject even if the signature check is bypassed                                                                                            | pagination helper             | BOLA suite cursor-tampering case                                                                | spec   |
| M16 | T06          | `DELETE /v1/me` requires a fresh-auth proof that is not a cookie, so a CSRF cannot trigger irreversible deletion                                                                                                                                                           | `apps/bff/routes/me`          | E2E deletion test (Gate L)                                                                      | spec   |
| M17 | T06          | `GET /v1/me/export` is asynchronous and delivered through a signed, single-use, short-TTL URL bound to the subject; it never returns bulk personal data synchronously                                                                                                      | `apps/bff/routes/me`          | Gate L export test + BOLA suite                                                                 | spec   |

### Authentication and the connect flow

| ID  | Threats | Control                                                                                                                                                                                                                                                | Where              | Proof                                                                        | Status |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------- | ------ |
| M18 | T21     | Access tokens verified against the WorkOS JWKS at `https://api.workos.com/sso/jwks/{client_id}`, with `alg` allowlisted to the JWKS algorithms and `iss`, `aud`, `exp`, `nbf` all checked. JWKS cached per `Cache-Control` and refetched on `kid` miss | auth plugin        | Unit tests for `alg:none`, wrong `kid`, wrong `aud`, expired                 | spec   |
| M19 | T20     | `POST /v1/webhooks/workos` verifies the `WorkOS-Signature` header (`t=<timestamp>, v1=<hmac>`) as `HMAC-SHA256(timestamp + "." + rawBody)` in constant time, over the **raw** body, and rejects timestamps outside a 5 minute window to stop replay    | webhook route      | Unit tests: bad signature, replayed timestamp, re-serialised body            | spec   |
| M20 | T22     | Connect flows use a signed, single-use, 10 minute `state` bound to the subject and the target service, stored server-side and consumed atomically; `redirect_uri` is an exact-match allowlist                                                          | connections routes | Integration tests: replayed state, cross-subject state, foreign redirect_uri | spec   |
| M21 | T23     | Uniform responses and timing on signup and login paths; account existence is never disclosed differentially                                                                                                                                            | auth routes        | Contract test asserting identical shapes                                     | spec   |
| M22 | T24     | Append-only audit records for connect, disconnect, token refresh, export, and delete, storing the subject, connection id, and outcome, and never the credential                                                                                        | `audit_log` table  | Gate 3 log review; audit rows asserted in the connect E2E                    | spec   |
| M23 | T25     | Scheduled export of the WorkOS user list into our own backups (`PLAN.md` §4)                                                                                                                                                                           | worker             | Gate 4 restore drill includes the export                                     | spec   |

### Edge, network, and platform

| ID  | Threats   | Control                                                                                                                                                                                                                                 | Where                       | Proof                                                                  | Status |
| --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------- | ------ |
| M24 | T01, AT-5 | Origin accepts connections only from Cloudflare: authenticated origin pull (mTLS) plus an hcloud firewall restricted to Cloudflare ranges                                                                                               | `infra/terraform`           | Test asserting a direct-to-origin-IP request is refused                | spec   |
| M25 | T02       | Client IP taken from `CF-Connecting-IP` **only** when the connection presents the origin-pull client certificate; otherwise from the socket                                                                                             | Fastify `trustProxy` config | Unit test with a spoofed header                                        | spec   |
| M26 | T13, T28  | Postgres, PgBouncer, Redis, and the Nomad API bind to the private network only; no public listener. Nomad ACLs enabled with a scoped token per job                                                                                      | `infra/terraform`, Nomad    | Trivy IaC scan; an external port scan asserted empty                   | spec   |
| M27 | T04       | TLS 1.2+ with modern ciphers, HSTS with preload, and for a JSON API `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, plus COOP/CORP for 90004  | Cloudflare + Fastify helmet | Gate 0 testssl.sh >= A; Gate 8 Observatory >= A+; ZAP passive          | spec   |
| M28 | T11       | **Rate-limit counters must not share an eviction policy with the cache.** Either a separate Redis instance or a separate logical database with `noeviction`, plus a synthetic alert that fires if a quota key disappears before its TTL | `infra`, rate-limit plugin  | Load test asserting limits still hold while the cache is being evicted | spec   |
| M29 | T12       | Every cache key includes the subject for any subject-specific value; catalogue caches are explicitly marked subject-independent                                                                                                         | cache helper                | Unit test over the key builder; ZAP + BOLA cross-subject cache case    | spec   |
| M30 | T10       | PgBouncer transaction pooling, `statement_timeout`, `idle_in_transaction_session_timeout`, and bounded pool sizes                                                                                                                       | PgBouncer, Postgres         | Gate 1 (>=200 client conns on <=25 server conns); Gate 7               | spec   |

### Upstream interaction

| ID  | Threats   | Control                                                                                                                                                                              | Where                            | Proof                                                                       | Status  |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------- | ------- |
| M31 | T15       | Every `:mbid` validated as a canonical UUID before use; upstream URLs constructed from components with encoded parameters, never string concatenation                                | upstream clients                 | Contract tests with CRLF, `@`, `../`, and absolute-URL payloads             | spec    |
| M32 | T15, AT-4 | Egress allowlist: the BFF may open outbound connections only to an explicit host list. Any other destination is refused at the network layer                                         | `infra` firewall / Nomad network | Test asserting an unlisted host is refused                                  | spec    |
| M33 | T16       | Cache-first: no third party is ever called synchronously on a user request path. Preview resolution and MusicBrainz lookups are queued background work                               | worker tier                      | Gate 1 (<=1.0 req/s measured at the network layer), Gate 2 (>=90% warm hit) | spec    |
| M34 | T16       | Per-provider circuit breaker, quota counter, and runtime kill switch (`PLAN.md` §3.4)                                                                                                | upstream clients                 | Gate 7 failure-injection matrix                                             | spec    |
| M35 | T17       | Upstream responses validated against a schema, size-capped, decompression-bomb guarded, redirects disabled, and treated as untrusted on output (escaping, `nosniff`)                 | upstream clients                 | Fuzz tests against the mock upstream layer                                  | spec    |
| M36 | T18       | The Last.fm shared secret is used only server-side for signature construction; signatures are computed in the BFF and the secret never appears in a response or a log                | Last.fm client                   | gitleaks rule `lastfm-api-secret`; Semgrep                                  | partial |
| M37 | T16       | MusicBrainz traffic must route through the shared rate-limited client with the required `User-Agent`                                                                                 | `packages/upstream/musicbrainz`  | Semgrep `pullfm-musicbrainz-must-use-ratelimited-client`                    | done    |
| M38 | ADV-6     | Last.fm cached data capped at 100 MB with LRU eviction and an alert at 80 MB; no affiliate tags anywhere; Apple previews streamed and never cached; Deezer preview URLs never stored | cache layer, lint rule           | Size alert (Gate 5); lint rule per `PLAN.md` §1a.1                          | spec    |

### Supply chain, CI, and operations

| ID  | Threats  | Control                                                                                                                                                                                              | Where                            | Proof                                               | Status                          |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------- | ------------------------------- |
| M39 | T27      | `pnpm install --frozen-lockfile`; package build/postinstall scripts disabled unless explicitly allowlisted; a minimum release age before adopting a new version                                      | CI, `package.json`               | CI already uses `--frozen-lockfile`                 | partial                         |
| M40 | T27, T29 | **Pin every third-party action to a commit SHA and every scanner image to a digest.** Gate 8 requires pinned tool versions; `security.yml` currently uses `@v4`, `@v2`, and `semgrep/semgrep:latest` | `.github/workflows`              | A CI lint asserting no unpinned `uses:` refs        | **open**, see `PULLFM-RISK-002` |
| M41 | T27      | Trivy vulnerability, secret, and misconfiguration scanning with HIGH/CRITICAL blocking, plus a CycloneDX SBOM per build                                                                              | `.github/workflows/security.yml` | Gate 8                                              | done                            |
| M42 | T27      | gitleaks on full history as a blocking gate, plus a pre-commit hook                                                                                                                                  | `.gitleaks.toml`, `.husky`       | Gate 8                                              | done                            |
| M43 | T29      | `permissions: contents: read` on all workflows; no `pull_request_target`; no secrets exposed to fork PRs                                                                                             | `.github/workflows`              | Workflow review; Semgrep `p/github-actions`         | done                            |
| M44 | ADV-5    | Phishing-resistant MFA (hardware key) on 1Password, GitHub, Cloudflare, Hetzner, and WorkOS; printed Emergency Kit; recovery contact; one-page successor doc                                         | procedural (`PLAN.md` §10)       | Checklist item, re-verified at each register review | spec                            |
| M45 | T31      | Cloudflare blast radius shared with the personal fleet: registered as an accepted risk with an expiry, not silently tolerated                                                                        | `accepted-risks.md`              | `pnpm scan:risks` fails when it expires             | done                            |
| M46 | T03, A8  | Auto-degradation rather than paging: Nomad restart policies, an external health check that enables the Cloudflare maintenance worker, and a read-only degraded mode                                  | `infra`                          | Gate 6, Gate 7                                      | spec                            |

---

## 7. Residual risk

Accepted deliberately, all of it recorded in [`accepted-risks.md`](accepted-risks.md) with an
owner and an expiry so it resurfaces instead of decaying.

1. **BFF code execution defeats the vault.** Structural, not fixable without an HSM or a separate
   decryption service with its own authorization, neither of which is justifiable at this scale or
   budget. Mitigated indirectly by AT-4 controls and the egress allowlist.
2. **Bus factor 1.** No separation of duties exists. Compensated by MFA, escrow, and a successor
   document.
3. **Shared Cloudflare account.** `PLAN.md` open decision 4. Registered as `PULLFM-RISK-001`.
4. **Distributed low-rate upstream abuse** below per-IP thresholds. Detectable in aggregate, not
   preventable at the edge.
5. **No 24/7 response.** Published honestly in `SECURITY.md` and `PLAN.md` §10. The design
   compensates by degrading rather than paging.
6. **`labs.api.listenbrainz.org` and ReccoBeats have no SLA and, for ReccoBeats, an anonymous
   operator.** Both are behind a persistent cache so disappearance degrades rather than breaks, but
   we are trusting unaccountable parties with query patterns that reveal user interest.

## 8. Review cadence

- **On any new route.** A route added without an `x-pullfm-authz` classification fails CI (see
  [`BOLA-TESTING.md`](BOLA-TESTING.md)). That failure is the trigger to revisit §4 for that route.
- **On any new upstream provider.** TB5 and `UPSTREAM-TERMS.md` both need an entry before the
  first call is written.
- **Quarterly**, alongside the `UPSTREAM-TERMS.md` re-audit that document already mandates.
- **Whenever an accepted risk expires.** The register validator failing CI is a scheduled prompt to
  re-derive whether the justification still holds.
