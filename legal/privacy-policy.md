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
>
> **Before publishing, run `make legal`** (or
> `node legal/check-publication-blockers.mjs`). It exits non-zero while any
> marker remains, prints each with a file and line, and flags the ones that are
> void or misleading rather than merely incomplete.
>
> **This document was rewritten on 2026-07-29 for a United States posture.** The
> earlier version was written for a service offered in the European Union, and
> the GDPR analysis in it is gone rather than softened. Section 9 states the
> basis for that, section 10 states which United States laws were checked and
> which of them Pull.fm is below the threshold of, and neither claim is made
> without saying how it was reached.
>
> **Of the two changes the posture depends on, one has landed and one has not.**
> Registration from the EEA, the United Kingdom and Switzerland is refused by
> code, covered by tests, and described in section 9 including what it cannot do.
> **The infrastructure has not moved**; the placements in section 9 are the
> intended end state and the repository still pins everything to the European
> Union, which is marked `[OPEN]` there.
>
> 312.dev LLC is organised in **Illinois**, which the operator supplied on
> 2026-07-29. That settles the controller identity here and the governing law and
> venue in `terms-of-service.md` section 16. **The postal address is still
> unfilled** and is a separate fact.

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
- **Pull.fm is offered to residents of the United States.** Registration from the
  European Economic Area, the United Kingdom and Switzerland is refused. Section
  9 states what that means for which laws apply, and says plainly which part of
  it is built and which part is not yet.
- **Where your data sits is three different answers, not one**, and section 9
  gives each separately rather than flattening them. The database is pinned to a
  **United States region**. The object storage holding backups is **not pinned to
  any jurisdiction**, which means Cloudflare may hold those objects anywhere.
  Every request passes through a **global** content delivery network on its way
  in. Your identity data, meaning your email address, your name and your sign-in
  events, is handled for us by **WorkOS in the United States**.
- You can **export** your data (`GET /v1/me/export`) and **delete** your account
  (`DELETE /v1/me`) yourself, from the API or the app, without asking us. Both
  are self-service; section 6 sets out what the export contains, what it
  deliberately leaves out, and the conditions each route applies.

The rest of this document is the detail behind those points.

---

## 2. Who is responsible for your data

**312.dev LLC**, a limited liability company organised under the laws of
**Illinois, United States**, is responsible for your personal data.

|                   |                                                                                                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responsible party | 312.dev LLC, Illinois, United States                                                                                                                                                                                                                                                                  |
| Contact           | `ope@312.dev`                                                                                                                                                                                                                                                                                         |
| Postal address    | **Not published. Contact is by email.** This is a stated choice rather than an omission, and the reasoning is below. The row is kept so an address can be dropped into it later without rewriting anything.                                                                                           |
| Territorial scope | Pull.fm is offered to residents of the **United States**, and we refuse to create an account for anyone who appears to be in the **EEA**, the **United Kingdom** or **Switzerland**. Section 9 explains what that refusal does, what it does not do, and why the rest of this document depends on it. |

**Why there is no postal address, and the one thing that would change it.**
Earlier versions of this document carried a placeholder here, on the grounds that
a postal address is "required for a published policy in several jurisdictions".
That was true of the GDPR posture and it is not carried forward, because keeping
a requirement that no longer exists makes a document wrong in the same way that
deleting one that does. What was actually checked:

- **CalOPPA** (California Business and Professions Code section 22575(b)) sets
  out what a posted privacy policy must contain. **It does not require a postal
  address.** Checked against the statute.
- **CCPA** permits a business that operates exclusively online and has a direct
  relationship with the consumer to offer an email address as the only method for
  submitting requests. Pull.fm is below its threshold in any case (section 10).
- **Illinois PIPA** does not require one. **BIPA's** published-retention-policy
  duty attaches only to an entity in possession of biometric identifiers, and
  Pull.fm has none.
- **App store rules** would require one, and they do not apply: Pull.fm is
  distributed as signed GitHub Release assets rather than through any store.
  **This is a load-bearing assumption. The day Pull.fm enters an app store, a
  postal address becomes mandatory** and this row has to be filled.
- **CAN-SPAM** (15 U.S.C. section 7704(a)(5)(A)(iii)) requires "a valid physical
  postal address of the sender", but only in a **commercial** electronic mail
  message. A magic-link sign-in code is a transactional message and is outside
  that definition. **The obligation attaches on the first marketing email Pull.fm
  ever sends, and not before.** Nobody would think of sending an announcement to
  their users as a legal event, which is exactly why it is written down here.
  Checked against the statute.

So the address is withheld deliberately, and the two things that would reverse
that decision are named above rather than left to be rediscovered. Separately,
312.dev LLC's registered agent address is already public record at the Illinois
Secretary of State, so publishing it would cost nothing in privacy terms; whether
to do so anyway is the operator's call and has not been made.

**Why there is no Data Protection Officer and no Article 27 representative.**
Both are GDPR offices, and neither is required of a controller the GDPR does not
reach. Section 9 sets out the basis for saying it does not reach Pull.fm, which
is Article 3(2) rather than anything about where the servers are, and states the
one condition that basis depends on. Earlier drafts of this document recorded the
absence of an Article 27 representative as a gap; it is not a gap under this
posture, and the thing that is actually missing, the registration refusal itself,
is recorded above instead.

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

The earlier open question on this paragraph is resolved: `docs/PLAN.md` section 4
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

WorkOS is a **service provider** acting on our instructions, under the WorkOS
Data Processing Addendum published at
[workos.com/legal/dpa](https://workos.com/legal/dpa). That addendum is
incorporated into the WorkOS agreement automatically and needs no separate
signature.

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

| What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Where                    | Why                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request logs: request id, method, path (**query string stripped**), response status, **your IP address**, and your user agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | application logs         | Debugging and abuse investigation. The query string is stripped because it can carry a search term or a credential.                                                 |
| Web server access logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | nginx on the origin node | Same                                                                                                                                                                |
| An audit record of credential-affecting events, from a closed list defined in [`../apps/bff/src/lib/audit.ts`](../apps/bff/src/lib/audit.ts): sign-in code requested, verified or failed; sign-in callback; session refreshed or revoked; profile updated; connection started, created, connected or deleted; personal API token created, rotated, revoked or used after expiry; export requested or downloaded; account deleted; deletion webhook accepted or rejected; unverified directory record reaped. Each holds an internal user id (or none, for the events that have no signed-in subject), the action, the outcome, non-secret context, and **your IP address** | `audit_log`              | So that a security incident produces a scoped, evidenced answer rather than a mass "rotate everything" notice                                                       |
| A record that a deletion happened: the internal id of the deleted account, when it was requested and completed, and how many rows went                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `deletion_log`           | To prove erasure occurred, and to re-apply it if a backup is ever restored                                                                                          |
| Short-lived rate-limit counters, an export cooldown counter, single-use export ticket claims, and session revocations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Redis                    | Abuse prevention and sign-out. Keys contain opaque identifiers; values expire between 60 seconds and the remaining life of your session.                            |
| An idempotency record for each mutating request: your key, a hash of the request, and the response we returned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `idempotency_keys`       | So a retry on a flaky mobile connection does not create a duplicate. **Stops being valid after 24 hours, and the row is deleted an hour after that.** See section 8 |

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
- **No biometric identifiers and no biometric information of any kind.** No
  voiceprint, no retina or iris scan, no fingerprint, no scan of hand or face
  geometry, and nothing derived from any of them. This negative is stated on its
  own line rather than folded into a list because 312.dev LLC is an Illinois
  company and the **Illinois Biometric Information Privacy Act** (740 ILCS 14)
  applies to a private entity regardless of its size or revenue and is enforced
  by private plaintiffs. It is also checkable rather than asserted: sign-in is an
  emailed one-time code, **passkeys and WebAuthn are not enabled** and a database
  constraint on `users.auth_method` plus a test refuse to let them be, and no
  column in any migration holds anything of this kind.
- **No health, political-opinion, religious or sexual-orientation data** is asked
  for. Musical taste can be revealing, which is why we treat it as sensitive in
  practice even though no United States statute classifies it that way.
- **No passwords.**
- **No payment data.** Pull.fm is free and takes no payments.

**A design constraint rather than a paperwork step.** If Pull.fm ever adds a
feature that uses voice, face or anything else BIPA covers, the Act's written
notice, written release and published retention schedule attach **before the
first collection**, not afterwards. There is no version of that feature that can
be shipped first and papered later, so it is recorded here as a constraint on
what may be built.

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
  an accepted risk (`PULLFM-RISK-003`). That register was public until
  2026-07-29 and is now held privately, for the reasons in
  [`../security/README.md`](../security/README.md); the gap it records is
  unchanged, and is stated here rather than only there.

---

## 5. Your data export, and what it deliberately leaves out

**No United States law currently requires Pull.fm to offer this** (section 10
explains why). It is offered anyway, as a matter of policy, because a service you
cannot get your own data out of is a service you cannot leave. It was built
before it was compelled and it is not being withdrawn now that it is not.

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

**Why, in plain terms.** What an export is for is giving you back the personal
data **you provided**, in a form a machine can read. A ListenBrainz
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

## 6. Why we hold each thing

**This is not a lawful-basis analysis, and it deliberately no longer is one.**
Earlier versions of this document mapped every purpose onto a GDPR Article 6
basis. United States privacy law does not work that way: it does not ask a
controller to select a basis before processing, so a table of Article 6 citations
in a document for United States residents would be borrowed vocabulary rather
than a statement about anything. The table is kept without the citations, because
what it actually says, which data is held for which purpose, is true either way
and is the part you can hold us to.

| Purpose                                                                      | Data                                          | Why                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create and operate your account                                              | identity from WorkOS                          | There is no account without it                                                                                                                                                    |
| Connect a music service and generate recommendations                         | connection credential, your provider username | Only on your explicit instruction to connect, and only for that                                                                                                                   |
| Keep your wishlist                                                           | wishlist entries                              | It is the feature                                                                                                                                                                 |
| Personal API tokens                                                          | token metadata, last-used IP                  | So a token you did not expect to be in use can be recognised as such                                                                                                              |
| Security, abuse investigation, protecting a third party's rate-limited quota | logs, IP, user agent, audit records           | A service that spends someone else's rate-limited quota cannot investigate abuse without them. Limited to what identifies a request source; never used for profiling or marketing |
| Proving an erasure happened                                                  | `deletion_log`, erasure ledger                | So that an erasure can be demonstrated, and re-applied if a backup is restored                                                                                                    |
| Complying with law                                                           | as required                                   | Including the breach-notification duties in section 12                                                                                                                            |

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

| Survives                             | Contains                                                                                                                                                                                                                                                                    | Why                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deletion record** (`deletion_log`) | the internal id of the deleted account, timestamps, row counts                                                                                                                                                                                                              | To demonstrate erasure, and to re-apply it if a backup is restored                                                                                                      |
| **Audit records** (`audit_log`)      | for the first 30 days after deletion: the internal id of the deleted account, the action, the outcome, and **the IP address** of the request. After that, the same rows with the id replaced by an irreversible random pseudonym and the IP truncated to its network prefix | Security evidence must survive the deletion it records, or a hostile deletion erases its own trail. Deleting an account is a plausible last step of an account takeover |
| **Encrypted backups**                | your rows, as they were at backup time                                                                                                                                                                                                                                      | See below                                                                                                                                                               |
| **Logs**                             | request id, internal id, IP, user agent - no email, no credential                                                                                                                                                                                                           | See section 8                                                                                                                                                           |

**`audit_log` has a retention limit, and it is enforced by code rather than by
intention.** Audit rows are kept, because a trail a user can erase by deleting
their account is worthless in exactly the case it exists for, but the
identifiers in them are removed after a bounded window:

- The internal account id is replaced by a **random pseudonym**. It is a fresh
  random UUID minted inside the database statement that applies it, once per
  account per batch, and written **nowhere else**. There is no key, no pepper,
  and no mapping table, so nobody, including us, can reverse it. A keyed hash
  was considered and deliberately rejected: because `deletion_log` permanently
  retains the id of every deleted account, a keyed scheme would be reversible by
  anyone who held both the key and that table. A random value has no such
  property, which is why it was chosen.
- The IP address is **truncated to its network prefix**: a `/24` for IPv4, a
  `/48` for IPv6. The host part is overwritten in place and is not recorded
  anywhere else.
- Rows that never had a signed-in subject (a rejected webhook, a reaped
  directory record, a failed sign-in attempt) carry no id to replace, so they
  get **no pseudonym**; their IP is truncated on the same schedule.

The windows: **90 days** at full fidelity, or **30 days** after the account is
deleted, whichever comes first, then anonymized in place; **400 days** from the
event, then hard deleted. The reasoning behind each number, and the
legitimate-interest assessment for keeping the rows at all, is in
[`../docs/compliance/data-retention-policy.md`](../docs/compliance/data-retention-policy.md).
The mechanism is
[`../apps/bff/src/services/audit-retention.ts`](../apps/bff/src/services/audit-retention.ts),
run by `pnpm --filter @pull-fm/bff purge:audit`, and it is covered by
integration tests against a real database that assert both what it must
anonymize and what it must refuse to.

`[OPEN]` **The schedule exists but has never fired, because no compute is
deployed to run it.** See the note at the end of section 8, which applies to
every window stated in this section. Until a run has actually happened, these
are the windows the system applies **when the job is run**, not periods after
which data has automatically gone, and this policy must not be published
stating them without that qualification.

### Backups

Encrypted backups are retained for a point-in-time-recovery window, and **we do
not selectively rewrite them.** Rewriting a backup destroys the integrity that
makes it a backup, and the attempt would be a larger risk to every other user's
data than the residual retention is to yours. This is the position regulators
accept, and it does not change with the jurisdiction: it is an argument about
what a backup is. It comes with three commitments that make it meaningful:

1. Backups are **put beyond use**: encrypted at rest, access-controlled with a
   credential that is not the database credential, and never queried to serve
   live traffic.
2. Retention of the automatic history is **bounded**: your data disappears from
   it when the last point in time containing it ages out.
3. **A restore replays the deletions, from a record kept outside the database.**
   Before a restored system serves traffic, every account in that record is
   re-deleted. This wording was corrected after a restore drill on 2026-07-29
   falsified the previous version, and the correction is worth stating plainly:
   the replay list used to be `deletion_log`, a table **inside** the database
   being restored, so rolling back past an erasure rolled back the erasure and
   the evidence of it at the same instant. That claim was not merely unverified,
   it was not satisfiable. The list now lives in object storage, one immutable
   object per erasure, and a drill confirmed it removes a resurrected account,
   rebuilds its `deletion_log` row, and leaves untouched the accounts that never
   asked to be deleted.

   **The residual gap this section used to record is closed.** The object used to
   be written by a job that ran every ten minutes, so an erasure completed inside
   that window and followed immediately by a restore could have been lost. It is
   now written **inline with the deletion, before anything is destroyed**: if
   that write fails the request returns 503 and deletes nothing, so you can tell
   "we did not delete you, retry" from "we deleted you and something else went
   wrong". Your erasure is durable at the moment you ask for it rather than at
   the next run of a job. The ten-minute job still runs, as a reconciler that
   backfills records predating the inline write and is the only thing that would
   notice the two records diverging.

4. A restored backup yields your connected-service credentials **only as
   ciphertext**, under a key that was never in the database.

**The point-in-time-recovery window is 6 hours.** The database is hosted by Neon,
which keeps a copy-on-write history rather than periodic snapshots, and the
window is set in this repository as `history_retention_seconds = 21600` in
[`../infra/neon/variables.tf`](../infra/neon/variables.tf). Six hours is the
ceiling on the plan in use, not a choice; raising it is a plan upgrade. In
practice that means a deletion is beyond point-in-time recovery within six hours
of being applied.

**There is a second backup path, and it now has numbers.** Alongside Neon's own
history, encrypted logical dumps of the database are written to object storage,
now on a daily schedule rather than by hand, and a bucket lifecycle rule expires
them after **35 days**. Daily follows from the retention figure rather than being
chosen next to it: what you can restore to is the window divided by the interval,
so daily gives about 35 recovery points inside 35 days where weekly would give
five. A dump taken by hand immediately before a deliberately destructive
operation is kept longer, **90 days**, because a dump taken to survive a
destructive operation has to outlive it.

`[OPEN]` **We can no longer read that lifecycle rule, so we can no longer verify
it.** The backup credential was deliberately narrowed to a bucket-scoped object
token, which fixed a separate finding where an account-wide grant turned out to
read every bucket in the estate. Reading a lifecycle configuration is a
bucket-admin operation, so that token is now refused it. Both figures are
therefore **configured but unconfirmed by us**, and this document must not state
them as
verified fact until the conformance check has been run from an operator
credential. [`../docs/api/deletion-and-backups.md`](../docs/api/deletion-and-backups.md)
records the same qualification, and the two must not drift apart.

---

## 8. How long we keep things

| Data                                                        | Retention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account, connections, wishlist, API tokens                  | Until you delete them or delete your account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Idempotency records                                         | They stop being **valid** after 24 hours, which the schema enforces, and the row itself, including the cached response body, is **deleted an hour after that**. The extra hour is slack against clock skew, so the sweep can never remove a record an in-flight request still considers valid. Enforced by `sweep:expired`, whose intended cadence is hourly. **See the scheduling note below.**                                                                                                                                       |
| In-flight connect state                                     | Same shape and the same job: `expires_at` is minutes after issue, and the row is deleted an hour past it. **See the scheduling note below.**                                                                                                                                                                                                                                                                                                                                                                                           |
| Redis rate-limit counters, export cooldowns, export tickets | 60 seconds to about 11 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Session revocations in Redis                                | Until the revoked session would have expired anyway                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Application and web server logs                             | `[OPEN]` **No retention period is configured anywhere in the system today.** Logs are intended to ship to a hosted log service, and no numeric retention exists in infrastructure code. A number must be set and stated here before publication; a policy that says "we keep logs for N days" while nothing enforces N is a false statement.                                                                                                                                                                                           |
| Audit records                                               | **90 days** at full fidelity, or **30 days** after your account is deleted, whichever comes first. Past that the row is anonymized in place: the account id is replaced by an irreversible random pseudonym and the IP is truncated to a `/24` or `/48`. The anonymized row is hard deleted **400 days** from the event. Applied by `purge:audit`, whose intended cadence is daily. See section 7 and **the scheduling note below**.                                                                                                   |
| Personal API token last-used IP                             | Cleared **90 days** after the token was last used, by setting the column to null in place. A token with an IP recorded but no recorded use is also cleared, because that state can only come from a bug and the safe resolution is to drop the IP. Applied by the same `purge:audit` job. **See the scheduling note below.**                                                                                                                                                                                                           |
| Deletion records                                            | Indefinite. They hold an internal identifier and timestamps, and nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Encrypted backups                                           | **6 hours** for Neon's point-in-time-recovery history. **35 days** for the daily encrypted logical dumps in object storage, and **90 days** for a dump taken by hand before a destructive operation, both enforced by a bucket lifecycle rule. `[OPEN]` We hold a bucket-scoped credential that is refused lifecycle reads, so both figures are configured but unverifiable by us today. See section 7.                                                                                                                                |
| Identity data held by WorkOS                                | Deleted when you delete your account. Separately, an address that was sent a sign-in code but never verified leaves an **unverified record at WorkOS and no account here**; `reap:unverified` deletes those once they pass `AUTH_UNVERIFIED_REAP_AFTER_S`, and **the scheduling note below applies to that job too**. On termination of our agreement with WorkOS, their addendum commits them to delete identity data other than backup and archival copies, which go on their own schedule. `[OPEN]` That schedule is not published. |

### `[OPEN]` The scheduling note, which qualifies five rows above

**The retention jobs are written, tested and scheduled, and no schedule has ever
fired, because no compute is deployed to run it.** This has to be stated rather
than glossed, because the difference between "a job exists" and "a job has run"
is the whole difference between a retention commitment and a retention
aspiration. Until the schedule has somewhere to run, the windows in the table
above are the windows the system applies **on each run**, not periods after
which data has automatically gone. The three stages are separated below so it
is clear which one is outstanding.

What exists: `purge:audit` (the audit anonymization, the 400-day delete, and the
token last-used-IP clearing), `sweep:expired` (the idempotency and connect-state
deletion), and `reap:unverified` (the unverified WorkOS records). All three are
real code with the windows above compiled in, all three are covered by
integration tests that run against a real database, all three are safe to run
twice and safe to interrupt, and all three refuse to run concurrently with
themselves. Run any one of them and it enforces exactly the numbers in this
table.

What now exists: **a schedule for each of them.** Every job has a systemd timer
committed to this repository, enabled by the application node's bootstrap, with
a run deadline shorter than its own interval so two runs cannot overlap. A CI
check asserts the units exist, are enabled rather than merely installed, and
expand to the intervals documented here.

What still does not exist: **anywhere for those timers to run.** No compute is
deployed, so no timer has ever fired. The schedule is real and dormant, not
running.

So the honest statement of the current position is: **these are the retention
windows the system applies each time the job is run, the schedule that will run
them is written and verified, and no run has yet happened because nothing is
deployed.** Until a deployment exists and a run is observed, this policy must not
state the windows above as unqualified promises, and the `[OPEN]` marker stays.
Closing it now requires evidence that a timer fired, not more configuration.

The full schedule, the reasoning behind each number, and the legitimate-interest
assessment for the security audit trail are in
[`../docs/compliance/data-retention-policy.md`](../docs/compliance/data-retention-policy.md).

---

## 9. Where your data is, who else touches it, and which country's law applies

### Why this document is no longer a GDPR document

Earlier versions of this policy were written for the General Data Protection
Regulation. They are not, and the sections that carried the Article 27
representative, the Chapter V transfer safeguards and the Standard Contractual
Clauses have been removed rather than softened. The basis for removing them is
below, so that it can be argued with rather than taken on trust.

**The GDPR reaches a company outside the Union through Article 3(2), which turns
on whether the company offers goods or services to people who are in the Union.
It does not turn on where the servers are.** That is the load-bearing point, and
it cuts both ways: moving the infrastructure to the United States does not by
itself put Pull.fm outside the GDPR, and leaving it in Frankfurt would not by
itself put Pull.fm inside it. What decides it is who the service is offered to.

Pull.fm's position is therefore built on the offering rather than the hosting:

- The service is **offered to residents of the United States**, and says so here
  and in the terms of service.
- **Registration from the EEA, the United Kingdom and Switzerland is refused**,
  in the running system and not only on this page. The next subsection sets out
  exactly what that control does.
- There is no targeting of any of those places. No European language, no
  European currency, no European marketing, no European top-level domain, and no
  payment of any kind since the service is free.

### What the registration refusal actually does

This is described in detail rather than asserted, because the whole territorial
analysis above rests on it and because it is easy to claim more for it than it
delivers.

**What it does.** Before Pull.fm contacts its identity provider, it checks the
country our content delivery network reports for the address the request came
from. If that country is on the restricted list, the request is refused
immediately with a plain explanation. **No account is created and no sign-in
email is sent**, and because the check runs first, **no record of the address is
created at the identity provider either.** That last point is structural rather
than a promise, and there is a test asserting the provider's directory does not
contain a refused address, alongside a control test proving an allowed address
does reach it.

**What the list covers.** The 30 EEA states, meaning the 27 EU member states plus
Iceland, Liechtenstein and Norway; the United Kingdom; Switzerland; **European
Union territory that geolocation reports under its own country code** rather than
its member state's, which is why Reunion, Mayotte, French Guiana, Guadeloupe,
Martinique, Saint Martin and the Aland Islands are named individually, since
without them the list would have holes; and the code our provider sends for a
European address it cannot resolve to a country.

**What it deliberately does not cover**, each after consideration: overseas
countries and territories associated with the EU rather than part of it, such as
Greenland, the Faroe Islands, Saint Barthelemy, Saint Pierre and Miquelon, New
Caledonia, Aruba, Curacao and Sint Maarten, none of which are within EU
territorial scope; and Gibraltar and the Crown Dependencies of Jersey, Guernsey
and the Isle of Man, which are not the United Kingdom and have their own data
protection regimes.

**What it is not, stated plainly.**

- **It refuses registration, not access.** Existing accounts keep working, no
  account was deleted, sessions still refresh, sign-out is never refused, and the
  rest of the API answers normally. This is not a traffic block.
- **It is IP geolocation, so it is not proof.** A virtual private network or a
  mis-located address defeats it in either direction. **This document does not
  claim that no resident of those regions can hold a Pull.fm account.** It claims
  that we do not knowingly open one, that we take reasonable measures not to, and
  that our intent is stated rather than inferred. That is what an address-based
  control can support, and claiming more would be the same kind of overstatement
  this document exists to avoid.
- **An undeterminable origin is refused, including Tor.** Otherwise the list
  would be optional.

**The three places are three separate legal regimes and the refusal has to name
all three**, which is why this document does not say "Europe":

| Territory                              | What it is                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **European Economic Area** (30 states) | The 27 EU member states plus **Iceland, Liechtenstein and Norway**, which are not in the EU but into which the GDPR is incorporated by the EEA Agreement |
| **United Kingdom**                     | Outside the EU since Brexit, with its **own UK GDPR** and Data Protection Act. An EEA list that omits it misses a separate statute, not a rounding error |
| **Switzerland**                        | Never in the EEA. Governed by its own **Federal Act on Data Protection**, which is GDPR-shaped but is a different law with its own regulator             |

**None of this is a legal opinion and it has not been reviewed by a lawyer.** It
is the operator's reasoning, written down so a lawyer can check the reasoning and
not only the conclusion, and so a regulator reading it can see what was relied on.

### Where each thing actually sits

**There is no single answer, and giving one would be the misleading version.**
The database is pinned to a region. The object storage is not pinned at all. The
network in front of both is global by design. Those are three different
statements and they are given separately below.

| Data                                                                                         | Where                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Account row, connected-service credentials, wishlist, API tokens, audit and deletion records | **Neon** Postgres, **United States region** (`aws-us-east-1`)                  |
| Cache and rate-limit counters                                                                | The application servers                                                        |
| Application servers                                                                          | **Hetzner Cloud**, Ashburn, Virginia, United States                            |
| Encrypted database backups, and the erasure ledger                                           | **Cloudflare R2**, **no jurisdiction pinned**. See the paragraph below         |
| **Email address, name, sign-in events, session records**                                     | **WorkOS, United States**                                                      |
| **Every request in transit: your IP address, the URL path, your headers**                    | **Cloudflare**, at whichever data centre is nearest you, anywhere in the world |
| Operator access                                                                              | From the United States, by one person                                          |

**The object storage is unpinned, and "unpinned" is not a synonym for "in the
United States".** Cloudflare R2 offers exactly two data-residency jurisdictions,
`eu` and `fedramp`. **There is no United States jurisdiction to choose.** The
backup and erasure-ledger buckets are created with no jurisdiction, which R2
calls `default`, and what that means is that Cloudflare may store those objects
anywhere it likes. A location hint can be given at creation, and a hint is a
preference rather than a guarantee. So the true statement about backups is that
they are **not pinned to the EU**, and this policy declines to make the stronger
claim that they are held in the United States, because nothing in the platform
would make that true. The objects are encrypted before they are uploaded, under a
key that has never been in Cloudflare, which is the control that actually does
the work here regardless of where they land.

**The database residency is a real guarantee, not a setting.** A Neon project's
region is chosen at creation and **Neon does not permit changing the region of an
existing project**, so it is a property of the project rather than something
somebody could flip.

**The Cloudflare edge is global on purpose and no guarantee is available.** Every
DNS record for Pull.fm is proxied through Cloudflare deliberately: an unproxied
record would publish the origin server's IP address and remove the whole edge
trust boundary. The consequence is that Cloudflare's global anycast network
answers every request and TLS is terminated wherever that lands, which means your
IP address, the URL path, your user agent and the request body are in the clear,
in memory, at a data centre that may be in any country. The only Cloudflare
product that confines TLS termination to a chosen region is an Enterprise add-on
this deployment is not on. This is a disclosed property of the architecture
rather than a setting left wrong, and it is stated here because a policy that
answered only the storage question would leave you with a false picture.

`[OPEN]` **None of the placements in the table above have been applied yet, and
this section describes the intended end state rather than the deployed one.** As
of 2026-07-29 the infrastructure code in this repository still pins the database
to `aws-eu-central-1` in Frankfurt, still validates the Hetzner location against
an EU-only list of `fsn1`, `nbg1` and `hel1` with the live staging node in
Helsinki, and still defaults the backup bucket to the `eu` jurisdiction. A
separate point about the same table: the **erasure-ledger bucket is not described
by the infrastructure code at all**, so unlike the backup bucket there is no
committed artifact that fixes or checks its jurisdiction. Before publication,
every row above must be re-read against the applied Terraform, and the erasure
ledger needs a placement that something enforces.

### Cross-border processing

**What used to be in this section, and why it is gone.** Previous versions
carried a full Chapter V analysis: Standard Contractual Clauses in two modules
for WorkOS, the UK International Data Transfer Addendum, the same clauses applied
to Swiss law, and the observation that the United States holds no adequacy
decision. All of it existed to legitimize moving personal data **out of the
EEA**, and none of it has anything left to do.

Two independent reasons, either of which is sufficient:

1. **After the move there is no EEA-resident data to transfer.** Chapter V
   governs a transfer from the Union to a third country. Nothing in the estate
   will be in the Union.
2. **A person in the EEA sending their own data directly to a controller in the
   United States is not a "transfer" out of the EEA in the first place.** This is
   the European Data Protection Board's own reading of what a restricted transfer
   is: it requires an exporter subject to the GDPR sending to an importer, and a
   data subject typing their own email address into a United States service is
   not that. So even in the period before registration is refused, the SCCs were
   answering a question that was not being asked.

**What remains true, and is a fact rather than a safeguard**, is that data does
cross borders in the ordinary running of the service: the content delivery
network decrypts every request at whichever data centre is nearest the visitor,
and the object storage holding backups is not pinned to any jurisdiction. Both
are described above. Neither is now a compliance mechanism; both are properties
of the architecture that you are entitled to know about.

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

### What Cloudflare actually processes

This is itemised rather than summarised because "we use a CDN" understates it.
Cloudflare is not merely passing bytes: it decrypts them, and **we hold its
private TLS certificate relationship precisely so that it can**, because the edge
protections we rely on need to see the request. It applies to **every visitor**
rather than only to account holders, it is continuous, and it happens in transit
rather than by storing anything.

| What                                                        | Why Cloudflare has it                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Your IP address**                                         | It is the source address of the connection. Unavoidable for any reverse proxy          |
| The **URL path**, HTTP method, status, and timing           | Cloudflare has to route and cache the request                                          |
| Your **user agent** and other request headers               | Passed through, and used by the bot and abuse controls                                 |
| The **request and response bodies**, decrypted in memory    | TLS terminates at the edge, so everything in the request is in the clear at that point |
| **Nothing stored on our behalf**, other than the R2 objects | Backups and erasure-ledger entries, encrypted before upload, in unpinned buckets       |

### Service providers

| Provider                     | What they handle                                                                                                                                                                                             | Where                                                                                              | Written security commitment                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neon** (database)          | Every application table, and the backups of it                                                                                                                                                               | United States region                                                                               | `[OPEN]` Not on file                                                                                                                                    |
| **Hetzner Online GmbH**      | Application servers, cache                                                                                                                                                                                   | Ashburn, Virginia                                                                                  | `[OPEN]` Not on file                                                                                                                                    |
| **Cloudflare, Inc.**         | DNS, and the reverse proxy every request passes through: TLS is terminated at the edge, so IP addresses, paths, headers and bodies are processed in the clear. Also object storage holding encrypted backups | **Global edge**, at the data centre nearest each visitor; object storage pinned to no jurisdiction | Published DPA, incorporated by reference under Self-Serve Subscription Agreement 6.1. `[OPEN]` Not confirmed for this account and no dated copy on file |
| **WorkOS, Inc.**             | Authentication and identity                                                                                                                                                                                  | United States                                                                                      | The published DPA, incorporated automatically. `[CONFIRM]` that the WorkOS agreement itself is executed, and keep a dated copy of the DPA on file       |
| **GitHub, Inc. (Microsoft)** | Source hosting and release distribution. Handles no user data.                                                                                                                                               | United States                                                                                      | Not required                                                                                                                                            |

`[OPEN]` **This obligation does not disappear with the GDPR, and it would be easy
to think it did.** Earlier versions of this document sourced it to **GDPR Article
28**, which required a written processor contract. Article 28 no longer applies.
But two United States laws impose a materially similar duty on a business holding
personal information about their residents, **with no revenue and no volume
threshold at all**, and Pull.fm is offered to residents of every state:

- **Massachusetts, 201 CMR 17.03(2)(f)**, which requires taking reasonable steps
  to select service providers capable of maintaining appropriate security, and
  **requiring those measures by contract**.
- **New York, the SHIELD Act** (Gen. Bus. Law section 899-bb), whose reasonable
  safeguards include selecting service providers capable of maintaining
  appropriate safeguards and **requiring those safeguards by contract**.

So the position is unchanged in substance: **Neon and Hetzner are outstanding.**
WorkOS is covered by an addendum that applies by its own terms, and Cloudflare by
a published DPA that its self-serve agreement incorporates by reference. Both of
those should still be downloaded, dated and filed so that what we agreed to is
provable later, and the Cloudflare one carries one extra check that has not been
done: **confirm which Cloudflare agreement this account is actually on**, since
the incorporation route above is the Self-Serve Subscription Agreement and a
different agreement would change the analysis. That is a five-minute check
against the account's own billing page.

**The two citations above are the operator's reading and have not been verified
against the primary sources.** They were checked from memory rather than from the
regulation and the statute, because the sources could not be retrieved while this
was written. Counsel must confirm both, and confirm whether any other state
imposes the same duty, before this is published.

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

### What you can do right now, whether or not any law says so

**These are offered as a matter of policy, not because a statute compels them.**
As the rest of this section explains, Pull.fm is below the threshold of every
United States privacy law that would compel either of them. They were built
before anything required them and they are not being withdrawn now that the
analysis says nothing does.

| What                     | How                                                 |
| ------------------------ | --------------------------------------------------- |
| **Get all of your data** | `GET /v1/me/export`, or "export my data" in the app |
| **Delete your account**  | `DELETE /v1/me`, or "delete account" in the app     |

Both are self-service and neither requires us to act. For anything else, for
example correcting a display name we somehow will not let you change, email
`ope@312.dev`.

### Which United States laws were checked, and where Pull.fm sits

**The honest form of this answer is "below the threshold today", not "does not
apply", because the difference matters and it is a difference the product can
cross by growing.**

**California, the CCPA as amended by the CPRA.** Checked against the statute.
Civil Code section 1798.140(d)(1) makes a for-profit entity a covered "business"
only if it meets at least one of three tests: annual gross revenues **in excess
of $25,000,000** in the preceding calendar year, as adjusted for inflation under
section 1798.199.95; **or** it annually buys, sells or shares the personal
information of **100,000 or more** consumers or households; **or** it derives
**50 percent or more** of its annual revenues from selling or sharing personal
information.

Pull.fm meets none of them. It has **no revenue at all**, so the first and third
tests are not close, and the third in particular cannot be met by a service with
no sale of data and no revenue to take a percentage of. The second is a volume
test and Pull.fm is pre-launch. **312.dev LLC is a limited liability company, so
the non-profit route out of the definition is not available**, and this position
rests entirely on the thresholds. It therefore changes if Pull.fm ever takes
revenue or reaches 100,000 users.

**The other state comprehensive privacy laws.** Roughly twenty states have now
passed one. `[OPEN]` **These were not checked against their statutes and the
position on them is the operator's understanding rather than a verified one.**
That understanding is: most set either a consumer-count threshold, commonly
100,000 or a lower figure in the smaller states, or a lower count combined with a
share of revenue from selling data, and Pull.fm is below all of them while it has
no users and no revenue. **Texas and Nebraska are the ones to check first**,
because they use a Small Business Administration size test instead of a numeric
threshold, which a small operation can fail to be exempt from in a way a
threshold would not catch, and because even an exempt small business is
prohibited from selling sensitive personal data without consent. Counsel must
work through the list before publication.

**What happens if a threshold is crossed.** Taking revenue, or reaching 100,000
users, converts this section from "below the threshold" to "covered", and the
obligations that arrive with it are not paperwork: a notice at collection, verified
consumer request handling with statutory deadlines, and contractual terms with
every service provider. **Treat the first paying user and the hundred-thousandth
account as legal events**, not product milestones, and re-read this section before
either happens.

### What does not depend on a threshold, and applies today

- **Breach notification.** See section 12. Every state has a statute, and none of
  them has a revenue or volume threshold.
- **Illinois BIPA** (740 ILCS 14), which applies to a private entity of any size.
  Pull.fm collects no biometric identifiers and no biometric information, which
  section 3.6 states explicitly and checkably.
- **Illinois PIPA** (815 ILCS 530), which is where 312.dev LLC's own breach
  notification, reasonable-security and secure-disposal duties come from, and
  which likewise has no threshold.
- **Section 5 of the FTC Act.** A privacy policy is a representation. Saying
  something here that the system does not do is a deceptive practice regardless
  of any privacy statute, which is the reason this document carries unresolved
  markers instead of confident prose.

### Children

See section 11. **COPPA** turns on age rather than on any threshold.

### Complaining about us

There is no single regulator to name. You can complain to the **Federal Trade
Commission**, to the **Illinois Attorney General** since 312.dev LLC is an
Illinois company, or to the **Attorney General of your own state**. Email
`ope@312.dev` first if you want it fixed rather than investigated.

### Response times, stated honestly

Pull.fm is operated by one person with no support team. The export and deletion
endpoints are **self-service and do not require us to act**, which is
deliberate: the two rights that matter most should not sit in a queue behind one
person. They are part of the service, so they are subject to the same
availability as the rest of it, and Pull.fm makes no availability commitment
(see the terms of service). If the service is unreachable, use the email route
below and we answer within the legal deadline, though not within hours.

---

## 11. Children

Pull.fm is not for children. The terms of service require you to be at least
**16**, and that number is kept deliberately above the line COPPA draws.

**What the system actually does about age, stated precisely because this is a
place a policy usually overclaims.** Pull.fm **never asks your age**. There is no
date-of-birth field, no age attestation, no age checkbox and no age column in any
database migration, and sign-in is an emailed one-time code that carries no age
signal. The minimum age is therefore a **term of the contract, not a control**.
Nothing in the code could stop a younger person from creating an account, and
this document does not claim otherwise.

What follows from that:

- **COPPA** applies to an operator of a service directed to children under 13, or
  to an operator with **actual knowledge** that it is collecting personal
  information from a child under 13. Pull.fm is a music discovery service for
  adults, is not directed to children by subject matter, presentation or any
  other measure, and collects nothing that would tell us a user's age. So the
  actual-knowledge route is the one that matters, and it is the one we can act on.
- **If we learn that an account belongs to someone under 13, we delete it**, and
  the same applies under 16 as a matter of the terms. "Learn" is meant literally:
  a report, or something a user tells us. We have no other way to find out.
- If you believe a child has an account, email `ope@312.dev`.

**This description of COPPA is the operator's reading of the statute and the
rule, not advice.** The substantive claim, that no age is collected anywhere, was
checked against the migrations and the handlers rather than remembered.

---

## 12. Security

The full threat model is **public** in this repository, which is unusual and
intentional: a design that only survives being secret is not a design. The
accepted-risk register was public too until 2026-07-29 and is now held privately,
for the reasons in [`../security/README.md`](../security/README.md).

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
personal services. Both are recorded, with expiry dates for re-decision, in an
accepted-risk register that is no longer public
([`../security/README.md`](../security/README.md) explains why). The limits
themselves stay published here, which is the part that concerns you: moving the
register does not retract anything this policy says.

### If there is a breach

**This is the obligation that survived the move to a United States posture
untouched, and it is the one with no threshold anywhere.** Every state has a
breach-notification statute, none of them cares how much revenue we make or how
many users we have, and the law that applies is the law of **your** state rather
than ours. Illinois adds its own duty on top, because 312.dev LLC is an Illinois
company: the **Personal Information Protection Act** (815 ILCS 530) requires
notification, and also imposes a standing duty to implement reasonable security
measures and to dispose of records securely.

**We will notify you without unreasonable delay** once we know a breach has
occurred and who it affects, and we will notify the Attorneys General and any
other authority a statute names. Several states set a hard outer limit measured
in days rather than a reasonableness test, and where one applies we meet the
shortest deadline among the affected states rather than tracking each separately.
Where a breach affects data supplied by a partner whose contract requires faster
notice, we meet that shorter deadline too.

**Two things about Pull.fm's specific data that a generic paragraph would miss:**

- **What we hold may or may not be "personal information" as these statutes
  define it, and the interesting case is a real one.** Most of them cover a name
  combined with a Social Security number, a driver's licence number or a
  financial account, and Pull.fm holds none of those. But the newer statutes,
  California's among them, also cover **an email address in combination with a
  password or credential permitting access to an online account**, and Pull.fm
  holds exactly an email address alongside encrypted ListenBrainz and Last.fm
  credentials. Whether a credential for a **third party's** account triggers a
  statute written about the operator's own accounts is a question this document
  does not pretend to settle. **We would notify rather than argue the point.**
- **Encryption is a safe harbour in most of these statutes, and here it is real
  rather than nominal.** Notification is generally not required where the data
  was encrypted and the key was not also acquired. Connected-service credentials
  are encrypted under a key held outside the database entirely (section 4), so a
  database or backup disclosure alone yields ciphertext. We would still tell you
  what happened.

**The precise state-by-state deadlines, and which of them treat our data as
covered, have not been worked through and need counsel.** What is stated above is
the structure of the obligation and the position we would take, not a compiled
matrix.

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

**312.dev LLC**, Illinois, United States
Privacy: `ope@312.dev`
Security: see [`../SECURITY.md`](../SECURITY.md)

**Contact is by email and there is no postal address published.** Section 2 sets
out what was checked before deciding that, and names the two events that would
reverse it: entering an app store, and sending a first marketing email.

---

## Appendix: open items blocking publication

A checklist, so that nothing above is quietly published while still untrue.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                | Section |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **The retention jobs are built, tested and scheduled, and the schedule has never fired** because no compute is deployed to run it. The windows in sections 7 and 8 are enforced on each run, and a run is presently started by hand. A schedule must be verified to have fired before those windows are stated as unqualified promises.                                                                                             | 7, 8    |
| 2   | No log retention period is configured anywhere. A number must exist in the system before it is stated here.                                                                                                                                                                                                                                                                                                                         | 8       |
| 3   | The 35-day lifecycle rule on the logical dumps is configured but **we cannot read it**, because the backup credential is bucket-scoped and lifecycle reads are a bucket-admin operation. Run the conformance check from an operator credential. The Neon PITR window itself is settled at 6 hours.                                                                                                                                  | 7, 8    |
| 4   | No written security commitments are on file with **Neon or Hetzner**. This is now sourced to Massachusetts 201 CMR 17.03(2)(f) and the New York SHIELD Act rather than to GDPR Article 28, and those two citations themselves need verifying. WorkOS and Cloudflare are each covered by a published addendum; file a dated copy of both, and confirm which Cloudflare agreement this account is on.                                 | 9       |
| 5   | ~~The registration refusal for the EEA, the UK and Switzerland does not exist.~~ **Resolved 2026-07-29:** `apps/bff/src/lib/registration-geo.ts` holds the list, three auth routes enforce it before the identity provider is called, and 40 tests across two suites cover it. Its honest limits are described in section 9 and recorded in the private risk register, not left as a gap here.                                      | 2, 9    |
| 6   | ~~Controller's state of organisation, postal address, and governing supervisory authority are unfilled.~~ **Resolved:** 312.dev LLC is organised in Illinois. The postal address is deliberately not published and section 2 records what was checked; the supervisory-authority row is gone with the GDPR.                                                                                                                         | 2, 10   |
| 7   | **The infrastructure has not moved.** Section 9 describes a US-region database, US application servers and unpinned object storage; the Terraform in this repository still pins all three to the EU. Re-read every row of that table against the applied configuration before publication.                                                                                                                                          | 9       |
| 7a  | The **erasure-ledger bucket is not described by infrastructure code at all**, so nothing fixes or checks its placement the way the backup bucket's is fixed and checked.                                                                                                                                                                                                                                                            | 9       |
| 7b  | ~~Confining TLS termination to the EU needs Cloudflare Regional Services.~~ **Not applicable.** That was a Chapter V mitigation for an EU transfer. The edge is still global and section 9 still discloses it, but there is no longer a safeguard it is failing to provide.                                                                                                                                                         | 9       |
| 7c  | **The state comprehensive privacy laws other than California were not checked against their statutes.** Texas and Nebraska first, because they use an SBA size test rather than a numeric threshold.                                                                                                                                                                                                                                | 10      |
| 8   | ~~Expired `idempotency_keys` and `connect_states` rows are never deleted.~~ **Resolved:** `sweep:expired` deletes both an hour past expiry. Scheduling it is item 1.                                                                                                                                                                                                                                                                | 8       |
| 9   | ~~The sign-in methods sentence disagrees with `docs/PLAN.md` section 4.~~ **Resolved:** `docs/PLAN.md` section 4a records magic link only, and a test and a database constraint enforce it. `legal/terms-of-service.md` section 4 still described social sign-in when this row was first marked resolved, and was corrected on 2026-07-29; check the sibling documents, not only the plan, before closing a row of this kind again. | 3.1     |
| 10  | The WorkOS subprocessor list has not been read and summarized.                                                                                                                                                                                                                                                                                                                                                                      | 9       |
| 11  | WorkOS may use personal data "to build or improve the quality of its services", and their addendum is silent on AI/ML training. Decide whether to seek a commitment.                                                                                                                                                                                                                                                                | 3.1, 9  |
| 12  | ~~Terraform still describes the pre-Neon self-hosted database.~~ **Resolved** as to the self-hosted layout. The region it is pinned to is now item 7.                                                                                                                                                                                                                                                                               | 9       |
| 13  | This document has not been reviewed by a lawyer, and the rewrite to a United States posture makes that more pressing rather than less: it replaced one settled body of law with several unsettled ones, and the reasoning in sections 9, 10 and 12 is the operator's.                                                                                                                                                               | all     |
| 14  | The territorial posture is now enforced, and its two residual weaknesses are **in the private risk register rather than here**, because neither is a gap between what this document claims and what the system does: address-based geolocation can be evaded, and the country header is trusted on the strength of a zone-level origin-pull certificate. Section 9 already declines to claim more than the control delivers.        | 2, 9    |
