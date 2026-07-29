-- ---------------------------------------------------------------------------
-- Apple licence condition (ii): the store badge link, and a retention bound.
--
-- Apple's grant for song previews is one paragraph with SIX CONJUNCTIVE
-- conditions (docs/compliance/apple-itunes-terms-review.md). Failing any one of
-- them puts the use outside the licence entirely. Two of them need a column.
--
-- CONDITION (ii), verbatim: the preview must be "proximate to a 'Download on
-- iTunes' or 'Download on App Store' badge (as approved by Apple) that acts as
-- a link directly to pages within iTunes where consumers can purchase the
-- promoted content."
--
-- That link is per TRACK, not per provider: a badge pointing at Apple's
-- homepage does not satisfy "directly to pages where consumers can purchase the
-- promoted content". The Search API already returns it as `trackViewUrl` and we
-- were parsing it and throwing it away, which meant the badge could not be
-- rendered even in principle. `store_url` is where it now lives, and the
-- application refuses to serve an iTunes preview without one - partial
-- compliance with a conjunctive licence is non-compliance.
--
-- NULLABLE, because a row written before this migration has no store URL and
-- backfilling would mean spending Apple's rate limit on rows nobody has asked
-- for. Those rows are simply not served until the resolver refreshes them.
--
-- CONDITION (iv) and Apple's recall right drive `revalidate_after`. Apple may
-- "remove any Promo Content immediately upon request" and the previous design
-- kept a resolved URL forever with no revalidation path, so a withdrawn track
-- would have been served indefinitely from our own table. A row past this
-- timestamp is not served from cache; it is re-resolved. Thirty days is short
-- enough to bound the exposure and long enough that revalidation costs a
-- rounding error against a rate limit of roughly twenty calls a minute.
--
-- Deezer is unaffected. Their URLs are signed and expiring and are never
-- persisted at all; `track_previews_deezer_expiry_chk` in 0001 is the third
-- line of defence for that and stays exactly as it is.
-- ---------------------------------------------------------------------------

-- migrate:up

ALTER TABLE track_previews
    ADD COLUMN store_url text,
    ADD COLUMN revalidate_after timestamptz NOT NULL
        DEFAULT (now() + interval '30 days');

-- An https URL on an Apple host, or nothing. Apple now answers with
-- music.apple.com rather than an itunes.apple.com host, so the constraint
-- admits any Apple host rather than pinning the one that happens to be current
-- (docs/compliance/apple-itunes-terms-review.md A9). A badge that links
-- somewhere that is not Apple's store is worse than no badge: it is a licence
-- breach dressed as compliance.
ALTER TABLE track_previews ADD CONSTRAINT track_previews_store_url_chk
    CHECK (
        store_url IS NULL
        OR store_url ~ '^https://([a-z0-9-]+\.)*apple\.com/'
    );

-- Drives the revalidation sweep. Partial, because only rows that are actually
-- due are ever selected and indexing the rest is paying for nothing.
CREATE INDEX track_previews_revalidate_idx
    ON track_previews (revalidate_after)
    WHERE provider = 'itunes';

-- migrate:down

DROP INDEX IF EXISTS track_previews_revalidate_idx;

ALTER TABLE track_previews DROP CONSTRAINT IF EXISTS track_previews_store_url_chk;

ALTER TABLE track_previews
    DROP COLUMN IF EXISTS revalidate_after,
    DROP COLUMN IF EXISTS store_url;
