-- ---------------------------------------------------------------------------
-- Pull.fm schema v9 - the TEXT of every published legal revision
--
-- WHAT WAS WRONG
--
-- Migration 0008 stored, per published revision, a version, an epoch, a digest
-- and a URL. It did not store the DOCUMENT. So a consent row saying "this person
-- accepted terms-of-service DRAFT-0, whose text hashes to cead3bec..." was
-- unfalsifiable the moment DRAFT-0 stopped being the current version: it named a
-- text, asserted a digest over it, and nothing in the system could produce the
-- text to check the assertion against. A record that cannot be checked is worth
-- very little in the one dispute it exists for, and the digest made it worse
-- rather than better, because a digest with no preimage looks like proof.
--
-- WHY NOT GIT, WHICH ALREADY HAS EVERY REVISION
--
-- Because the deployed artefact is a container image. `pnpm deploy --prod`
-- produces a JavaScript tree with no `.git`, `/opt/pullfm` on the node is not a
-- checkout, and an earlier attempt to read a build sha out of git at runtime
-- returned "unknown" for exactly this reason. Serving history from git would mean
-- shipping a repository and a git binary into the runtime image, and it would
-- mean the answer to "what did this user agree to" depended on a working tree
-- somebody could rebase. Git remains the DRAFTING history; it is not a runtime
-- dependency.
--
-- WHY THE DATABASE, AND WHAT THAT COUPLES
--
-- The text now lives in the same append-only, immutable, trigger-guarded table
-- the digest already lives in, one row from the consent rows that cite it. The
-- trade, argued rather than assumed:
--
--   FOR   The evidence and the thing it is evidence OF are recovered together.
--         Any restore that brings back a consent row brings back the text that
--         row references, with the same PITR window and the same backup
--         encryption. A separate object store would give two retention policies,
--         two failure modes, and a class of incident where the record survives
--         and the document does not.
--   FOR   The integrity is enforceable here and nowhere else. See the CHECK
--         below: the database refuses to store text that does not hash to the
--         digest the same row claims. A file in a bucket cannot be constrained
--         that way.
--   FOR   It is small. Two documents, roughly 140 KB of markdown, once per
--         version, forever.
--   AGAINST  Losing the database loses the text. Accepted, because losing the
--         database also loses every consent row, so there would be nothing left
--         to substantiate; coupling them means there is no state where one
--         survives without the other.
--   AGAINST  It cannot be corrected in place. Correct, and intended: a
--         correction is a new version with a new digest, which is the same rule
--         the rest of this design already enforces.
--
-- WHY THE COLUMN IS NULLABLE, WHICH LOOKS LIKE A HOLE
--
-- Because rows already exist. `legal_document_revisions` is append-only and
-- refuses UPDATE, and there is no in-database source to backfill from, so a
-- NOT NULL column with a default would either fail or invent text. Nullable plus
-- the narrow backfill permitted below is the only shape that can turn an existing
-- row into a complete one. A row that stays NULL is a version this deployment
-- cannot produce, and the route answers a specific 503 for it rather than
-- pretending it does not exist.
--
-- Additive: one nullable column, one CHECK, and one trigger function replaced
-- with a strictly narrower one. No row is rewritten.
-- ---------------------------------------------------------------------------

-- migrate:up

ALTER TABLE legal_document_revisions
    ADD COLUMN content text;

COMMENT ON COLUMN legal_document_revisions.content IS
    'The canonical NORMALIZED text of this revision, byte-identical to what GET /v1/legal/{id}/versions/{version} serves. Normalization is apps/bff/src/lib/legal-documents.ts normalizeLegalText: CRLF folded to LF, trailing whitespace stripped per line, trailing newlines collapsed to one. Null means this deployment never had the text; the route answers 503 rather than serving something that would not hash to content_sha256.';

-- ---------------------------------------------------------------------------
-- THE STRUCTURAL GUARANTEE, and it is the one that makes this migration worth
-- more than an ALTER TABLE.
--
-- The stored text MUST hash to the digest stored on the same row. Not "should",
-- not "is asserted by the service that writes it": the database recomputes
-- sha256 over the text and refuses the row otherwise.
--
-- Why that is worth a CHECK rather than a code path. The failure being excluded
-- is a row that carries the digest of one text and the bytes of another. That row
-- is worse than a null one, because it looks complete: the API would serve bytes
-- alongside a digest they do not satisfy, a client would hash them, and
-- POST /v1/me/consent would refuse every acceptance with a 409 that names a
-- mismatch nobody can explain. It is also unfixable after the fact, because the
-- immutability trigger means the wrong pairing is permanent.
--
-- `digest()` is pgcrypto, which migration 0001 already installs for
-- gen_random_uuid(), and it is declared IMMUTABLE, which is what makes it legal
-- in a CHECK. Postgres hashes the text in the database encoding (UTF-8), which is
-- byte-for-byte what Node's `createHash('sha256').update(text, 'utf8')` hashes;
-- verified on multibyte input rather than assumed, because a disagreement here
-- would make the constraint reject every legitimate row.
-- ---------------------------------------------------------------------------
ALTER TABLE legal_document_revisions
    ADD CONSTRAINT legal_document_revisions_content_digest_chk
    CHECK (
        content IS NULL
        OR (
            length(content) > 0
            AND encode(digest(content, 'sha256'), 'hex') = content_sha256
        )
    );

-- ---------------------------------------------------------------------------
-- Immutability, narrowed to permit exactly one transition: NULL content -> the
-- text that satisfies this row's own digest.
--
-- Migration 0008 pointed this table's BEFORE UPDATE trigger at the shared
-- `legal_immutable_row()`, which refuses every UPDATE. That was right when the
-- row held only assertions. It is now too strict in one specific way that costs
-- real evidence: a revision published by an older build has `content IS NULL`
-- and could never be completed, so the text of that version would be
-- irrecoverable for the lifetime of the database even on a deployment that can
-- read it.
--
-- WHY WIDENING THIS IS SAFE, which is the only question that matters here.
-- `content_sha256` cannot be changed by this trigger and is fixed at insert. The
-- CHECK above means the only value that can be written into `content` is one
-- whose sha256 equals that fixed digest. Finding a second such value is a sha256
-- preimage collision. So the transition is not "an operator may set the text", it
-- is "an operator may supply THE text, or nothing" - and every other column is
-- compared for equality, so the same UPDATE cannot smuggle a change to the epoch,
-- the digest, the publication timestamp, or anything else.
--
-- NULL -> non-NULL only. A non-null content can never be replaced, so a filled
-- row is exactly as immutable as it was before.
--
-- The exception message deliberately keeps the words `legal_immutable_row` and
-- `append-only`: the append-only assertions in consent.test.ts match on that
-- text, and a refusal that no longer says why it refused would pass a weaker
-- test than the one that exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legal_document_revisions_immutable()
RETURNS trigger AS $$
BEGIN
    IF OLD.content IS NULL
       AND NEW.content IS NOT NULL
       AND NEW.document_id    =  OLD.document_id
       AND NEW.version        =  OLD.version
       AND NEW.consent_epoch  =  OLD.consent_epoch
       AND NEW.content_sha256 =  OLD.content_sha256
       AND NEW.is_material    =  OLD.is_material
       AND NEW.url            IS NOT DISTINCT FROM OLD.url
       AND NEW.published_at   =  OLD.published_at
       AND NEW.effective_at   IS NOT DISTINCT FROM OLD.effective_at
       AND NEW.notes          IS NOT DISTINCT FROM OLD.notes
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'legal_immutable_row: % is append-only; % is not permitted. A published revision and a recorded acceptance are historical facts. The only UPDATE allowed on this table fills a NULL content with text that hashes to the row''s existing content_sha256.',
        TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS legal_document_revisions_immutable_trg
    ON legal_document_revisions;

CREATE TRIGGER legal_document_revisions_immutable_trg
    BEFORE UPDATE ON legal_document_revisions
    FOR EACH ROW EXECUTE FUNCTION legal_document_revisions_immutable();

-- migrate:down

DROP TRIGGER IF EXISTS legal_document_revisions_immutable_trg
    ON legal_document_revisions;

-- Back to the shared refuse-everything function from 0008.
CREATE TRIGGER legal_document_revisions_immutable_trg
    BEFORE UPDATE ON legal_document_revisions
    FOR EACH ROW EXECUTE FUNCTION legal_immutable_row();

DROP FUNCTION IF EXISTS legal_document_revisions_immutable();

ALTER TABLE legal_document_revisions
    DROP CONSTRAINT IF EXISTS legal_document_revisions_content_digest_chk;

ALTER TABLE legal_document_revisions
    DROP COLUMN IF EXISTS content;
