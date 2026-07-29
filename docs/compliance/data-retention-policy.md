# Pull.fm data retention and audit-log anonymization policy

> **Status: IMPLEMENTED.** Section 5 shipped as migration
> [`0006_audit_log_retention.sql`](../../packages/db/migrations/0006_audit_log_retention.sql)
> plus three scheduled jobs. Every number stated here is now a **binding**
> number: it is enforced by code, asserted by a test, and quoted in
> [`legal/privacy-policy.md`](../../legal/privacy-policy.md).
>
> | Concern                                 | Code                                                                                           | Command                                      | Schedule        |
> | --------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------- |
> | Audit anonymization, expiry, token IPs  | [`apps/bff/src/services/audit-retention.ts`](../../apps/bff/src/services/audit-retention.ts)   | `pnpm --filter @pull-fm/bff purge:audit`     | Daily, off-peak |
> | `idempotency_keys` and `connect_states` | [`apps/bff/src/services/expiry-sweeper.ts`](../../apps/bff/src/services/expiry-sweeper.ts)     | `pnpm --filter @pull-fm/bff sweep:expired`   | Hourly          |
> | Unverified WorkOS directory records     | [`apps/bff/src/services/directory-reaper.ts`](../../apps/bff/src/services/directory-reaper.ts) | `pnpm --filter @pull-fm/bff reap:unverified` | Hourly or daily |
>
> **Read [section 5.4a](#54a-corrections-to-this-specification-made-during-implementation)
> before changing any of it.** Implementation found a real bug in the SQL
> specified in section 5.4, and the code deliberately deviates from it. The
> deviations are recorded there so that nobody "corrects" the code back to the
> broken specification.
>
> The `[OPEN]` items in sections 4.3, 4.4 and 7 are still open. They are
> operational settings, not code, and none of them is closed by this work.
>
> Written 2026-07-29 against migrations `0001`-`0004`, `apps/bff/src/lib/audit.ts`,
> `apps/bff/src/lib/idempotency.ts`, and `apps/bff/src/services/deletion.ts`.
> Implemented 2026-07-29; see the change log in section 9.

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

| Data                                              | Where                                                | Retention                                                                                     | On account deletion                          | Status                       |
| ------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------- |
| Account record                                    | `users`                                              | Life of the account                                                                           | Hard delete                                  | Implemented (cascade)        |
| Connected-service credentials                     | `user_connections`                                   | Life of the connection                                                                        | Hard delete (cascade)                        | Implemented                  |
| Wishlist                                          | `wishlist_items`                                     | Life of the account                                                                           | Hard delete (cascade)                        | Implemented                  |
| Personal API tokens (digest, label, scopes)       | `api_tokens`                                         | Life of the token                                                                             | Hard delete (cascade)                        | Implemented                  |
| **Personal API token last-used IP**               | `api_tokens.last_used_ip`                            | **90 days from last use**, then set to `NULL` in place                                        | Hard delete (cascade)                        | Implemented, `purge:audit`   |
| In-flight connect state                           | `connect_states`                                     | `expires_at` (minutes) plus one hour of clock slack                                           | Hard delete (cascade)                        | Implemented, `sweep:expired` |
| Idempotency records incl. cached response bodies  | `idempotency_keys`                                   | `expires_at` (24 hours) plus one hour of clock slack                                          | Hard delete (cascade)                        | Implemented, `sweep:expired` |
| **Security audit events, full fidelity**          | `audit_log`                                          | **90 days from the event**                                                                    | Anonymized, see 5.2                          | Implemented, `purge:audit`   |
| **Security audit events, anonymized**             | `audit_log`                                          | **400 days from the event**, then hard delete                                                 | Already anonymized                           | Implemented, `purge:audit`   |
| Deletion receipts                                 | `deletion_log`                                       | Indefinite. Holds a UUID of an account that no longer exists, timestamps, and row counts.     | Created by it                                | Implemented                  |
| Upstream response cache                           | `upstream_cache`                                     | Governed by the cache governor and the Last.fm 100 MB cap. No user column, not personal data. | Untouched, nothing to touch                  | Implemented                  |
| Crosswalk, previews, audio features               | `mbid_crosswalk`, `track_previews`, `audio_features` | Indefinite. Content metadata, no user linkage.                                                | Untouched                                    | Implemented                  |
| Rate-limit counters, export cooldowns and tickets | Redis                                                | 60 seconds to about 11 minutes, by TTL                                                        | Keys scanned and removed                     | Implemented                  |
| Session revocations                               | Redis                                                | Until the revoked session would have expired anyway                                           | Keys scanned and removed                     | Implemented                  |
| Application logs (request id, subject id, IP, UA) | Log destination                                      | **30 days proposed**                                                                          | Not per-record deletable                     | `[OPEN]`, section 4.3        |
| Web-server access logs                            | Origin node                                          | **14 days proposed**                                                                          | Not per-record deletable                     | `[OPEN]`, section 4.3        |
| Database backups / PITR                           | Neon                                                 | The configured PITR window                                                                    | Not rewritten, deletions replayed on restore | `[OPEN]`, section 4.4        |

## 4. Gaps this document is closing, in priority order

Written as findings. 4.1 and 4.2 are **closed**; the diagnosis is kept because
it is the argument for the shape of the fix, and because a future reader needs
to know what the code is defending against. 4.3 and 4.4 remain open.

### 4.1 `audit_log` is never purged and survives deletion with identifiers intact

The headline gap. Specification in section 5.

**Closed.** Migration `0006` added `subject_pseudonym` and `anonymized_at`, and
`AuditRetention` in
[`apps/bff/src/services/audit-retention.ts`](../../apps/bff/src/services/audit-retention.ts)
enforces the windows on a daily `pnpm --filter @pull-fm/bff purge:audit`.

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

**Closed.** The sweeper shipped, as its own job rather than as a statement of
the audit purge; see [section 5.4a](#54a-corrections-to-this-specification-made-during-implementation)
for why they were separated.
[`apps/bff/src/services/expiry-sweeper.ts`](../../apps/bff/src/services/expiry-sweeper.ts)
runs hourly as `pnpm --filter @pull-fm/bff sweep:expired`, so the worst case for
an expired idempotency record is 25 hours: the 24 the schema advertises plus the
hour of clock slack in section 5.4. The privacy-policy sentence is true as
written again, and it is now true because a job enforces it rather than because
the schema was misread.

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

One clarification the implementation forced, because "generated once per user"
is not quite achievable and saying so is better than implying otherwise: the
pseudonym is generated once per user **per batch**. A user whose rows cross the
window on different days receives a different pseudonym for each day's batch, so
correlation holds within a batch rather than across a user's whole history.
Making it stable across batches would require remembering which pseudonym was
issued to which user, which is the mapping table this design exists to not have.
See correction 1 in [section 5.4a](#54a-corrections-to-this-specification-made-during-implementation).

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

### 5.3 Migration: shipped as `0006_audit_log_retention.sql`

Shipped verbatim, the only specified statement that needed no correction. The
file is
[`packages/db/migrations/0006_audit_log_retention.sql`](../../packages/db/migrations/0006_audit_log_retention.sql);
read its header before altering `audit_log`, because it records which of these
structures a later migration must not quietly undo. The SQL below is what is in
the migration.

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

> **This subsection is the ORIGINAL SPECIFICATION and its SQL is not what
> shipped.** It is kept because the reasoning is still the reasoning, and
> because [section 5.4a](#54a-corrections-to-this-specification-made-during-implementation)
> is only readable next to what it corrects. The authority on behaviour is
> [`apps/bff/src/services/audit-retention.ts`](../../apps/bff/src/services/audit-retention.ts)
> and [`apps/bff/src/services/expiry-sweeper.ts`](../../apps/bff/src/services/expiry-sweeper.ts).
> **Do not copy the SQL below into anything.** Statement 2 as written here is a
> data-loss bug; 5.4a explains it.

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

**Where it runs.** ~~The job is plain SQL and has no application dependencies, so
it can run either as a scheduled statement inside Postgres or as a small worker
invoked by an external scheduler. `[CONFIRM]` pg_cron availability on the Neon
plan in use. Absent a confirmed in-database scheduler, the default is an external
scheduled invocation of a `pnpm --filter @pullfm/db retention` script using the
same connection string and pool the migrations use.~~

**Resolved.** It runs as scheduled BFF commands, and the `[CONFIRM]` on pg_cron
is withdrawn rather than answered: an in-database scheduler was rejected on its
merits, so its availability stopped mattering. Two reasons. The statements are
no longer plain SQL with no application dependencies, because the batching,
capping, freshness and invariant reporting that make the job operable are
control flow rather than SQL, and the exit codes an alerting scheduler acts on
have to come from a process. And a retention job hidden inside the database is a
job with no code review, no test suite, and no version control, which is the
wrong place for the mechanism that enforces a published privacy commitment.

The commands, their schedules, and the reasoning for each cadence are in the
headers of the entrypoints themselves:

| Command                                    | Entrypoint                                                                             | Schedule        |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | --------------- |
| `pnpm --filter @pull-fm/bff purge:audit`   | [`apps/bff/src/scripts/purge-audit.ts`](../../apps/bff/src/scripts/purge-audit.ts)     | Daily, off-peak |
| `pnpm --filter @pull-fm/bff sweep:expired` | [`apps/bff/src/scripts/sweep-expired.ts`](../../apps/bff/src/scripts/sweep-expired.ts) | Hourly          |

Both read their job off the shared service bundle built by
[`apps/bff/src/wiring.ts`](../../apps/bff/src/wiring.ts) rather than
constructing one beside the scheduler, so the object the schedule runs is the
one the test suites exercise. Their windows are overridable from the
environment (`AUDIT_*`, `EXPIRY_SWEEP_*`) for incident use, resolved by
[`apps/bff/src/lib/job-env.ts`](../../apps/bff/src/lib/job-env.ts); a malformed
override throws rather than falling back to the default, because an override
that is silently ignored would leave the numbers above stated but not enforced.

**Exit codes**, which is what the scheduler alerts on and what makes the
difference between "page someone" and "look at it Monday":

| Code | Meaning                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The run completed, or declined because another run held the advisory lock.                                                                                                 |
| 1    | The run could not start and **changed nothing**. Page: the store is unbounded until it succeeds.                                                                           |
| 2    | The run completed and something needs a look: a statement failed, a batch ceiling was hit with work remaining, or the standing invariant of section 8.5 is still violated. |

**Failure behaviour.** The job must be safe to run twice, safe to interrupt, and
must never fail a user request, which it cannot do because it is not on any
request path. Every statement is bounded by a `LIMIT`, so a long backlog drains
over several runs instead of locking the table once.

**As implemented**, all three hold, and one is structural rather than careful:
`audit_log_identity_chk` makes a half-applied anonymization unrepresentable, so
no interrupted batch can leave a row carrying both a real `user_id` and a
pseudonym. Statements run in autocommit on one pinned connection rather than
inside a single transaction, so a killed process keeps the batches it committed;
concurrency is held off by a session-scoped advisory lock taken on that same
pinned connection, because a session lock taken through the pool would be
released on a different connection and silently provide no exclusion at all.

### 5.4a Corrections to this specification, made during implementation

Implementing section 5.4 found a bug in it. The code deviates from the SQL above
in four places, deliberately, and every one of them was a decision to destroy
**less** evidence or **later** than the specification said. They are recorded
here rather than only in the source so that a reader who arrives at this
document first does not "fix" the code to match a broken design.

The authoritative statements of each are the headers of
[`audit-retention.ts`](../../apps/bff/src/services/audit-retention.ts) and
[`expiry-sweeper.ts`](../../apps/bff/src/services/expiry-sweeper.ts).

#### Correction 1: the anonymization UPDATE needs a per-row age predicate. This one was a real bug.

**The most important item in this document.** Statement 1 above selects victims
with `created_at < now() - interval '30 days'` inside a CTE, and then updates
every row belonging to those users with only `AND a.anonymized_at IS NULL`. The
age predicate is on the **user selection**, not on the **rows being written**.
Statement 2 is specified as "identical shape" with 90 days.

Applied literally, statement 2 anonymizes **a live user's entire history the
moment any single row of theirs turns 90 days old**, including yesterday's
sign-in. The 90-day window would then bound nothing at all: the first aged row
drags every newer row with it, and the loss falls on precisely the recent events
an incident investigation needs. Statement 1 has a smaller version of the same
defect: a deleted account's rows would be anonymized as soon as its **oldest**
row reached 30 days, so a takeover sign-in three days before the deletion loses
its source IP well inside the window written to protect it.

The prose in [section 5.2](#52-windows) says what was meant, per row: "on the
first job run after the row reaches 30 days old". So both `UPDATE`s carry the
same age predicate as their CTE:

```sql
 WHERE a.user_id = assigned.user_id
   AND a.anonymized_at IS NULL
   AND a.created_at < now() - make_interval(days => $1::int)   -- <-- the correction
```

The price is honest and small: a user's rows can cross the line on different
days and receive a different pseudonym per batch, so correlation holds within a
batch rather than across a user's entire history. That is unavoidable given
"generated once and stored nowhere else" in section 5.1 - recovering a
previously issued pseudonym would require exactly the mapping table this design
refuses to keep. Losing some cross-batch correlation is a far smaller cost than
anonymizing evidence early, and anonymizing early is the failure this job must
not have.

#### Correction 2: the hard delete only touches rows that are already anonymized

Statement 3 above deletes on age alone. A 400-day-old row that is **not**
anonymized is not old data, it is a **bug symptom**: it means the anonymizer
never reached it. Deleting it would destroy the evidence and simultaneously
erase the only signal that the anonymizer stopped working, because the standing
invariant in section 8.5 counts exactly those rows.

So the delete carries `AND anonymized_at IS NOT NULL`, and the un-anonymized
backlog is reported as `pendingBeyondWindow` instead of being silently consumed.
Anonymization is the privacy control; the 400-day delete is storage hygiene, and
storage hygiene does not get to paper over a broken privacy control.

The same statement batches by primary key rather than by the `ctid` the
specification used: a `ctid` moves when a row is updated, so a concurrent
anonymization can shift a row out from under a `ctid` captured a moment earlier.

#### Correction 3: statements 4 and 5 are not one job, because they are not one cadence

Section 5.4 bundles all five statements into a single scheduled job. Statement 4
(the `idempotency_keys` and `connect_states` expiry) was split into its own
hourly job, `sweep:expired`, and only statements 1, 2, 3 and 5 remained in the
daily `purge:audit`.

The two have different cadences and different blast radii. The audit purge
rewrites identifiers under windows measured in tens of days, so daily is the
finest granularity that means anything; running it hourly would rewrite the same
rows twenty-four times to move a 90-day boundary by an hour. The expiry sweep
enforces a **24-hour** promise, so running it daily would leave that promise
unmet by up to a further day, against a table holding verbatim copies of API
responses. Neither cadence is right for the other job, and merging them would
have meant picking the wrong one twice.

Statement 5 (`api_tokens.last_used_ip`) stayed with the daily purge: its window
is 90 days, which is the audit purge's cadence, not the sweeper's.

#### Correction 4: a third anonymization pass, for events that never had a subject

The specification has two anonymization statements, both keyed on a user id.
Neither can ever match a row where `user_id IS NULL`, because `a.user_id =
assigned.user_id` is never true for `NULL` - and a real share of the audit
trail is exactly that shape: `directory.unverified_reaped`, `webhook.rejected`,
and failed magic-link attempts are all written with no subject.

Those rows still carry an `ip`. Under the specification as written they would
sit un-anonymized **forever**, and the standing invariant in section 8.5 would
be permanently and correctly violated with no way to clear it. A third statement
anonymizes them on the same 90-day window, truncating the IP and setting
`anonymized_at`.

They receive **no pseudonym**. There is no actor to correlate, and minting one
would fabricate a subject rather than protect one. `audit_log_identity_chk`
permits exactly this shape on purpose; see the migration header.

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

All five exist. Each is named with the file that carries it, so a claim in this
document can be traced to the thing that would fail if it stopped being true.

1. **Migration assertion.** Implemented in
   [`packages/db/scripts/verify-migrations.mjs`](../../packages/db/scripts/verify-migrations.mjs),
   run by `pnpm --filter @pull-fm/db verify` and as that package's `test`
   script. It asserts `audit_log_identity_chk` is present on `audit_log`, so a
   later migration cannot quietly drop the structural guarantee, and it attempts
   each illegal row shape to prove the constraint actually rejects them rather
   than merely existing.
2. **Integration test.** Implemented in
   [`apps/bff/test/integration/audit-retention.test.ts`](../../apps/bff/test/integration/audit-retention.test.ts)
   rather than in `platform.test.ts` as originally proposed: the job earned a
   suite of its own, weighted towards what it must REFUSE to anonymize. It
   covers a backdated row for a deleted user reaching `user_id IS NULL`,
   `subject_pseudonym IS NOT NULL`, `anonymized_at IS NOT NULL` and an `ip`
   truncated to the /24 network of the original, plus same-pseudonym-per-user
   and different-pseudonym-per-user. It also covers what correction 1 in section
   5.4a exists for: a live user's recent rows surviving a run that anonymizes
   their aged ones.
3. **Idempotency test.** Same file: a second run changes zero rows and does not
   re-pseudonymize, and the advisory lock is asserted to make a concurrent run
   decline rather than double-sweep.
4. **Freshness alert.** Implemented as the `stale` field of the run outcome,
   computed against `AUDIT_FRESHNESS_HOURS` (default 48). `purge:audit` writes a
   warning to stderr and exits **2** when nothing has been anonymized inside the
   window while rows past the retention window are already pending, which is the
   only symptom a silently dead scheduler produces.
5. **Standing invariant query.** Implemented twice, on purpose: in
   `AuditRetention.invariant()`, reported every run as `pendingBeyondWindow` and
   exiting **2** when nonzero, and in the migration verifier so it can be run in
   CI against a seeded database and by hand in production.

   ```sql
   SELECT count(*) FROM audit_log
    WHERE anonymized_at IS NULL
      AND created_at < now() - interval '91 days';
   -- must be 0
   ```

   The extra day over the 90-day window is slack, not a weakened bound: a row
   that crossed the line seconds ago and has not been swept yet is the job
   working normally, not a violation.

## 9. Change log

| Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-29 | First version. Design only, written to close the `audit_log` publication blocker in `legal/privacy-policy.md`.                                                                                                                                                                                                                                                                                                                                                           |
| 2026-07-29 | Implemented. Migration `0006`, `AuditRetention`, `ExpirySweeper`. Status moved from DESIGN to IMPLEMENTED; section 3 statuses updated; 4.1 and 4.2 closed; section 8 rewritten to name the tests that exist. Added **section 5.4a**, recording four deliberate corrections to the section 5.4 specification, of which correction 1 (the missing per-row age predicate) was a data-loss bug in the design. `[OPEN]` items in 4.3, 4.4 and 7 are untouched and still open. |
