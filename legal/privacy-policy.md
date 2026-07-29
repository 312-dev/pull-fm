# Pull.fm Privacy Policy

> # DRAFT - NOT LEGAL ADVICE, REQUIRES REVIEW
>
> Every factual claim below was written by reading the code, not from a
> template: the schema in [`../packages/db/migrations/`](../packages/db/migrations/),
> the export builder, the deletion cascade, the logger redaction list, and the
> Terraform that decides where the data physically sits. Where the code does not
> yet support a claim, this document says so instead of making it.
>
> **It has not been reviewed by a lawyer.** It must be before it is published at
> a stable URL.
>
> **Items marked `[OPEN]` are gaps in the system, not gaps in the writing.** A
> privacy policy that describes a system the code does not implement is a false
> statement of fact, which is worse than having no policy. Each `[OPEN]` must be
> closed in code, or the surrounding sentence must be rewritten to match reality,
> before this is published.
>
> **Items marked `[CONFIRM]` need an operator or counsel decision.**

**Version:** DRAFT-0 (unpublished)
**Last updated:** 2026-07-29
**Effective:** not yet effective

---

## 1. Summary

- Pull.fm is **free and non-commercial**. We do not sell, rent, or share your
  personal information, and there is no advertising, no ad tech, and no
  affiliate revenue anywhere in the product.
- We have **no analytics, no tracking pixels, no advertising SDK, and no
  third-party telemetry or error-reporting service**. This is verifiable: the
  repository is public and contains no such dependency.
- We collect the **minimum needed to run a music discovery service**: an
  identifier and email from your sign-in provider, the third-party music
  accounts you choose to connect, what you put on your wishlist, and operational
  logs.
- Your **connected-service credentials are encrypted at rest** with per-record
  keys and are never exported, logged, or shown to anyone, including us in the
  ordinary course of operating the service.
- **Your Pull.fm data is stored in the European Union.** The database is a Neon
  project in **Frankfurt, Germany**, and the application servers are in the EU.
- **Your identity data is not.** Your email address, your name, and your sign-in
  events are handled for us by **WorkOS, in the United States**, under Standard
  Contractual Clauses. We do not have the option of keeping that data in the EU,
  and section 9 says exactly what it covers and how the transfer is legitimized
  rather than implying the whole system is EU-only.
- You can **export** everything (`GET /v1/me/export`) and **delete** everything
  (`DELETE /v1/me`) yourself, from the API or the app, at any time.

The rest of this document is the detail behind those points.

---

## 2. Who is responsible for your data

**312.dev LLC**, a United States limited liability company, is the **controller**
of your personal data.

|                                 |                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller                      | 312.dev LLC, `[CONFIRM: state of organisation]`, United States                                                                                                                                                                                                                                                                   |
| Contact                         | `ope@312.dev`                                                                                                                                                                                                                                                                                                                    |
| Postal address                  | `[CONFIRM - required for a published policy in several jurisdictions]`                                                                                                                                                                                                                                                           |
| Data Protection Officer         | **None.** A DPO is not required: we do not carry out large-scale systematic monitoring and we process no special-category data. Contact the address above.                                                                                                                                                                       |
| EU/UK Article 27 representative | `[OPEN]` **Not appointed.** GDPR Article 27 requires a representative in the Union for a non-EU controller offering services to people in the EU, unless the processing is occasional and low risk. Storing credentials for connected accounts is arguably not low risk. This must be resolved before a public launch in the EU. |

**We are a solo operation.** One person operates Pull.fm. That is disclosed
here because it affects how fast we can respond to you (see section 10) and
because it is a security fact you are entitled to weigh.

---

## 3. What we collect, and where it comes from

This is a table of actual database columns and log fields, not categories.

### 3.1 Account identity (from your sign-in provider)

Authentication is handled by **WorkOS AuthKit**, and **WorkOS processes this
data in the United States**. See section 9 for the transfer mechanism and what
WorkOS is and is not permitted to do with it.

You sign in with an **emailed one-time code** (WorkOS Magic Auth). Social
sign-in with Google or Apple, passkeys, and passwords are **not enabled**. This
is the whole sign-in surface: there is no other way to sign in, so this is the
only account identity we ever receive. The reasoning is in
[`../docs/PLAN.md`](../docs/PLAN.md) section 4a, and the configuration steps are
in [`../docs/runbooks/workos-setup.md`](../docs/runbooks/workos-setup.md).

The earlier `[CONFIRM]` on this paragraph is resolved: `docs/PLAN.md` section 4
recorded a "social plus magic link" plan, and section 4a now supersedes it with
magic link only. The decision is enforced rather than documented, by a test that
fails if any password, social, passkey or SSO route is ever registered and by a
database constraint on `users.auth_method`, so this paragraph cannot quietly
stop matching the deployed configuration. If social sign-in were ever turned on,
this section would have to change, because the provider would then also tell us
which third-party account you used.

| What                                                                       | Where it is stored   | Source |
| -------------------------------------------------------------------------- | -------------------- | ------ |
| A stable identifier from WorkOS (`workos_user_id`)                         | `users` table        | WorkOS |
| Your email address (lower-cased)                                           | `users.email`        | WorkOS |
| A display name, formed from the first and last name your provider supplied | `users.display_name` | WorkOS |
| Account created and updated timestamps                                     | `users`              | us     |

**We never receive, store, or create a password.** There is no password column,
no password hash, and no password reset flow, deliberately: Pull.fm issues no
passwords at all.

WorkOS is a **processor** acting on our instructions, under the WorkOS Data
Processing Addendum published at
[workos.com/legal/dpa](https://workos.com/legal/dpa). That addendum is
incorporated into the WorkOS agreement automatically and needs no separate
signature: "Each party's execution of the Agreement shall be considered a
signature to the Standard Contractual Clauses to the extent that the Standard
Contractual Clauses apply hereunder."

Two things in that addendum are worth stating plainly rather than leaving in a
document nobody reads:

- WorkOS may process your data "for its internal uses to build or improve the
  quality of its services", to detect security incidents, and to protect against
  fraud. That is a **broader permission than "only on our instructions"**, and it
  is theirs, not ours. **The addendum does not say anything either way about
  training AI or machine-learning models on it.** We have not obtained a separate
  commitment on that point, so we do not claim one.
- Under the CCPA, WorkOS commits **not to "sell" or "share"** your personal data,
  not to retain or use it for any purpose other than providing the service, and
  not to combine it with data it gets from anyone else.

### 3.2 Connected music services

If you connect **ListenBrainz** or **Last.fm**, we store, in `user_connections`:

| What                                                                                      | Notes                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Which provider (`listenbrainz` or `lastfm`)                                               | plain text                                              |
| Your username at that provider (`provider_account_id`)                                    | plain text; not a secret, and needed to build API calls |
| **The access credential, encrypted** (`access_token_ct`)                                  | AES-256-GCM ciphertext. See section 4.                  |
| **The refresh credential, encrypted** (`refresh_token_ct`), where the provider issues one | AES-256-GCM ciphertext                                  |
| Credential expiry, granted scopes, connection status, last verification time, last error  | plain text                                              |

Connecting is entirely optional, and you can disconnect at any time, which
deletes our copy of the credential.

**We use those credentials only** to read the data needed to generate
recommendations for you, on your behalf. We do not use them to write to your
account at the provider, and we do not use them for anything unrelated to
serving you.

### 3.3 Listening-derived data

Pull.fm's purpose is to turn what you listen to into recommendations. This is
what actually happens today, stated precisely because it is the claim a policy
most often gets wrong:

- We read listening data from ListenBrainz and Last.fm using the credential you
  supplied, at the time a request needs it.
- **We do not currently maintain a per-user store of your listening history.**
  There is no listening-history table in the schema. Responses from upstream
  providers are cached in a table (`upstream_cache`) that is keyed by provider
  and content, has no user column, and is not linked to you.
- The recommendation and feed endpoints that would consume this data are
  **currently not implemented** and return HTTP 501.

`[OPEN]` If a future release stores per-user listening history, ranking state,
or an inferred taste profile, **this section must be rewritten before that ships,
and those rows must cascade on user deletion**, or the deletion claim in section
7 becomes false. Note also that a user-scoped `upstream_cache` key would put
user-linked rows in a table the deletion cascade does not touch.

### 3.4 What you create in Pull.fm

| What                                                                                                                                                       | Where            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Wishlist entries: artist name, title, MusicBrainz identifiers, how it got there, status, and your free-text note                                           | `wishlist_items` |
| Personal API tokens you create: your label for it, its scopes, its rate limit, expiry, when it was last used, and **the IP address it was last used from** | `api_tokens`     |

We store **only a SHA-256 digest** of a personal API token, never the token
itself. The last-used IP is recorded at most once per minute per token.

### 3.5 Operational and security data

| What                                                                                                                                                                                                                                            | Where                    | Why                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Request logs: request id, method, path (**query string stripped**), response status, **your IP address**, and your user agent                                                                                                                   | application logs         | Debugging and abuse investigation. The query string is stripped because it can carry a search term or a credential.                      |
| Web server access logs                                                                                                                                                                                                                          | nginx on the origin node | Same                                                                                                                                     |
| An audit record of credential-affecting events: account deletion, export requested, export downloaded, sign-in callback, rejected webhook. Each holds an internal user id, the action, the outcome, non-secret context, and **your IP address** | `audit_log`              | So that a security incident produces a scoped, evidenced answer rather than a mass "rotate everything" notice                            |
| A record that a deletion happened: the internal id of the deleted account, when it was requested and completed, and how many rows went                                                                                                          | `deletion_log`           | To prove erasure occurred, and to re-apply it if a backup is ever restored                                                               |
| Short-lived rate-limit counters, an export cooldown counter, single-use export ticket claims, and session revocations                                                                                                                           | Redis                    | Abuse prevention and sign-out. Keys contain opaque identifiers; values expire between 60 seconds and the remaining life of your session. |
| An idempotency record for each mutating request: your key, a hash of the request, and the response we returned                                                                                                                                  | `idempotency_keys`       | So a retry on a flaky mobile connection does not create a duplicate. **Expires after 24 hours.**                                         |

**IP addresses are personal data and we treat them as such.** We keep them
because a service that spends a third party's rate-limited quota cannot
investigate abuse without them; that is the legitimate interest relied on in
section 6.

### 3.6 What we do not collect

Stated because absence is a feature and an absent thing is invisible:

- **No advertising or analytics of any kind.** No Google Analytics, no Segment,
  no PostHog, no Mixpanel, no Amplitude, no session replay, no ad SDK, no
  fingerprinting.
- **No third-party crash or error reporting service.** Errors go to our own
  logs.
- **No precise location.** We never ask for or store GPS coordinates. The live
  events feature, if enabled, accepts a **city name only**, and the backend
  rejects coordinate-shaped input outright, because our events provider's terms
  forbid personal data reaching their API.
- **No contacts, photos, calendar, microphone, or device identifiers.**
- **No special-category data** (health, biometrics, political opinion, religion,
  sexual orientation) is asked for. Musical taste can be revealing, which is why
  we treat it as sensitive in practice even though it is not a special category
  in law.
- **No passwords.**
- **No payment data.** Pull.fm is free and takes no payments.

---

## 4. How connected-service credentials are protected

This is the highest-value data in the system, and it is not ours: a Last.fm
session key is a credential on **your** Last.fm account, and Last.fm session keys
do not expire. So it gets its own section.

- Each credential is encrypted with **AES-256-GCM** under a **per-record data
  key**, and that data key is itself encrypted by an application-wide key that
  never enters the database. This is "envelope encryption": the database holds
  ciphertext and a wrapped key, and neither is usable without the application
  key.
- The encryption is **bound to your account, the provider, and the specific
  column**. Moving one user's ciphertext onto another user's row does not
  decrypt; it fails authentication.
- Credentials are **never written to logs, traces, error messages, or support
  transcripts.** The logger redacts a fixed list of field names, and a static
  analysis rule fails the build if a credential-shaped value reaches a logger.
- Credentials are **excluded from your data export** on purpose. Section 5
  explains why, since that is a deliberate restriction of a right you have.
- The application key is held outside the database and escrowed. `[OPEN]` The
  escrow currently has a **single holder** (the operator), which is recorded as
  an accepted risk in the public register at
  [`../security/accepted-risks.md`](../security/accepted-risks.md)
  (`PULLFM-RISK-003`).

---

## 5. Your data export, and what it deliberately leaves out

`GET /v1/me/export` produces a JSON document containing:

- **Account**: internal id, email, display name, created and updated timestamps.
- **Connections**: provider, your username there, status, scopes, and the
  created / last-verified / expiry timestamps.
- **Wishlist**: every entry, in full, including your notes.
- **API tokens**: id, label, prefix, last four characters, scopes, and the
  created / expiry / last-used / revoked timestamps.

It **deliberately excludes**:

- third-party access tokens and refresh tokens;
- Last.fm session keys;
- personal API token secrets, and even their digests;
- envelope encryption material (wrapped data keys, key identifiers).

**Why, in plain terms.** GDPR Article 20 gives you the right to receive the
personal data **you provided**, in a machine-readable format. A ListenBrainz
token is not information about you; it is a bearer credential for someone else's
system, which you can regenerate at that system in under a minute. If we put it
in the export, then a single stolen copy of that file would become a permanent
takeover of your Last.fm and ListenBrainz accounts, invisible to us, on systems
we do not control and cannot revoke. You lose nothing you cannot recover at the
source; the alternative risks something you cannot undo.

The export document says this in its own `notice` field, so the exclusion is
visible to the person receiving the file and not only to whoever reads this
policy.

**How it is delivered.** The export request returns a **single-use download link
valid for about 10 minutes**, rather than the document itself, and you can
request one at most once every 5 minutes. The download is served with
`Cache-Control: no-store`. A personal API token **cannot** request or download an
export; that requires an interactive session.

---

## 6. Why we are allowed to process this (GDPR legal bases)

| Purpose                                                                      | Data                                          | Basis                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create and operate your account                                              | identity from WorkOS                          | **Contract** (Art. 6(1)(b))                                                                                                                                                                                                                                                   |
| Connect a music service and generate recommendations                         | connection credential, your provider username | **Contract**, on your explicit instruction to connect                                                                                                                                                                                                                         |
| Keep your wishlist                                                           | wishlist entries                              | **Contract**                                                                                                                                                                                                                                                                  |
| Personal API tokens                                                          | token metadata, last-used IP                  | **Contract**                                                                                                                                                                                                                                                                  |
| Security, abuse investigation, protecting a third party's rate-limited quota | logs, IP, user agent, audit records           | **Legitimate interests** (Art. 6(1)(f)). Balancing: the interest is keeping the service usable for everyone and not losing the upstream licences the product depends on; the data is limited to what identifies a request source; nothing is used for profiling or marketing. |
| Proving an erasure happened                                                  | `deletion_log`                                | **Legal obligation** (Art. 6(1)(c)) and legitimate interests                                                                                                                                                                                                                  |
| Complying with law                                                           | as required                                   | **Legal obligation**                                                                                                                                                                                                                                                          |

**There is no processing for marketing, advertising, profiling for advertising,
or automated decision-making with legal or similarly significant effects.**
Recommendation ranking is automated, but it decides what music to show you and
nothing else.

---

## 7. Deleting your account

`DELETE /v1/me` (or "delete account" in the app) is irreversible, and it does the
following, in this order:

1. A **deletion record is written first**, so that a failure part-way through
   leaves a durable, retryable record that you asked to be erased.
2. A **single database transaction** deletes your `users` row. Every table that
   holds your data declares `ON DELETE CASCADE`, so your connections, wishlist,
   API tokens, idempotency records, and in-flight connect state go with it,
   atomically, rather than in an application sweep that can half-fail. This is
   asserted against a real database on every CI run.
3. Your identity is **deleted at WorkOS**. If that call fails, your local data is
   still gone and the failure is recorded so it can be retried.
4. Redis keys scoped to you are removed from both instances.

Because deletion is irreversible, the route requires: an **interactive session**
(a read-only personal API token is refused), a **recent sign-in** (within 15
minutes by default), and **your account email typed back** in the request.

If your identity is deleted at WorkOS instead, a signed webhook triggers the same
cascade here, so an account deleted upstream does not leave orphaned data.

### What survives deletion, honestly

| Survives                             | Contains                                                                                                                                                                                                      | Why                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deletion record** (`deletion_log`) | the internal id of the deleted account, timestamps, row counts                                                                                                                                                | To demonstrate erasure, and to re-apply it if a backup is restored                                                                                                      |
| **Audit records** (`audit_log`)      | today: the internal id of the deleted account, the action, the outcome, and **the IP address** of the request. Intended: the same rows with the id replaced by an irreversible pseudonym and the IP truncated | Security evidence must survive the deletion it records, or a hostile deletion erases its own trail. Deleting an account is a plausible last step of an account takeover |
| **Encrypted backups**                | your rows, as they were at backup time                                                                                                                                                                        | See below                                                                                                                                                               |
| **Logs**                             | request id, internal id, IP, user agent - no email, no credential                                                                                                                                             | See section 8                                                                                                                                                           |

`[OPEN]` **`audit_log` currently has no retention limit and is never purged.**
That means an IP address linked to an internal account identifier persists
indefinitely after the account is deleted. This is not defensible as written.

The fix is designed and specified in
[`../docs/compliance/data-retention-policy.md`](../docs/compliance/data-retention-policy.md):
audit rows are kept, but the identifiers in them are removed after a bounded
window. The internal account id is replaced by a random pseudonym that exists
nowhere else and cannot be reversed by anyone including us, and the IP address is
truncated to its network prefix. Full-fidelity rows last 90 days, or 30 days
after an account is deleted, whichever comes first; anonymized rows are hard
deleted at 400 days. **That specification is not implemented yet.** Until it is,
the true statement is the one above, and **this policy must not be published**
with a retention promise the code does not keep.

### Backups

Encrypted backups are retained for a point-in-time-recovery window, and **we do
not selectively rewrite them.** Rewriting a backup destroys the integrity that
makes it a backup, and the attempt would be a larger risk to every other user's
data than the residual retention is to yours. This is the position regulators
accept, and it comes with three commitments that make it meaningful:

1. Backups are **put beyond use**: encrypted at rest, access-controlled with a
   credential that is not the database credential, and never queried to serve
   live traffic.
2. Retention is **bounded**: your data disappears from the backup set when the
   last backup containing it ages out.
3. **A restore replays the deletions.** Before a restored system serves traffic,
   every account in the deletion record is re-deleted. That is what makes the
   erasure durable rather than merely apparent.
4. A restored backup yields your connected-service credentials **only as
   ciphertext**, under a key that was never in the database.

`[OPEN]` **The retention window has no number.** The database is now hosted by
Neon, so the point-in-time-recovery window is a Neon project setting rather than
something this repository configures, and it has not been recorded anywhere. This
policy must state a specific window (for example "up to 30 days") before
publication, and that number must be the one actually set on the project.

---

## 8. How long we keep things

| Data                                                        | Retention                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account, connections, wishlist, API tokens                  | Until you delete them or delete your account                                                                                                                                                                                                                                                                                                 |
| Idempotency records                                         | `[OPEN]` They stop being **valid** after 24 hours, which the schema does enforce, but nothing **deletes** them, so the row (including the cached response body) survives until you delete your account. A sweeper is specified in the retention policy and is not built.                                                                     |
| In-flight connect state                                     | `[OPEN]` Same shape: expiry is checked on read, minutes after issue, but the row is never deleted.                                                                                                                                                                                                                                           |
| Redis rate-limit counters, export cooldowns, export tickets | 60 seconds to about 11 minutes                                                                                                                                                                                                                                                                                                               |
| Session revocations in Redis                                | Until the revoked session would have expired anyway                                                                                                                                                                                                                                                                                          |
| Application and web server logs                             | `[OPEN]` **No retention period is configured anywhere in the system today.** Logs are intended to ship to a hosted log service, and no numeric retention exists in infrastructure code. A number must be set and stated here before publication; a policy that says "we keep logs for N days" while nothing enforces N is a false statement. |
| Audit records                                               | `[OPEN]` **Indefinite today.** The intended position is 90 days at full fidelity, or 30 days after account deletion, then anonymized, then hard deleted at 400 days. See section 7.                                                                                                                                                          |
| Personal API token last-used IP                             | `[OPEN]` Kept for the life of the token today. Intended: cleared 90 days after the token was last used.                                                                                                                                                                                                                                      |
| Deletion records                                            | Indefinite. They hold an internal identifier and timestamps, and nothing else.                                                                                                                                                                                                                                                               |
| Encrypted backups                                           | `[OPEN]` The point-in-time-recovery window, once configured. See section 7.                                                                                                                                                                                                                                                                  |
| Identity data held by WorkOS                                | Deleted when you delete your account. On termination of our agreement with them, their addendum commits them to delete it other than backup and archival copies, which go on their own schedule. `[OPEN]` That schedule is not published.                                                                                                    |

The full schedule, the reasoning behind each number, and the legitimate-interest
assessment for the security audit trail are in
[`../docs/compliance/data-retention-policy.md`](../docs/compliance/data-retention-policy.md).

---

## 9. Where your data is, and who else touches it

**The honest version has two halves, and a policy that gives only the first half
is misleading.** Everything you create in Pull.fm stays in the European Union.
Your identity, meaning your email address, your name, and the record of your
sign-ins, is processed in the **United States** by WorkOS. There is no EU
residency option for that, so this policy states it rather than implying
otherwise.

### Where each thing actually sits

| Data                                                                                         | Where                                                          | Leaves the EU?                               |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Account row, connected-service credentials, wishlist, API tokens, audit and deletion records | **Neon** Postgres, **Frankfurt, Germany** (`aws-eu-central-1`) | No                                           |
| Cache and rate-limit counters                                                                | Application servers in the EU                                  | No                                           |
| Application servers                                                                          | **Hetzner Cloud**, EU sites only                               | No                                           |
| Encrypted database backups                                                                   | Neon's own backups, and object storage in an EU jurisdiction   | No                                           |
| **Email address, name, sign-in events, session records**                                     | **WorkOS, United States**                                      | **Yes.** See "International transfers" below |
| Operator access                                                                              | From the United States, by one person                          | Access, not storage. See below               |

Two structural guarantees behind the EU rows, rather than a promise:

- The Neon project's region is chosen at creation and **Neon does not permit
  changing the region of an existing project**, so residency is a property of the
  project rather than a setting somebody could flip.
- The infrastructure code for the application servers **refuses to build** in a
  non-EU Hetzner site: the location variable is validated against an EU-only
  list, so a US or APAC region is a hard error rather than a configuration slip.

`[OPEN]` The Terraform in this repository still contains the earlier
self-hosted-Postgres layout from before the move to Neon, and the staging stack
is currently down. That is an inconsistency in the infrastructure code, not in
this description, but the two must agree before publication.

### International transfers

**To WorkOS (United States).** Under the WorkOS Data Processing Addendum,
"Subscriber authorizes WorkOS and its Subprocessors to transfer Subscriber
Personal Data across international borders, including from the European Economic
Area, Switzerland, and/or the United Kingdom to the United States." The addendum
names the United States as the destination and offers no EU-residency
alternative.

The transfer is legitimized by:

| Instrument                                                                 | Role                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **EU Standard Contractual Clauses, Module Two** (controller to processor)  | Covers us, as controller, transferring your identity data to WorkOS as our processor. This is the operative one |
| **EU Standard Contractual Clauses, Module Three** (processor to processor) | Covers WorkOS passing data to its own subprocessors                                                             |
| **UK International Data Transfer Addendum**                                | Extends the same protection to transfers out of the United Kingdom                                              |
| The SCCs applied "mutatis mutandis"                                        | Extends them to Swiss law                                                                                       |

They take effect without a separate signing ceremony: executing the WorkOS
agreement is treated as signing the SCCs. **The United States has no adequacy
decision covering this transfer**, so the SCCs are the mechanism, not a
supplement to one.

WorkOS's own subprocessors are listed at
[workos.com/legal/subprocessors](https://workos.com/legal/subprocessors), and the
addendum gives **fourteen calendar days** to object before a new subprocessor is
engaged. We check that list; you can too.

Under the same addendum WorkOS commits to security measures consistent with a
SOC 2 Type II programme, to notify us of a security incident "without undue
delay", to delete personal data at the end of the agreement other than backup and
archival copies, and to answer an audit once a year by completing a data
protection questionnaire.

`[OPEN]` We have not enumerated the WorkOS subprocessor list here, because it is
served from a trust centre that cannot be read as plain text. Before publication,
read it and name any subprocessor that would surprise a reader.

**Operator access from the United States.** 312.dev LLC is a US company, so the
controller sits outside the EU even for the data that never leaves it: the
operator can read the EU database from the United States in the course of running
the service. `[CONFIRM with counsel: the appropriate mechanism for
controller-side remote access from the US, and whether an intra-controller
transfer of this kind needs one at all.]`

### Service providers (processors and sub-processors)

| Provider                     | What they handle                                                                    | Where                                             | Written processor contract                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neon** (database)          | Every application table, and the backups of it                                      | Frankfurt, Germany (EU)                           | `[OPEN]` Not on file                                                                                                                              |
| **Hetzner Online GmbH**      | Application servers, cache                                                          | EU sites only                                     | `[OPEN]` Not on file                                                                                                                              |
| **Cloudflare, Inc.**         | DNS, TLS termination, edge protection, and object storage holding encrypted backups | Global edge; backups in an EU jurisdiction bucket | `[OPEN]` Not on file                                                                                                                              |
| **WorkOS, Inc.**             | Authentication and identity                                                         | United States                                     | The published DPA, incorporated automatically. `[CONFIRM]` that the WorkOS agreement itself is executed, and keep a dated copy of the DPA on file |
| **GitHub, Inc. (Microsoft)** | Source hosting and release distribution. Handles no user data.                      | United States                                     | Not required                                                                                                                                      |

`[OPEN]` Article 28 requires a written processor contract with each of them.
**Neon, Hetzner, and Cloudflare are still outstanding.** WorkOS is covered by an
addendum that applies by its own terms, which is the exception rather than the
pattern, and it should still be downloaded, dated, and filed so that what we
agreed to is provable later.

### Upstream data sources (not processors)

**ListenBrainz/MetaBrainz, MusicBrainz, Last.fm, Apple/iTunes, Deezer, and
SeatGeek** supply data to Pull.fm. They are not processing your data on our
behalf, with one important exception: when you connect ListenBrainz or Last.fm,
**we call their API as you**, so those calls are visible to them as your
activity, under your relationship with them.

We deliberately send them as little as possible:

- MusicBrainz, iTunes, Deezer, and SeatGeek are queried with **content
  identifiers only**, never with anything identifying you.
- The live events integration is **contractually forbidden from receiving
  personal data**, which is why it takes a city name and no coordinate or postal
  code, and why the code rejects coordinate-shaped input before a URL is built.
- Live event data is **not** currently served: that endpoint returns HTTP 501,
  and no events provider is enabled on this deployment.

**We do not sell or share your personal information, in any sense, including the
broad definitions of "sell" and "share" under the CCPA.** There is no advertising
partner, no data broker, no measurement partner, and no revenue model at all.

---

## 10. Your rights

### If the GDPR applies to you (EU/EEA, UK)

You have the right to **access**, **rectify**, **erase**, **restrict**, **object
to**, and **port** your personal data, and to **withdraw consent** where consent
is the basis.

Two of these you can exercise yourself, immediately, without asking us:

| Right                                    | How                                                 |
| ---------------------------------------- | --------------------------------------------------- |
| **Access and portability** (Art. 15, 20) | `GET /v1/me/export`, or "export my data" in the app |
| **Erasure** (Art. 17)                    | `DELETE /v1/me`, or "delete account" in the app     |

For rectification, restriction, or objection, email `ope@312.dev`. We respond
within **one month**, as Article 12 requires.

You may complain to your **supervisory authority**. `[CONFIRM: the lead
authority, which follows from the Article 27 representative decision in
section 2.]`

### If the CCPA/CPRA applies to you (California)

You have the right to **know** what we collect and why, to **delete** it, to
**correct** it, to **opt out of sale or sharing**, and to **not be
discriminated against** for exercising any of them.

- **Know** and **delete**: the same two endpoints above.
- **Opt out of sale or sharing**: there is **nothing to opt out of**. We do not
  sell or share personal information, and we have not in the preceding 12
  months. There is therefore no "Do Not Sell or Share My Personal Information"
  link, because there is no such processing to disable.
- **Sensitive personal information**: we do not collect it, and we do not use
  any information for purposes that would trigger the right to limit its use.
- **No financial incentives** are offered for personal data.

### Other jurisdictions

If your local law gives you comparable rights, exercise them at the same address
and we will apply them.

### Response times, stated honestly

Pull.fm is operated by one person with no support team. The self-service export
and deletion endpoints are instant and always available, which is deliberate:
the two rights that matter most do not depend on our availability. Emailed
requests are answered within the legal deadline, but not within hours.

---

## 11. Children

Pull.fm is not for children. You must be at least **16**. We do not knowingly
collect personal data from anyone younger, and if we learn we have, we delete the
account. If you believe a child has an account, email `ope@312.dev`.

---

## 12. Security

The full threat model and the accepted-risk register are **public** in this
repository, which is unusual and intentional: a design that only survives being
secret is not a design.

- Third-party credentials are encrypted at rest under per-record keys (section 4).
- The service is **HTTPS only**, with modern TLS and HSTS.
- Every user-scoped route is tested against an automated authorization suite that
  fails the build if any route is untested.
- Secret scanning, static analysis, dependency scanning, and dynamic scanning run
  in continuous integration.
- Vulnerability reports are handled under [`../SECURITY.md`](../SECURITY.md),
  which includes a safe harbour for good-faith research.

**Known limits, published rather than implied:** the operator is a single point
of failure for key custody, and the hosting account is shared with unrelated
personal services. Both are recorded, with expiry dates for re-decision, in
[`../security/accepted-risks.md`](../security/accepted-risks.md).

### If there is a breach

If a breach is likely to result in a risk to your rights and freedoms, we will
notify the relevant supervisory authority **within 72 hours** of becoming aware
of it, and notify you directly without undue delay where the risk is high. Where
a breach affects data supplied by a partner whose contract requires faster
notice, we meet that shorter deadline too.

---

## 13. Changes

We will update this policy when the system changes. The "Last updated" date moves
and the previous version stays in this repository's public git history, so you
can see exactly what changed and when, which is a stronger guarantee than a
changelog we write about ourselves.

For a **material** change we will give notice in the application before it takes
effect.

---

## 14. Contact

**312.dev LLC**
Privacy: `ope@312.dev`
Security: see [`../SECURITY.md`](../SECURITY.md)

---

## Appendix: open items blocking publication

A checklist, so that nothing above is quietly published while still untrue.

| #   | Item                                                                                                                                                                  | Section |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `audit_log` retains an IP address linked to a deleted account, indefinitely. Designed in `docs/compliance/data-retention-policy.md`, **not implemented**.             | 7, 8    |
| 2   | No log retention period is configured anywhere. A number must exist in the system before it is stated here.                                                           | 8       |
| 3   | The Neon point-in-time-recovery window has no recorded value.                                                                                                         | 7, 8    |
| 4   | No data processing agreements are on file with **Neon, Hetzner, or Cloudflare**. WorkOS is covered by an addendum that incorporates automatically; file a dated copy. | 9       |
| 5   | No EU Article 27 representative is appointed.                                                                                                                         | 2       |
| 6   | Controller's state of organisation, postal address, and governing supervisory authority are unfilled.                                                                 | 2, 10   |
| 7   | The US-access transfer mechanism for controller-side access is undecided. The WorkOS transfer itself is settled: SCCs Modules Two and Three plus the UK Addendum.     | 9       |
| 8   | Expired `idempotency_keys` and `connect_states` rows are never deleted, so section 8's retention line was wrong and is now marked open.                               | 8       |
| 9   | The sign-in methods sentence must be checked against the launch configuration, and `docs/PLAN.md` section 4 disagrees with it today.                                  | 3.1     |
| 10  | The WorkOS subprocessor list has not been read and summarized.                                                                                                        | 9       |
| 11  | WorkOS may use personal data "to build or improve the quality of its services", and their addendum is silent on AI/ML training. Decide whether to seek a commitment.  | 3.1, 9  |
| 12  | Terraform still describes the pre-Neon self-hosted database. Infrastructure and this document must agree.                                                             | 9       |
| 13  | This document has not been reviewed by a lawyer.                                                                                                                      | all     |
