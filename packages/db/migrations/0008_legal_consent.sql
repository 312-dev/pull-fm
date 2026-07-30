-- ---------------------------------------------------------------------------
-- Pull.fm schema v8 - published legal revisions, and recorded assent to them
--
-- WHAT WAS WRONG
--
-- legal/terms-of-service.md section 1 said "By creating an account, installing a
-- Pull.fm client, or using the API, you agree to these Terms." That sentence was
-- an ASSERTION and not a MECHANISM. Nothing in the product presented the terms,
-- nothing recorded that anybody had seen them, and distribution is a sideloaded
-- application file from a GitHub Release, so there was no store flow and no
-- installer dialogue doing it either.
--
-- Under Illinois law that is not a paperwork gap, it is the whole agreement.
-- `Sgouros v. TransUnion Corp.`, 817 F.3d 1029 (7th Cir. 2016) found NO CONTRACT
-- FORMED where a user completed a PAID purchase on a page that displayed the
-- terms, because the interface did not communicate that proceeding was assent. A
-- sideloaded app with no consent step has a weaker record than that, not a
-- stronger one. If no contract forms then the section 13 liability cap, the
-- section 16 Illinois governing law and venue, the section 9 third-party
-- beneficiary grant to the SeatGeek Entities, and the section 2 US-only offering
-- are all unenforceable. Every one of them was drafted carefully and every one of
-- them was contingent on assent the product never obtained.
--
-- There is a contractual requirement on top of the formation one. SeatGeek API
-- Terms clause 4.3: "You will ensure that each Application displays, and you will
-- require each End User to accept before using your Application, an end user
-- agreement or terms of service". Shipping without the gate breaches their terms
-- as well as failing to form ours.
--
-- WHY THIS SHAPE: TWO TABLES, NOT ONE
--
--   legal_document_revisions  What we PUBLISHED. Append-only, immutable, one row
--                             per (document, version). The server's own record
--                             that a revision existed, independent of whatever
--                             git checkout is deployed today.
--
--   legal_consents            What a USER ACCEPTED. Append-only across versions,
--                             carrying the version AND the content digest, so
--                             the row alone answers "which exact text did this
--                             person agree to, and when".
--
-- A single table holding "current accepted version" per user was rejected. The
-- question a dispute actually asks is "what did this user agree to in March",
-- and a mutable current-state row cannot answer it: the answer was overwritten
-- by the next acceptance. Evidence that can be overwritten is not evidence.
--
-- WHY THE DIGEST IS DENORMALIZED ONTO THE CONSENT ROW
--
-- The consent row carries `content_sha256` even though the revision row it
-- references also has it. That is deliberate duplication: a consent record has
-- to be self-contained evidence. If the meaning of the row depended on a join to
-- another table, then reading the evidence would require trusting that the other
-- table had not moved - which is exactly the doubt the record exists to remove.
-- The foreign key adds integrity (you cannot record assent to a revision that
-- was never published); the denormalized copy is what makes the row readable on
-- its own.
--
-- WHY THERE IS NO `withdrawn_at`
--
-- Accepting terms of service is not "consent" in the GDPR Article 6(1)(a) sense
-- and is not withdrawable: it is contract formation, and the way out of a
-- contract is termination, which for Pull.fm is DELETE /v1/me (section 15). A
-- nullable withdrawal column would be a MUTABLE column on an append-only
-- evidence table, which is a contradiction, and it would invite an UPDATE path
-- onto the one table that must never have one.
--
-- Additive only. Two new tables and one new nullable column on deletion_log, so
-- this applies to a live database without rewriting a row and reverses without
-- touching anything that predates it.
-- ---------------------------------------------------------------------------

-- migrate:up

-- ---------------------------------------------------------------------------
-- What we published.
--
-- THREE IDENTIFIERS AND THEY DO DIFFERENT JOBS. This is the part that a content
-- hash alone cannot do, and the reason there are three columns rather than one:
--
--   content_sha256  Answers "did the bytes change". It detects drift and it
--                   cannot judge materiality, because a corrected typo and a new
--                   arbitration clause produce equally different hashes.
--   version         Answers "which publication is this". Human-assigned, appears
--                   in the document itself, and is recorded on every consent row
--                   so the evidence names a text rather than a number.
--   consent_epoch   Answers "does an older acceptance still count". Bumped ONLY
--                   for a MATERIAL revision. It is the ONLY column enforcement
--                   compares, so a typo fix cannot log every user out of the
--                   product and a substantive change cannot fail to.
--
-- `effective_at` is RECORDED AND NEVER ENFORCED, and that is a decision. Section
-- 17 promises notice in the application before a material change takes effect,
-- so the obvious design is to compare effective_at to now() in the gate. It was
-- rejected: a deploy that published a future-dated material revision would then
-- enforce nothing, silently, until a wall clock passed - the exact silent-failure
-- shape this schema refuses everywhere else. The operator's control is WHEN THEY
-- BUMP THE EPOCH. Do not bump it until the notice period has run. That is one
-- decision, in one diff, reviewable, instead of a date comparison at runtime.
-- ---------------------------------------------------------------------------
CREATE TABLE legal_document_revisions (
    -- Slug of the document, e.g. 'terms-of-service'. Shape-constrained rather
    -- than enumerated: WHICH documents require assent is a property of the
    -- published set, reconciled against legal/ by a test, not a list of strings
    -- worth a migration to extend. Enumerating it here would also make it
    -- impossible for a test to construct a synthetic document, and the revision
    -- behaviour - material versus not - is only testable with one.
    document_id    text        NOT NULL,
    -- The publication version, as it appears in the document's own header.
    version        text        NOT NULL,

    -- Bumped only for a material revision. Monotonic per document; see the
    -- trigger below, which is what makes that a guarantee rather than a habit.
    consent_epoch  int         NOT NULL,

    -- sha256 of the NORMALIZED document body, lowercase hex. Normalization
    -- (CRLF folded, trailing whitespace stripped, trailing newlines trimmed) is
    -- in apps/bff/src/lib/legal-documents.ts, so a formatter run cannot look
    -- like a revision.
    content_sha256 text        NOT NULL,

    -- Whether this revision raised the epoch. Supplied by the caller and CHECKED
    -- against the previous revision rather than computed silently, because a
    -- caller that believes a material change is cosmetic is a bug that must be
    -- refused rather than quietly corrected.
    is_material    boolean     NOT NULL,

    -- Where the client fetches the text whose digest is above.
    url            text        NOT NULL,

    -- When this server first recorded the revision, which is not the same as
    -- when it was drafted.
    published_at   timestamptz NOT NULL DEFAULT now(),
    -- Null while the document is published but not yet effective. Reported to
    -- the client; never consulted by the gate. See the note above.
    effective_at   timestamptz,
    notes          text,

    PRIMARY KEY (document_id, version),

    CONSTRAINT legal_document_revisions_id_shape_chk
        CHECK (document_id ~ '^[a-z][a-z0-9-]{2,63}$'),
    CONSTRAINT legal_document_revisions_version_shape_chk
        CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    -- A sha256 hex digest is exactly 64 lowercase hex characters. Anything else
    -- means a bug wrote the wrong value, and a wrong digest here would make
    -- every consent row recorded against it worthless as evidence.
    CONSTRAINT legal_document_revisions_digest_shape_chk
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    -- Epoch 0 would mean "no acceptance required", which is not a state this
    -- table may represent: a document that needs no assent does not belong here.
    CONSTRAINT legal_document_revisions_epoch_chk
        CHECK (consent_epoch >= 1)
);

-- ---------------------------------------------------------------------------
-- The structural guarantee: an epoch cannot regress and materiality cannot lie.
--
-- Read the three legal transitions for a document:
--
--   first revision   no previous row  => epoch must be 1 and is_material true.
--                    The first publication is by definition material; there is
--                    nothing for an existing acceptance to carry over from.
--   cosmetic         epoch == previous => is_material must be false.
--   material         epoch == previous + 1 => is_material must be true.
--
-- Everything else is refused: a lower epoch (which would silently satisfy the
-- gate for users who never accepted the newer text), a skipped epoch (which
-- would make "the epoch after 3" ambiguous in a dispute), and either direction
-- of materiality lie.
--
-- This is in the database rather than in the service for the same reason
-- audit_log_identity_chk is: the state it forbids is one that a bug, an
-- interrupted batch, or hand-run SQL could otherwise produce, and once produced
-- it is indistinguishable from a legitimate row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legal_document_revisions_epoch_guard()
RETURNS trigger AS $$
DECLARE
    prev int;
BEGIN
    -- A RE-INSERT OF A VERSION THAT ALREADY EXISTS IS NOT A NEW REVISION, and
    -- this branch is here because of a Postgres behaviour that is easy to get
    -- wrong: a BEFORE INSERT row trigger fires BEFORE `ON CONFLICT` resolution,
    -- so the idempotent publish in services/legal-consent.ts reaches this
    -- function on every startup, not only the first. Without this the second
    -- process to publish an unchanged registry would be rejected for "keeping the
    -- epoch while claiming to be material", which is exactly what it should do.
    --
    -- Letting it through is safe: the unique constraint turns it into the no-op
    -- the caller asked for, an UPDATE cannot follow because the immutability
    -- trigger below refuses one, and the service reads the stored row back and
    -- refuses to continue if the deployed build disagrees with it.
    IF EXISTS (
        SELECT 1 FROM legal_document_revisions
         WHERE document_id = NEW.document_id AND version = NEW.version
    ) THEN
        RETURN NEW;
    END IF;

    SELECT max(consent_epoch) INTO prev
      FROM legal_document_revisions
     WHERE document_id = NEW.document_id;

    IF prev IS NULL THEN
        IF NEW.consent_epoch <> 1 OR NOT NEW.is_material THEN
            RAISE EXCEPTION
                'legal_document_revisions_epoch_guard: the first revision of % must be epoch 1 and material, got epoch % material %',
                NEW.document_id, NEW.consent_epoch, NEW.is_material;
        END IF;
    ELSIF NEW.consent_epoch = prev THEN
        IF NEW.is_material THEN
            RAISE EXCEPTION
                'legal_document_revisions_epoch_guard: % version % keeps epoch % but claims to be material; a material revision must raise the epoch',
                NEW.document_id, NEW.version, NEW.consent_epoch;
        END IF;
    ELSIF NEW.consent_epoch = prev + 1 THEN
        IF NOT NEW.is_material THEN
            RAISE EXCEPTION
                'legal_document_revisions_epoch_guard: % version % raises the epoch to % but claims not to be material; raising the epoch forces every user to accept again',
                NEW.document_id, NEW.version, NEW.consent_epoch;
        END IF;
    ELSE
        RAISE EXCEPTION
            'legal_document_revisions_epoch_guard: % version % moves the epoch from % to %; only +0 (cosmetic) or +1 (material) is allowed',
            NEW.document_id, NEW.version, prev, NEW.consent_epoch;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER legal_document_revisions_epoch_guard_trg
    BEFORE INSERT ON legal_document_revisions
    FOR EACH ROW EXECUTE FUNCTION legal_document_revisions_epoch_guard();

-- ---------------------------------------------------------------------------
-- Immutability, enforced rather than documented.
--
-- A published revision is a historical fact. Editing one would retroactively
-- change what every consent row referencing it means, which is the single most
-- damaging edit available anywhere in this schema: it converts evidence into
-- fiction without leaving a trace.
--
-- UPDATE and TRUNCATE are refused. DELETE is NOT, and that is deliberate rather
-- than an oversight: a revision that was recorded in error on a staging database
-- has to be removable, and there is no DELETE path in the application to abuse.
-- The row that matters, the user's consent, is protected separately below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legal_immutable_row()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'legal_immutable_row: % is append-only; % is not permitted. A published revision and a recorded acceptance are historical facts.',
        TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER legal_document_revisions_immutable_trg
    BEFORE UPDATE ON legal_document_revisions
    FOR EACH ROW EXECUTE FUNCTION legal_immutable_row();

CREATE TRIGGER legal_document_revisions_no_truncate_trg
    BEFORE TRUNCATE ON legal_document_revisions
    FOR EACH STATEMENT EXECUTE FUNCTION legal_immutable_row();

-- ---------------------------------------------------------------------------
-- What a user accepted.
--
-- THE CASCADE DECISION, AND IT WAS ARGUED RATHER THAN COPIED.
--
-- `user_id ... ON DELETE CASCADE`, so an account deletion takes the consent
-- history with it in the same transaction as everything else. The alternative
-- was the `deletion_log` shape: no foreign key, so the rows outlive the account
-- the way the proof of an erasure has to. Four reasons the cascade won.
--
--   1. THE EVIDENCE THAT SURVIVES DOES NOT HAVE TO BE THIS ROW. The cascade is
--      paired with `deletion_log.consents` below, which the deletion service
--      writes BEFORE the delete. So the fact that assent was given - document,
--      version, digest, epoch, timestamp - survives the account. What does not
--      survive is the IP address, the user agent, the session id and the row's
--      link to a live user. That is the same trade migration 0006 made for
--      audit_log: keep the trail, drop the identifiers.
--
--   2. THE FULL ROW IS THE MOST IDENTIFYING RECORD IN THE SYSTEM AFTER THE
--      CREDENTIAL TABLE. user_id plus IP plus user agent plus an exact
--      timestamp, retained forever, against the possibility of a dispute that
--      will almost certainly never happen, is not proportionate. The minimal
--      receipt is.
--
--   3. AN EXEMPTION IS A PRECEDENT. Gate 1 asserts that every user-owned table
--      cascades, and that assertion is what makes "delete the account" a single
--      transaction rather than an application-level sweep that can half-fail.
--      The first table to opt out is the one every later table cites.
--
--   4. WE ALREADY PUBLISH A PROMISE THAT AN IDENTIFIED SURVIVOR WOULD FALSIFY.
--      The deletion response says the account "and all data derived from it have
--      been deleted from the live database". A surviving row carrying the
--      deleted user's id and IP would make that notice a false statement, and a
--      false statement in a compliance notice is worse than the marginal
--      evidential loss it buys.
--
-- Retention for the "establishment, exercise or defence of legal claims" is
-- available (GDPR Article 17(3)(e), and the CCPA has its own carve-outs), so
-- keeping the row WOULD have been lawful. It was not necessary, which is a
-- different and better answer.
-- ---------------------------------------------------------------------------
CREATE TABLE legal_consents (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    document_id      text        NOT NULL,
    document_version text        NOT NULL,

    -- Denormalized from the revision. See the header: the row has to be readable
    -- as evidence without trusting a join.
    consent_epoch    int         NOT NULL,
    content_sha256   text        NOT NULL,

    accepted_at      timestamptz NOT NULL DEFAULT now(),

    -- WHICH INTERFACE PRESENTED IT. Sgouros turns on the interface rather than
    -- on the text, so "which screen was this" is evidence and not decoration.
    -- Server-derived from whether the subject had any prior acceptance, never
    -- taken from the client, so a client cannot claim it showed a gate it did
    -- not.
    gate             text        NOT NULL,

    -- The client build and platform that presented the screen, as reported by
    -- the client. Untrusted by construction and useful anyway: if a formation
    -- challenge is ever made about what a particular release displayed, this is
    -- the column that says which release it was.
    client_build     text,
    client_platform  text,
    user_agent       text,

    -- Corroborates the act. Same personal-data status as audit_log.ip, and it
    -- leaves with the account for the reasons in the header above.
    ip               inet,

    -- Assent must come from an interactive session. Recorded rather than assumed
    -- so that a future widening of the route's credential policy is visible in
    -- the data as well as in the diff.
    auth_method      text        NOT NULL,
    -- The WorkOS session id (`sid`) the acceptance arrived on, when there was
    -- one. Ties the act to one authenticated session rather than to an account.
    session_id       text,

    -- A revision must have been published before it can be accepted. RESTRICT
    -- rather than CASCADE: removing a revision that somebody accepted would
    -- destroy the meaning of their consent row, so it is refused.
    CONSTRAINT legal_consents_revision_fk
        FOREIGN KEY (document_id, document_version)
        REFERENCES legal_document_revisions (document_id, version)
        ON DELETE RESTRICT,

    -- ONE ROW PER (USER, DOCUMENT, VERSION), and this is what "append-only"
    -- means here in practice.
    --
    -- History is kept ACROSS VERSIONS, which is the axis the dispute question
    -- runs along: "what did this user agree to in March" is answered by the row
    -- for the version that was current in March, and no later acceptance
    -- overwrites it. Within one version a second acceptance is a no-op
    -- (ON CONFLICT DO NOTHING in the service, never DO UPDATE), so the FIRST
    -- acceptance timestamp for a version is preserved forever and a client that
    -- retries the call cannot move it forward or fill the table.
    UNIQUE (user_id, document_id, document_version),

    CONSTRAINT legal_consents_id_shape_chk
        CHECK (document_id ~ '^[a-z][a-z0-9-]{2,63}$'),
    CONSTRAINT legal_consents_digest_shape_chk
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT legal_consents_epoch_chk
        CHECK (consent_epoch >= 1),
    -- Which gate presented the document. 'first-launch' is a user who had
    -- accepted nothing; 'revision' is a user who had accepted an earlier epoch.
    -- Constrained so the two cannot be conflated later by a typo, because the
    -- distinction is the difference between "no contract existed" and "an
    -- earlier contract was being replaced".
    CONSTRAINT legal_consents_gate_chk
        CHECK (gate IN ('first-launch', 'revision')),
    -- Session only. A personal API token is a long-lived script credential and a
    -- script accepting terms on a person's behalf is precisely the defect
    -- Sgouros describes: no human act, no assent. Enforced at the route as well;
    -- here so it cannot be widened without a migration.
    CONSTRAINT legal_consents_auth_method_chk
        CHECK (auth_method = 'session')
);

-- The enforcement read path: the highest epoch this user has accepted, per
-- document, in one index probe per document.
CREATE INDEX legal_consents_lookup_idx
    ON legal_consents (user_id, document_id, consent_epoch DESC);

-- ---------------------------------------------------------------------------
-- Immutability again, and this one has a sharper edge.
--
-- UPDATE is refused, so `accepted_at` cannot be moved, the digest cannot be
-- swapped for a different revision's, and the epoch cannot be raised to make a
-- user appear to have accepted something they did not. Every one of those is a
-- one-statement forgery of the only evidence that a contract was formed.
--
-- DELETE is permitted, and it has to be: the ON DELETE CASCADE above IS a
-- delete, and it is the user's erasure right. A trigger that refused DELETE
-- would break account deletion, which is a worse outcome than the forgery it
-- would prevent - and the forgery it would prevent is available anyway to
-- anyone who can delete rows, since they could delete the account instead.
-- TRUNCATE is refused because nothing legitimate ever truncates this table.
-- ---------------------------------------------------------------------------
CREATE TRIGGER legal_consents_immutable_trg
    BEFORE UPDATE ON legal_consents
    FOR EACH ROW EXECUTE FUNCTION legal_immutable_row();

CREATE TRIGGER legal_consents_no_truncate_trg
    BEFORE TRUNCATE ON legal_consents
    FOR EACH STATEMENT EXECUTE FUNCTION legal_immutable_row();

-- ---------------------------------------------------------------------------
-- The surviving receipt.
--
-- Written by services/deletion.ts inside the cascade transaction, from the rows
-- that are about to be destroyed. `deletion_log` already retains
-- `deleted_user_id` permanently and by design, because it is the proof that an
-- erasure happened; this column adds two facts about a UUID that is already
-- retained, and adds no new identifier. No IP, no user agent, no session id.
--
-- Shape: [{"documentId","version","consentEpoch","contentSha256","acceptedAt","gate"}]
-- jsonb rather than a table because it is read by a human answering one
-- question, once, years later, and a table would need its own retention rule.
-- ---------------------------------------------------------------------------
ALTER TABLE deletion_log
    ADD COLUMN consents jsonb;

-- migrate:down

ALTER TABLE deletion_log DROP COLUMN IF EXISTS consents;

DROP TRIGGER IF EXISTS legal_consents_no_truncate_trg ON legal_consents;
DROP TRIGGER IF EXISTS legal_consents_immutable_trg   ON legal_consents;
DROP TABLE IF EXISTS legal_consents;

DROP TRIGGER IF EXISTS legal_document_revisions_no_truncate_trg  ON legal_document_revisions;
DROP TRIGGER IF EXISTS legal_document_revisions_immutable_trg    ON legal_document_revisions;
DROP TRIGGER IF EXISTS legal_document_revisions_epoch_guard_trg  ON legal_document_revisions;
DROP TABLE IF EXISTS legal_document_revisions;

DROP FUNCTION IF EXISTS legal_immutable_row();
DROP FUNCTION IF EXISTS legal_document_revisions_epoch_guard();
