-- ---------------------------------------------------------------------------
-- Pull.fm schema v6 - audit-log retention: anonymize, then expire
--
-- Implements docs/compliance/data-retention-policy.md section 5.3. That
-- document is the argument; this file is the structure it needs, and the parts
-- worth restating here are the ones a future migration could quietly undo.
--
-- WHY THIS EXISTS
--
-- audit_log is created in 0002 with `user_id uuid` and `ip inet`, deliberately
-- WITHOUT a foreign key so the rows survive the account deletion they record.
-- Nothing ever deleted or rewrote them. An internal account identifier paired
-- with an IP address is personal data under GDPR Article 4(1), and keeping it
-- forever fails the storage-limitation principle in Article 5(1)(e) whether or
-- not the account still exists. That is the `[OPEN]` marker blocking
-- publication of legal/privacy-policy.md.
--
-- The fix is not "delete the audit trail". A security trail a user can erase by
-- deleting their account is worthless in precisely the case it exists for: an
-- attacker who takes over an account, drains it, and deletes it. So the trail is
-- kept and the IDENTIFIERS are dropped.
--
-- WHY A RANDOM PSEUDONYM AND NOT AN HMAC
--
-- The obvious design is `subject_pseudonym = HMAC(pepper, user_id)`, which is
-- stable for free and needs no bookkeeping. It was considered and REJECTED, and
-- the reason is specific to this schema rather than general hash-reversal
-- folklore: `deletion_log.deleted_user_id` retains the UUID of every deleted
-- account, permanently and by design, because it is the proof the erasure
-- happened. Anyone holding the pepper and that table could therefore recompute
-- the HMAC for every candidate id and re-identify every anonymized row by brute
-- force over a set of a few thousand. The pepper is the only secret, and a
-- transformation whose reversal needs one secret plus a table we publish to
-- ourselves is not anonymization, it is pseudonymization wearing its coat.
--
-- A random UUID generated inside the UPDATE and written nowhere else has no
-- such property. There is no key, no pepper, and no mapping table, so the
-- transformation cannot be undone by anyone including us. Under Recital 26 the
-- resulting rows are anonymous data outside the scope of the GDPR, which is the
-- entire point of doing it this way. DO NOT "simplify" this to a keyed hash.
--
-- The cost is stated plainly rather than buried: after anonymization we can no
-- longer answer "what did user X do" for a deleted account, including if that
-- user later asks us to. That is the trade, and it is the price of the rows not
-- being personal data any more.
--
-- Additive only. Both columns are nullable and every existing row is left
-- exactly as it is, so this applies to a live database without a rewrite and
-- reverses without touching a row that predates it.
-- ---------------------------------------------------------------------------

-- migrate:up

-- ---------------------------------------------------------------------------
-- The two columns the sweep writes.
--
-- subject_pseudonym replaces user_id. Fresh random UUID per (deleted or aged)
-- user, generated inside the UPDATE, recorded nowhere else, so the mapping does
-- not exist anywhere once the job commits.
--
-- anonymized_at is not decoration: it is the sweep's own progress marker, the
-- freshness signal for a dead-scheduler alert, and the left half of the CHECK
-- below. A row is anonymized if and only if this is set.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log
    ADD COLUMN subject_pseudonym uuid,
    ADD COLUMN anonymized_at     timestamptz;

-- ---------------------------------------------------------------------------
-- The structural guarantee: a half-applied anonymization cannot exist.
--
-- Read the two branches as the only two legal states of a row:
--
--   not anonymized   anonymized_at IS NULL     => subject_pseudonym IS NULL.
--                    user_id may be anything, including NULL, because plenty of
--                    events have no subject at all (a rejected webhook, a
--                    reaped directory record).
--   anonymized       anonymized_at IS NOT NULL => user_id IS NULL.
--
-- What that forbids is the state a partially applied UPDATE would leave: a row
-- carrying BOTH a real user_id and a pseudonym, which would hand an attacker
-- the mapping the whole design exists to destroy. The database refuses to store
-- it, so no bug in the job, no interrupted batch, and no hand-run SQL can
-- produce one.
--
-- What it deliberately PERMITS is an anonymized row with a NULL pseudonym. That
-- is not a loophole, it is the only correct representation of an event that
-- never had a subject: there is no actor to correlate, so inventing a pseudonym
-- for one would fabricate a subject rather than protect one. Those rows still
-- need the sweep, because they still carry an `ip`.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_identity_chk
    CHECK (
        (anonymized_at IS     NULL AND subject_pseudonym IS NULL)
     OR (anonymized_at IS NOT NULL AND user_id           IS NULL)
    );

-- Drives the anonymization sweep. Partial, so it holds only the working set and
-- shrinks to nothing once the backlog is cleared: in a healthy system almost
-- every row is anonymized and this index is nearly empty.
CREATE INDEX audit_log_pending_anon_idx ON audit_log (created_at)
    WHERE anonymized_at IS NULL;

-- Replaces the user-scoped read path for anonymized rows. `audit_log_user_idx`
-- from 0002 simply stops matching a row once user_id becomes NULL, so no index
-- has to be dropped; this is its successor rather than its replacement.
CREATE INDEX audit_log_pseudonym_idx ON audit_log (subject_pseudonym, created_at DESC)
    WHERE subject_pseudonym IS NOT NULL;

-- Drives the hard-delete sweep at 400 days.
CREATE INDEX audit_log_created_idx ON audit_log (created_at);

-- migrate:down

DROP INDEX IF EXISTS audit_log_created_idx;
DROP INDEX IF EXISTS audit_log_pseudonym_idx;
DROP INDEX IF EXISTS audit_log_pending_anon_idx;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_identity_chk;
ALTER TABLE audit_log DROP COLUMN IF EXISTS anonymized_at;
ALTER TABLE audit_log DROP COLUMN IF EXISTS subject_pseudonym;
