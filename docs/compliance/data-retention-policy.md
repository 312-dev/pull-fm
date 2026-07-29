# Pull.fm data retention and audit-log anonymization policy

> **Status: DESIGN. Not implemented.** This document is the specification the
> migration and the purge job are to be written from. Nothing described in
> section 5 exists in the code today. Where a number is stated it is a
> **proposed** number that becomes binding the moment it is quoted in
> [`legal/privacy-policy.md`](../../legal/privacy-policy.md), so the order of
> operations is: agree this document, implement it, then publish the policy.
>
> Written 2026-07-29 against migrations `0001`-`0004`, `apps/bff/src/lib/audit.ts`,
> `apps/bff/src/lib/idempotency.ts`, and `apps/bff/src/services/deletion.ts`.

## 1. Why this document exists

`legal/privacy-policy.md` carries an `[OPEN]` marker that blocks publication:

> **`audit_log` currently has no retention limit and is never purged.** That
> means an IP address linked to an internal account identifier persists
> indefinitely after the account is deleted.

That is accurate. `audit_log` is created in
[`packages/db/migrations/0002_api_tokens.sql`](../../packages/db/migrations/0002_api_tokens.sql)
with `user_id uuid` and `ip inet`, **deliberately without a foreign key** so the
rows survive the account deletion they record. Nothing else in the system ever
deletes or rewrites them. The combination of an account identifier and an IP
address is personal data under GDPR Article 4(1), and keeping it forever fails
the storage-limitation principle in Article 5(1)(e) whether or not the account
still exists.

The fix is not "delete the audit trail". A security audit trail that a user can
erase by deleting their account is worthless precisely in the case it exists for:
an attacker who takes over an account, drains it, and deletes it. The fix is to
**keep the evidence and drop the identifiers**, which is what section 5
implements.

## 2. Scope

| In scope                                           | Out of scope                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Every table in `packages/db/migrations/`           | WorkOS-side retention, which is governed by their DPA (see section 7)  |
| Redis keys written by the BFF                      | Upstream providers' own logs of API calls we make on a user's behalf   |
| Application and web-server logs                    | The public git history of this repository, which contains no user data |
| Neon backups and any point-in-time-recovery window | Aggregate counters that were never per-user                            |

## 3. Retention schedule

"Hard delete" means the row is gone. "Anonymize" means the row survives with
every identifier removed and no key held anywhere that can restore it.

| Data                                              | Where                                                | Retention                                                                                     | On account deletion                          | Status                    |
| ------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| Account record                                    | `users`                                              | Life of the account                                                                           | Hard delete                                  | Implemented (cascade)     |
| Connected-service credentials                     | `user_connections`                                   | Life of the connection                                                                        | Hard delete (cascade)                        | Implemented               |
| Wishlist                                          | `wishlist_items`                                     | Life of the account                                                                           | Hard delete (cascade)                        | Implemented               |
| Personal API tokens (digest, label, scopes)       | `api_tokens`                                         | Life of the token                                                                             | Hard delete (cascade)                        | Implemented               |
| **Personal API token last-used IP**               | `api_tokens.last_used_ip`                            | **90 days from last use**, then set to `NULL` in place                                        | Hard delete (cascade)                        | **Proposed, section 5.4** |
| In-flight connect state                           | `connect_states`                                     | `expires_at` (minutes)                                                                        | Hard delete (cascade)                        | **Gap, section 4.2**      |
| Idempotency records incl. cached response bodies  | `idempotency_keys`                                   | `expires_at` (24 hours)                                                                       | Hard delete (cascade)                        | **Gap, section 4.2**      |
| **Security audit events, full fidelity**          | `audit_log`                                          | **90 days from the event**                                                                    | Anonymized, see 5.2                          | **Proposed, section 5**   |
| **Security audit events, anonymized**             | `audit_log`                                          | **400 days from the event**, then hard delete                                                 | Already anonymized                           | **Proposed, section 5**   |
| Deletion receipts                                 | `deletion_log`                                       | Indefinite. Holds a UUID of an account that no longer exists, timestamps, and row counts.     | Created by it                                | Implemented               |
| Upstream response cache                           | `upstream_cache`                                     | Governed by the cache governor and the Last.fm 100 MB cap. No user column, not personal data. | Untouched, nothing to touch                  | Implemented               |
| Crosswalk, previews, audio features               | `mbid_crosswalk`, `track_previews`, `audio_features` | Indefinite. Content metadata, no user linkage.                                                | Untouched                                    | Implemented               |
| Rate-limit counters, export cooldowns and tickets | Redis                                                | 60 seconds to about 11 minutes, by TTL                                                        | Keys scanned and removed                     | Implemented               |
| Session revocations                               | Redis                                                | Until the revoked session would have expired anyway                                           | Keys scanned and removed                     | Implemented               |
| Application logs (request id, subject id, IP, UA) | Log destination                                      | **30 days proposed**                                                                          | Not per-record deletable                     | `[OPEN]`, section 4.3     |
| Web-server access logs                            | Origin node                                          | **14 days proposed**                                                                          | Not per-record deletable                     | `[OPEN]`, section 4.3     |
| Database backups / PITR                           | Neon                                                 | The configured PITR window                                                                    | Not rewritten, deletions replayed on restore | `[OPEN]`, section 4.4     |

## 4. Gaps this document is closing, in priority order

### 4.1 `audit_log` is never purged and survives deletion with identifiers intact

The headline gap. Specification in section 5.

### 4.2 Two tables declare an expiry that nothing enforces

`idempotency_keys.expires_at` defaults to `now() + interval '24 hours'` and
`connect_states.expires_at` is minutes away, but **expiry is only ever applied on
read**:

```
apps/bff/src/lib/idempotency.ts:122   WHERE user_id = $1 AND key = $2 AND expires_at > now()
apps/bff/src/services/connections.ts:251   AND expires_at > now()
```

An expired row is invisible to the application and still present in the table.
For `connect_states` that is a small privacy cost (a subject id, a provider, a
redirect URI). For `idempotency_keys` it is not: `response_body jsonb` holds a
**verbatim copy of an API response**, which for `POST`-shaped account operations
can include the email address and display name, and for wishlist writes includes
the user's free-text note. Those copies are bounded by the life of the account
(the FK cascades), but they are **not** bounded by the 24 hours the schema
advertises and the privacy policy states.

This makes the current sentence in `legal/privacy-policy.md` section 8,
"Idempotency records: 24 hours, enforced by the schema", **false as written**.
The schema enforces 24 hours of _validity_, not 24 hours of _storage_. Either
the sweeper in section 5.4 ships or that sentence has to say so.

### 4.3 No log retention is configured anywhere

Unchanged from the privacy policy's own finding. The numbers proposed in
section 3 (30 days application, 14 days web server) are the smallest values that
still allow a weekend-to-Monday incident investigation. They are proposals until
they exist in configuration; a stated retention that nothing enforces is a false
statement of fact, not a rounding error.

### 4.4 The backup window has no number

The database has moved to Neon, so the point-in-time-recovery window is a Neon
project setting rather than a pgBackRest setting. Neon does not permit changing a
project's region after creation, which fixes residency, but the **history
retention window is configurable and must be recorded here and in the privacy
policy with the value actually set**.

## 5. Specification: audit-log anonymization and purge

### 5.1 The design in one paragraph

Keep every audit row. After a bounded window, strip the two identifiers it
carries: replace `user_id` with a **random pseudonym that is generated once per
user at anonymization time and stored nowhere else**, and truncate `ip` to its
network prefix. The pseudonym preserves the only forensic property that matters
after the fact, which is "these events were the same actor", while being
irreversible: there is no key, no HMAC pepper, and no mapping table, so the
transformation cannot be undone by anyone including us. Under Recital 26 the
resulting rows are anonymous data outside the scope of the GDPR, which is the
whole point of doing it this way rather than encrypting or hashing the user id.

Hashing was rejected explicitly. `HMAC(pepper, user_id)` is reversible in
practice here, because `deletion_log.deleted_user_id` retains the UUID of every
deleted account: anyone holding the pepper and the deletion log could re-identify
every anonymized row by brute force over a candidate set of a few thousand. A
random pseudonym has no such property.

### 5.2 Windows

| Trigger          | Action                        | Window                                                                                    |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| Row ages         | Anonymize                     | `created_at < now() - 90 days`                                                            |
| Account deleted  | Anonymize that account's rows | On the first job run after the row reaches **30 days old**, deletion date notwithstanding |
| Row ages further | Hard delete                   | `created_at < now() - 400 days`                                                           |

The 30-day post-deletion window is deliberate and is the one number in this
document most likely to be challenged, so the reasoning is stated rather than
implied: **account deletion is itself a plausible final step of an account
takeover.** An attacker who signs in, exfiltrates a Last.fm session key, and
deletes the account to cover the trail would, under immediate anonymization, have
erased the source IP of their own sign-in at the moment they most wanted it gone.
Thirty days is long enough for the victim to notice through the third-party
provider (which is where they would notice) and report it, and short enough that
it is a genuine limit rather than a formality. Rows already older than 30 days at
deletion time are anonymized on the next run, normally within 24 hours.

400 days for the anonymized tail is chosen so that a year-over-year comparison
survives (an incident found in month 12 can be compared against the same period a
year earlier) with a month of slack. After that the rows are hard deleted, because
an anonymous row that nobody will ever read is storage cost, not evidence.

### 5.3 Migration (proposed `NNNN_audit_log_retention.sql`)

Take the next free number at the time of writing it. `0005` is already claimed by
the magic-auth identity work in flight, so this is `0006` unless something lands
first.

```sql
-- migrate:up

-- The pseudonym replaces user_id at anonymization time. It is a fresh random
-- UUID per (deleted or aged) user, generated inside the UPDATE and recorded
-- nowhere else, so the mapping does not exist anywhere once the job commits.
ALTER TABLE audit_log
    ADD COLUMN subject_pseudonym uuid,
    ADD COLUMN anonymized_at     timestamptz;

-- Exactly one of the two identifiers may be present. This is the structural
-- guarantee that a half-applied anonymization cannot leave both, or neither.
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_identity_chk
    CHECK (
        (anonymized_at IS     NULL AND subject_pseudonym IS NULL)
     OR (anonymized_at IS NOT NULL AND user_id           IS NULL)
    );

-- Drives the anonymization sweep. Partial, so it holds only the working set and
-- shrinks to nothing once the backlog is cleared.
CREATE INDEX audit_log_pending_anon_idx ON audit_log (created_at)
    WHERE anonymized_at IS NULL;

-- Replaces the user-scoped read path for anonymized rows.
CREATE INDEX audit_log_pseudonym_idx ON audit_log (subject_pseudonym, created_at DESC)
    WHERE subject_pseudonym IS NOT NULL;

-- Drives the hard-delete sweep.
CREATE INDEX audit_log_created_idx ON audit_log (created_at);

-- migrate:down

DROP INDEX IF EXISTS audit_log_created_idx;
DROP INDEX IF EXISTS audit_log_pseudonym_idx;
DROP INDEX IF EXISTS audit_log_pending_anon_idx;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_identity_chk;
ALTER TABLE audit_log DROP COLUMN IF EXISTS anonymized_at;
ALTER TABLE audit_log DROP COLUMN IF EXISTS subject_pseudonym;
```

Note that `audit_log.user_id` is already nullable, so no column alteration is
needed to null it out, and no existing index has to be dropped:
`audit_log_user_idx (user_id, created_at DESC)` simply stops matching a row once
`user_id` becomes `NULL`.

### 5.4 The purge job

One job, five statements, run on a schedule, each independently idempotent and
batched so that no statement holds a long transaction against the primary. Order
matters: deleted accounts are handled before the age-based pass so that a row
which qualifies under both is anonymized under the deletion rule.

**Statement 1: anonymize rows belonging to deleted accounts.** No new bookkeeping
is required, because `deletion_log` already records every deleted account id and
`audit_log` has no FK, so the two can simply be joined.

```sql
WITH victims AS (
    SELECT a.user_id
      FROM audit_log a
      JOIN deletion_log d ON d.deleted_user_id = a.user_id
     WHERE a.anonymized_at IS NULL
       AND a.created_at < now() - interval '30 days'
     GROUP BY a.user_id
     LIMIT 500
),
assigned AS (
    SELECT user_id, gen_random_uuid() AS pseudonym FROM victims
)
UPDATE audit_log a
   SET user_id           = NULL,
       subject_pseudonym = assigned.pseudonym,
       ip                = CASE
                             WHEN a.ip IS NULL      THEN NULL
                             WHEN family(a.ip) = 4  THEN network(set_masklen(a.ip, 24))::inet
                             ELSE                        network(set_masklen(a.ip, 48))::inet
                           END,
       anonymized_at     = now()
  FROM assigned
 WHERE a.user_id = assigned.user_id
   AND a.anonymized_at IS NULL;
```

**Statement 2: anonymize rows that have simply aged out.** Identical shape,
`WHERE a.created_at < now() - interval '90 days'`, no join to `deletion_log`,
and the same one-pseudonym-per-user grouping so that a live user's aged events
stay correlated with each other.

**Statement 3: hard delete the anonymized tail.**

```sql
DELETE FROM audit_log
 WHERE ctid IN (
     SELECT ctid FROM audit_log
      WHERE created_at < now() - interval '400 days'
      LIMIT 10000
 );
```

**Statement 4: enforce the expiries that are currently read-only** (closes 4.2).

```sql
DELETE FROM idempotency_keys WHERE expires_at < now() - interval '1 hour';
DELETE FROM connect_states   WHERE expires_at < now() - interval '1 hour';
```

The extra hour is slack against clock skew between the BFF and the database, so
the sweeper can never delete a row an in-flight request still considers valid.

**Statement 5: expire the personal-API-token last-used IP** (closes the
`api_tokens.last_used_ip` row of section 3).

```sql
UPDATE api_tokens
   SET last_used_ip = NULL
 WHERE last_used_ip IS NOT NULL
   AND (last_used_at IS NULL OR last_used_at < now() - interval '90 days');
```

**Where it runs.** The job is plain SQL and has no application dependencies, so
it can run either as a scheduled statement inside Postgres or as a small worker
invoked by an external scheduler. `[CONFIRM]` pg_cron availability on the Neon
plan in use. Absent a confirmed in-database scheduler, the default is an external
scheduled invocation of a `pnpm --filter @pullfm/db retention` script using the
same connection string and pool the migrations use, which keeps the job in the
same region as the data and does not require the BFF to be running.

**Failure behaviour.** The job must be safe to run twice, safe to interrupt, and
must never fail a user request, which it cannot do because it is not on any
request path. Every statement is bounded by a `LIMIT`, so a long backlog drains
over several runs instead of locking the table once.

### 5.5 What is anonymized versus hard deleted on account deletion

The table the privacy policy needs, restated as the implementation contract:

| Data                                                                                              | On `DELETE /v1/me`                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`, `user_connections`, `wishlist_items`, `api_tokens`, `idempotency_keys`, `connect_states` | **Hard deleted**, one transaction, by `ON DELETE CASCADE`                                                                                                                                                                        |
| WorkOS identity (email, name, sign-in factors)                                                    | **Hard deleted** at WorkOS, best effort, recorded in `deletion_log`                                                                                                                                                              |
| Redis keys scoped to the subject                                                                  | **Hard deleted** on both instances                                                                                                                                                                                               |
| `audit_log`                                                                                       | **Retained, then anonymized** on the first run after each row is 30 days old: `user_id` replaced by an unrecoverable random pseudonym, `ip` truncated to /24 or /48, `detail` untouched because it holds non-secret context only |
| `deletion_log`                                                                                    | **Retained.** It is the proof the deletion happened. It holds the UUID of an account that no longer exists, timestamps, and row counts                                                                                           |
| Application and web-server logs                                                                   | **Retained** to the log retention window, then gone. No per-record deletion, because a record holds an opaque subject id and no email or credential                                                                              |
| Backups / PITR                                                                                    | **Not rewritten.** Deletions are replayed before a restored system serves traffic                                                                                                                                                |

One consequence must be stated plainly rather than buried: after anonymization,
**we can no longer answer "what did user X do" for a deleted account**, including
if that user later asks us to. That is the intended trade and it is the price of
the rows not being personal data any more.

## 6. Legitimate-interest assessment for retaining security audit events

Article 6(1)(f) requires a documented balancing. This is it. It covers only the
audit trail and the operational logs; every other purpose in the privacy policy
runs on contract.

**Purpose.** Detect, investigate, and scope credential-affecting incidents. The
closed action set in `apps/bff/src/lib/audit.ts` is exactly the set of events
that decide, during an incident, whether the disclosure notice names three
affected connections or tells every user to rotate everything: `auth.callback`,
`auth.session.revoked`, `connection.*`, `token.*`, `account.export_*`,
`account.deleted`, `webhook.user_deleted`, `webhook.rejected`.

**Necessity.** The interest cannot be met with less data. Without the source IP
there is no way to distinguish a user's own export from an attacker's export from
a stolen session, which is the exact question an incident asks. Without a subject
identifier the events cannot be grouped into an actor at all. Aggregate counts
answer no incident question. So full fidelity is necessary, but only for as long
as an incident could still be discovered, which is what bounds it to 90 days
rather than forever.

**Balancing.** Weighing against the data subject:

- The data is narrow: an internal UUID, an action from a closed list, an outcome,
  non-secret context, and an IP. No email, no credential, no content, no browsing
  history, no location beyond what an IP implies.
- It is never used for profiling, marketing, ranking, personalization, or any
  decision affecting the user. There is no lawful path by which it could be:
  Pull.fm has no advertising, no analytics, and no revenue model.
- Users reasonably expect a service holding credentials to their Last.fm and
  ListenBrainz accounts to keep a security trail. The expectation runs the other
  way too: a service that could not tell a user whether their connection was
  touched would be the unreasonable one.
- The retention is bounded, and the bound is enforced by a job rather than by
  intention.
- The identifying content is removed at 90 days, or 30 days after deletion,
  after which the rows are not personal data at all.
- The residual risk is a database compromise exposing the rows. The same
  compromise would expose far more sensitive material in the same database, so
  the audit table does not measurably widen the blast radius.

**Conclusion.** The interest is not overridden, provided the windows in section
5.2 are actually enforced. **Indefinite retention would fail this test**, which
is why the current state is a publication blocker and not a nice-to-have.

**Article 21 objection.** A user may object to processing based on legitimate
interests. For the audit trail the response is a refusal on compelling legitimate
grounds under Article 21(1), stated honestly at the time: the trail exists to
protect that user's own third-party credentials and every other user's, an
objection right that could be exercised by whoever currently controls an account
would be a self-service evidence-destruction feature, and the retention is
already minimized and bounded. The refusal is recorded and the user is told they
may complain to their supervisory authority. Objections to anything else we run
on legitimate interests are honoured.

**Article 17(3).** Erasure of the audit trail is refused to the extent necessary
for the establishment, exercise, or defence of legal claims and for the
information-security purpose above, and the refusal is time-limited by section
5.2 rather than open-ended.

## 7. Processor-side retention we do not control

| Processor            | What they hold                               | Retention position                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WorkOS, Inc.**     | Email, name, sign-in events, session records | Deleted per-user on our `DELETE` call. On termination of the agreement, the DPA commits WorkOS to delete all Subscriber Personal Data "excluding any back-up or archival copies which shall be deleted in accordance with WorkOS' data retention schedule". That schedule is not published and is `[OPEN]` |
| **Neon (database)**  | Every application table, plus PITR history   | Bounded by the configured history-retention window, which must be recorded here `[OPEN]`                                                                                                                                                                                                                   |
| **Cloudflare, Inc.** | Edge request metadata, object storage        | Their own retention. We store no personal data in R2 beyond encrypted backups                                                                                                                                                                                                                              |

## 8. Verification, so this is not just prose

None of the following exists yet. All of it is part of implementing section 5.

1. **Migration assertion.** Extend `packages/db/scripts/verify-migrations.mjs` to
   assert the `audit_log_identity_chk` constraint exists, so a later migration
   cannot quietly drop the structural guarantee.
2. **Integration test.** In `apps/bff/test/integration/platform.test.ts`, after
   the existing deletion test: insert an audit row backdated 31 days for the
   deleted user, run the job, and assert `user_id IS NULL`,
   `subject_pseudonym IS NOT NULL`, `anonymized_at IS NOT NULL`, and that `ip`
   equals the /24 network of the original. Assert that two rows for the same user
   receive the **same** pseudonym and rows for different users receive different
   ones.
3. **Idempotency test.** Run the job twice; assert the second run changes zero
   rows and does not re-pseudonymize.
4. **Freshness alert.** Alert if `max(anonymized_at)` is older than 48 hours
   while rows older than the window are still pending, which is the only symptom
   a silently dead scheduler produces.
5. **Standing invariant query**, cheap enough to run in CI against a seeded
   database and by hand in production:

   ```sql
   SELECT count(*) FROM audit_log
    WHERE anonymized_at IS NULL
      AND created_at < now() - interval '91 days';
   -- must be 0
   ```

## 9. Change log

| Date       | Change                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| 2026-07-29 | First version. Design only, written to close the `audit_log` publication blocker in `legal/privacy-policy.md`. |
