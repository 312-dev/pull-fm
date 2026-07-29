-- ---------------------------------------------------------------------------
-- Pull.fm schema v7 - the `mb` schema, holding a local copy of the MusicBrainz
-- canonical data dump.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS: COLD LOOKUPS CURRENTLY RETURN NOTHING
--
-- MusicBrainz permits ONE REQUEST PER SECOND across the entire service, per IP,
-- as a licence condition rather than a courtesy. That ceiling is the reason the
-- request path is not allowed to call it, and it does not: every MusicBrainz
-- read in services/discovery.ts goes through `CachedUpstream.peek`, which reads
-- `upstream_cache` and NEVER calls out. Only the background cache warmer fetches,
-- from its own process.
--
-- The consequence is the problem this schema solves. A peek miss returns null,
-- and the item is DROPPED from whatever the user asked for. So an MBID the
-- warmer has not reached yet is not slow, it is absent, and it stays absent
-- until a nightly job working through a 1 req/s budget happens to reach it. At
-- that rate the warmer can never catch up with a catalogue of tens of millions
-- of recordings; it can only ever cover the working set it is pointed at.
--
-- A local copy of the same data changes "hope it was warmed" into "always
-- answered". It is not a rate-limiting fix and must not be described as one:
-- nothing on the request path can reach MusicBrainz to be rate limited in the
-- first place. It is what makes a cold lookup produce an answer at all.
--
-- The secondary benefit, worth stating because it is what the indexes below buy:
-- a UUID that is absent from this table cannot be a real MusicBrainz entity, so
-- "does this id exist" becomes a local index probe instead of a network call.
-- That is a cheap existence check for any route that currently accepts a
-- well-formed UUID and calls an upstream to find out. Whether to use it is that
-- route owner's decision; this schema is what makes it possible.
--
-- ---------------------------------------------------------------------------
-- WHY THE CANONICAL DUMP AND NOT THE FULL EXPORT OR THE LIVE DATA FEED
--
-- LICENSING, and it is the whole reason this file describes the schema it does.
--
-- The canonical dump ships a COPYING file that is verbatim CC0 1.0 Universal
-- ("Creative Commons Legal Code / CC0 1.0 Universal"), verified by extracting it
-- from inside the archive rather than read off a web page. CC0 is a public
-- domain dedication: it attaches nothing to anything downstream of it. The
-- loader re-checks that file's SHA-256 on every run, because a fortnightly
-- re-fetch is a fortnightly re-consent and a relicensed future dump would
-- otherwise load without a word.
--
-- MetaBrainz applies licences PER ARCHIVE, not repository-wide, and the split is
-- easy to state backwards. Precisely:
--
--   canonical dump          CC0 1.0            COPYING  6,390 bytes
--   mbdump.tar.bz2          CC0 1.0            COPYING  6,390 bytes, identical
--   mbdump-derived.tar.bz2  CC BY-NC-SA 3.0 US COPYING 15,818 bytes
--   Live Data Feed          CC BY-NC-SA
--
-- So it is the DERIVED export and the Feed that are encumbered, because they
-- carry the supplementary tables - tags, ratings, and artist-to-genre
-- ASSOCIATIONS. The core full export is CC0 and is simply not used here: it is
-- far larger and carries no pre-normalised lookup column, which is a size and
-- shape argument rather than a licence one.
--
-- Loading a BY-NC-SA archive into this database would attach attribution,
-- NonCommercial and ShareAlike obligations to the database itself and to
-- everything derived from it, permanently and irreversibly. See
-- docs/compliance/metabrainz-terms-review.md finding F5, and the same split
-- called out at the top of packages/upstream/src/musicbrainz/client.ts.
--
-- DO NOT "upgrade" this to the derived export to get tags or genre
-- associations. Those columns are not free; they are a licence change to the
-- product.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE SCHEMA
--
-- Every byte in here is rebuildable from a public URL in a bounded amount of
-- time, and none of it is user data. Backing it up is therefore pure waste
-- twice over: once for the storage, and again for every restore drill that has
-- to move it before the drill can assert anything about the data that actually
-- matters.
--
-- A separate schema makes that exclusion a one-line, greppable property of the
-- backup command instead of a per-table list that silently goes stale the next
-- time a table is added here. infra/backup/pullfm-backup.sh is the consumer;
-- see docs/runbooks/mb-canonical-data.md for the exact flag and for the trap
-- with `--exclude-schema` (it drops the DDL as well as the rows, leaving a
-- restored database whose `schema_migrations` claims this migration is applied
-- while the schema it creates does not exist).
--
-- The reader tolerates the whole schema being absent, so either choice is safe.
-- That is deliberate: a restore that produces a database with no `mb` schema
-- must degrade to the behaviour that shipped before this table existed - a
-- local miss - and not fail.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES AND DELIBERATELY DOES NOT DO
--
-- It creates the schema, an EMPTY `mb.canonical` with the final shape, and the
-- load bookkeeping. It does not create indexes on `mb.canonical`.
--
-- That asymmetry is the point. The loader never mutates the live table: it
-- builds a staging table private to its own run, indexes it while nothing is
-- reading it, and swaps the two inside one transaction. Indexes therefore
-- belong to the loader, which owns their names and their build order, and a
-- migration that also created them would be asserting a shape the loader is
-- about to replace on its next run.
--
-- The empty table exists so that a reader on a freshly migrated database gets
-- zero rows rather than `relation "mb.canonical" does not exist`. Zero rows is
-- a local miss, which falls through to the existing path. An error is an
-- outage.
-- ---------------------------------------------------------------------------

-- migrate:up

CREATE SCHEMA IF NOT EXISTS mb;

COMMENT ON SCHEMA mb IS
    'MusicBrainz canonical dump (CC0). Rebuildable from data.metabrainz.org; '
    'EXCLUDED from logical backups. Never put user data here.';

-- The dump's own columns, in the dump's own order, with the dump's own names.
--
-- Faithfulness is a feature: the loader `COPY`s the CSV in with no projection
-- and no transformation, which is what lets it stream a 7 GB file through
-- without staging it, and what makes a column-order change upstream a loud
-- `COPY` failure instead of a silent column swap.
--
-- `id` is the dump's own row id. It is a PRIMARY KEY here because it is unique
-- in the source and because a table with no key is a table nobody can point at
-- during an incident. It carries no meaning across dumps: row 42 of this
-- fortnight's dump is not row 42 of the last one.
CREATE TABLE IF NOT EXISTS mb.canonical (
    id                  integer PRIMARY KEY,
    artist_credit_id    integer NOT NULL,
    -- TEXT, AND IT IS GENUINELY MULTI-VALUED. Measured over the whole
    -- 2026-07-17 dump: 4,808,992 of 31,554,198 rows (15.2%) carry MORE THAN ONE
    -- UUID, comma separated inside a quoted CSV field -
    -- "e6b10e75-...,c5cbbefb-..." for "Hot Pink Delorean & Fantastadon", up to
    -- eight in one credit. The remaining 84.8% carry a single bare UUID with no
    -- array punctuation at all.
    --
    -- That format is `uuid` for neither shape and `uuid[]` for neither shape.
    -- Postgres array input requires braces, so `COPY` into a `uuid[]` column
    -- rejects both `a` and `a,b`, and a `uuid` column rejects `a,b`. Converting
    -- would mean a transform in the stream or a full-table `ALTER ... USING`
    -- rewrite of 6 GB, on every fortnightly load, to change a representation
    -- the dump already made a decision about.
    --
    -- So it is stored VERBATIM, which is also what keeps `COPY` a straight byte
    -- pipe with no projection, and the array-ness is recovered by an EXPRESSION
    -- GIN INDEX the loader builds:
    --
    --   USING gin ((string_to_array(artist_mbids, ',')::uuid[]))
    --
    -- `string_to_array(text, text)` and the cast are both IMMUTABLE, so that is
    -- a legal index expression. Containment queries must use the identical
    -- expression or they will not use the index.
    --
    -- The first id is the PRIMARY artist of the credit, which matches how
    -- `MusicBrainzClient.parseRecording` reads `artist-credit[0].artist.id` from
    -- the web service. A reader that wants one artist takes the first; a reader
    -- that wants to know whether an artist appears at all uses containment.
    --
    -- This was caught by loading the real dump, not by reading it: the first
    -- five million rows are all single-UUID "Various Artists" credits, so a
    -- `uuid` column passes every small test and fails somewhere past row
    -- 5,000,000 on the only run that matters.
    artist_mbids        text    NOT NULL,
    artist_credit_name  text    NOT NULL,
    release_mbid        uuid    NOT NULL,
    release_name        text    NOT NULL,
    recording_mbid      uuid    NOT NULL,
    recording_name      text    NOT NULL,
    -- The dump's pre-normalised search key: `unidecode(strip_non_word(
    -- artist_credit_name || recording_name).lower())`. Reproduced in
    -- packages/upstream/src/musicbrainz/canonical-key.ts, which is the only
    -- sanctioned way to build a value to compare against this column.
    --
    -- MEASURED UNIQUE across the WHOLE 2026-07-17 dump: 31,554,198 rows,
    -- 31,554,198 distinct keys, zero collisions. The dump has already collapsed
    -- each key to one canonical row, so an exact lookup expects at most one
    -- answer. The index the loader builds is deliberately NOT declared unique
    -- anyway: one collision in a future dump would fail the entire load and take
    -- the feature offline, which is far worse than two rows sharing a key and
    -- the reader taking the better-ranked one.
    --
    -- ALSO MEASURED PURE ASCII: zero of those 31,554,198 keys contain a
    -- non-ASCII character, which confirms that `unidecode` always finishes the
    -- job upstream. That is what makes the ASCII test in
    -- packages/upstream/src/musicbrainz/canonical-key.ts a sound way to decide,
    -- for free and before any query, that a key we could not fully fold cannot
    -- match any row. Longest key observed: 953 characters.
    combined_lookup     text    NOT NULL,
    -- NOT a popularity score, despite the name, and getting this backwards
    -- silently picks the wrong row. It is an ORDERING RANK OVER RELEASES and
    -- LOWER IS BETTER: every row sharing a `release_mbid` carries the same value
    -- (274,830 releases sampled from the 2026-07-17 dump, zero with more than
    -- one distinct score), so it ranks releases rather than recordings.
    --
    -- It is also only meaningful WITHIN one artist. Shorty Rogers ranks 4 and
    -- Simon & Garfunkel's "Bridge Over Troubled Water" ranks 564, which is the
    -- opposite of what a popularity reading would predict; the rank reflects
    -- how canonical a release is for its own artist, not how famous it is.
    -- Order ASCENDING, and never compare across artists.
    score               integer NOT NULL
);

COMMENT ON TABLE mb.canonical IS
    'MusicBrainz canonical_musicbrainz_data.csv, loaded verbatim. CC0. '
    'Replaced wholesale by infra/mb-loader; never UPDATEd or DELETEd in place.';

-- Load bookkeeping. Deliberately OUTSIDE the swap, because it is the only thing
-- in this schema that must survive one: a reader has to be able to ask "which
-- dump am I serving, and did the last load finish" without racing the table it
-- is about to query.
--
-- One row per ATTEMPT, not per success. A load that fails leaves a row saying
-- so, which is what turns "the data looks stale" into "the load has been
-- failing since the 17th" without anyone having to find the job's logs.
CREATE TABLE IF NOT EXISTS mb.load_state (
    id            bigserial   PRIMARY KEY,
    -- The dump directory name, e.g. `musicbrainz-canonical-dump-20260717-080003`.
    dump_id       text        NOT NULL,
    -- The publisher's SHA-256 of the archive, as verified before any row was
    -- parsed. Recorded so that "is this the dump I think it is" is answerable
    -- from the database rather than from the file that is no longer on disk.
    sha256        text        NOT NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    -- 'running' | 'ok' | 'failed'. A CHECK rather than an enum so that adding a
    -- state later is a migration rather than a type rewrite.
    status        text        NOT NULL DEFAULT 'running',
    rows_loaded   bigint,
    -- Measured after the swap, from pg_total_relation_size. Kept because the
    -- footprint of this table is the whole reason the schema is excluded from
    -- backups, and an estimate that lives only in a document goes stale.
    bytes_total   bigint,
    bytes_heap    bigint,
    bytes_indexes bigint,
    -- Populated on failure. Free text, because the failure modes are a download,
    -- a checksum, a `COPY`, and a lock timeout, and forcing those into a code
    -- would lose the only detail an operator wants.
    error         text,
    CONSTRAINT mb_load_state_status_chk
        CHECK (status IN ('running', 'ok', 'failed')),
    -- A finished load must say when, and a running one must not. Cheap, and it
    -- makes "the loader was killed" (status 'running', finished_at NULL, old
    -- started_at) distinguishable from "the loader failed cleanly".
    CONSTRAINT mb_load_state_finished_chk
        CHECK (
            (status = 'running' AND finished_at IS NULL)
         OR (status <> 'running' AND finished_at IS NOT NULL)
        )
);

-- The reader's only query against this table: the most recent successful load.
-- Partial, so it holds one row per successful load and nothing else.
CREATE INDEX IF NOT EXISTS mb_load_state_ok_idx
    ON mb.load_state (finished_at DESC)
    WHERE status = 'ok';

-- migrate:down

-- CASCADE because the loader creates and drops tables and indexes inside this
-- schema that no migration knows the names of. Dropping the schema by name is
-- the only reversal that is correct regardless of what the loader last left
-- behind, and it is safe precisely because nothing in here is user data: the
-- whole schema is rebuildable from a public URL.
DROP SCHEMA IF EXISTS mb CASCADE;
