-- ---------------------------------------------------------------------------
-- Add 'seatgeek' to the upstream cache provider allow-list.
--
-- SeatGeek was approved as the live-events provider after 0001_initial shipped.
-- `upstream_cache_provider_chk` is an allow-list rather than a free-text column
-- on purpose - it is what makes per-provider cache accounting trustworthy for
-- the Last.fm 100 MB licence cap - so adding a provider is a migration, not a
-- code change.
--
-- Event data is cached (performer ids for 7 days, event lists for 6 hours)
-- because it changes daily at most, and because SeatGeek's /events endpoint has
-- capped result sets at 10,000 since 2026-01-01. Both TTLs are set by their
-- terms 7.13 (no systematic downloading or storage) rather than by volatility;
-- the constants live in packages/upstream/src/events/seatgeek-provider.ts.
--
-- No cap is set for SeatGeek: unlike Last.fm, their terms impose no cache size
-- limit, and the cached volume is bounded by the number of artists we surface.
-- ---------------------------------------------------------------------------

-- migrate:up

ALTER TABLE upstream_cache DROP CONSTRAINT upstream_cache_provider_chk;

ALTER TABLE upstream_cache ADD CONSTRAINT upstream_cache_provider_chk
    CHECK (provider IN ('listenbrainz', 'lastfm', 'musicbrainz',
                        'itunes', 'deezer', 'reccobeats', 'acousticbrainz',
                        'seatgeek'));

-- migrate:down

-- Rows for the removed provider must go first, or the narrower constraint
-- cannot be validated against existing data.
DELETE FROM upstream_cache WHERE provider = 'seatgeek';

ALTER TABLE upstream_cache DROP CONSTRAINT upstream_cache_provider_chk;

ALTER TABLE upstream_cache ADD CONSTRAINT upstream_cache_provider_chk
    CHECK (provider IN ('listenbrainz', 'lastfm', 'musicbrainz',
                        'itunes', 'deezer', 'reccobeats', 'acousticbrainz'));
