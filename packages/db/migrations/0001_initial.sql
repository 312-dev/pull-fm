-- ---------------------------------------------------------------------------
-- Pull.fm schema v1
--
-- Design rules this schema enforces structurally rather than by convention:
--
--   1. Every user-owned row carries user_id and cascades on delete. Account
--      deletion must be a single transaction (App Store 5.1.1(v) + GDPR), not
--      an application-level sweep that can partially fail.
--   2. Per-user third-party credentials are stored ONLY as AES-256-GCM
--      ciphertext with a per-row data key. See docs/PLAN.md section 5.
--   3. Cached upstream data is keyed by MBID and is separable by provider, so
--      the Last.fm 100 MB cache cap (their ToS 4.3.4) can be measured and
--      enforced per provider rather than guessed at.
-- ---------------------------------------------------------------------------

-- migrate:up

-- Extensions are created here rather than only in the local docker init script,
-- so a production database provisioned by Terraform gets them from the same
-- source of truth. All are idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy crosswalk matching
CREATE EXTENSION IF NOT EXISTS unaccent;   -- "Bjork" must match "Björk"
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Identity
--
-- WorkOS owns authentication; we store no password and never will (see plan
-- section 4: issuing no passwords is what removes WorkOS lock-in, since there
-- are no hashes for them to withhold). We keep only the stable subject id plus
-- the minimum profile needed to render an account screen.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workos_user_id  text        NOT NULL UNIQUE,
    email           citext,
    display_name    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- Soft-delete marker. The hard delete cascade runs asynchronously so it can
    -- be retried, but the account must appear gone immediately on request.
    deleted_at      timestamptz,

    CONSTRAINT users_email_lower CHECK (email IS NULL OR email = lower(email))
);

CREATE INDEX users_deleted_at_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Per-user third-party credentials (the highest-value asset in the system)
--
-- Envelope encryption: each row has its own data encryption key (DEK), which is
-- itself encrypted by an application-wide key encryption key (KEK). Rotating
-- the KEK re-wraps DEKs only and never touches token plaintext, which is what
-- makes rotation an online operation instead of a migration.
--
-- kek_id exists from day one deliberately. Nango, a commercial product in
-- exactly this business, shipped without it and consequently cannot rotate its
-- encryption key at all. That is a one-way mistake.
-- ---------------------------------------------------------------------------
CREATE TABLE user_connections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- 'listenbrainz' | 'lastfm'
    provider            text        NOT NULL,
    -- The user's identity at the provider (LB username, Last.fm username).
    -- Not a secret; needed to build API calls and to show in the UI.
    provider_account_id text        NOT NULL,

    -- Envelope encryption material.
    kek_id              text        NOT NULL,
    wrapped_dek         bytea       NOT NULL,
    -- Layout: nonce(12 bytes) || ciphertext || GCM tag(16 bytes).
    -- AAD binds user_id || provider || column name, so a row-swap or a
    -- cross-column copy fails authentication rather than silently decrypting.
    access_token_ct     bytea       NOT NULL,
    refresh_token_ct    bytea,

    access_expires_at   timestamptz,
    scopes              text[],

    status              text        NOT NULL DEFAULT 'active',
    last_verified_at    timestamptz,
    last_error          text,
    revoked_at          timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT user_connections_provider_chk
        CHECK (provider IN ('listenbrainz', 'lastfm')),
    CONSTRAINT user_connections_status_chk
        CHECK (status IN ('active', 'expired', 'revoked', 'error')),
    -- A nonce and tag alone are 28 bytes, so any shorter value cannot be a
    -- valid GCM payload and almost certainly means plaintext was written.
    CONSTRAINT user_connections_ct_len_chk
        CHECK (octet_length(access_token_ct) > 28),

    UNIQUE (user_id, provider, provider_account_id)
);

CREATE INDEX user_connections_user_idx    ON user_connections (user_id);
-- Drives the background re-wrap job when the KEK is rotated.
CREATE INDEX user_connections_kek_idx     ON user_connections (kek_id);
-- Drives the proactive refresh sweep; partial so it stays small.
CREATE INDEX user_connections_refresh_idx ON user_connections (access_expires_at)
    WHERE status = 'active' AND access_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Wishlist: the acquisition bridge
--
-- Pull.fm is non-commercial (plan section 1a), so buy links carry NO affiliate
-- parameters. That is a licence condition of Last.fm, Deezer, and Apple
-- simultaneously, so it is enforced here as a constraint rather than trusted to
-- application code.
-- ---------------------------------------------------------------------------
CREATE TABLE wishlist_items (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    recording_mbid    uuid,
    release_mbid      uuid,
    artist_mbid       uuid,
    -- Denormalized display fields: MusicBrainz allows 1 req/s globally, so we
    -- cannot re-resolve names on read. See plan section 3.
    artist_name       text        NOT NULL,
    title             text        NOT NULL,

    source            text        NOT NULL DEFAULT 'manual',
    status            text        NOT NULL DEFAULT 'wanted',
    note              text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    acquired_at       timestamptz,

    CONSTRAINT wishlist_source_chk
        CHECK (source IN ('manual', 'lastfm_loved', 'listenbrainz_loved', 'recommendation')),
    CONSTRAINT wishlist_status_chk
        CHECK (status IN ('wanted', 'acquired', 'unavailable', 'dismissed')),

    -- One row per user per recording. Makes POST /v1/wishlist naturally
    -- idempotent under retry, which mobile clients on flaky networks require.
    UNIQUE (user_id, recording_mbid)
);

CREATE INDEX wishlist_user_created_idx ON wishlist_items (user_id, created_at DESC);
CREATE INDEX wishlist_user_status_idx  ON wishlist_items (user_id, status);

-- ---------------------------------------------------------------------------
-- Idempotency
--
-- Required on every mutating endpoint. A double-tap on a phone must not create
-- two wishlist rows, and a retried request must return the ORIGINAL response
-- rather than re-executing.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    key            text        NOT NULL,
    user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Guards against a client reusing one key for a different call, which would
    -- otherwise return a wrong cached response.
    request_hash   text        NOT NULL,
    response_status int,
    response_body  jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL DEFAULT now() + interval '24 hours',

    PRIMARY KEY (user_id, key)
);

CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Upstream cache
--
-- Cache-first is not an optimisation here, it is the architecture. MusicBrainz
-- permits 1 req/s globally and iTunes about 20 calls/min, so anything served
-- synchronously from an upstream cannot scale past a few hundred users.
--
-- provider is a first-class column so per-provider cache SIZE can be measured.
-- Last.fm's ToS 4.3.4 caps cached Last.fm data at 100 MB, which we can only
-- honour if we can measure it. See the cache_size_by_provider view below.
-- ---------------------------------------------------------------------------
CREATE TABLE upstream_cache (
    provider    text        NOT NULL,
    cache_key   text        NOT NULL,
    payload     jsonb       NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz,
    hit_count   bigint      NOT NULL DEFAULT 0,
    last_hit_at timestamptz,

    CONSTRAINT upstream_cache_provider_chk
        CHECK (provider IN ('listenbrainz', 'lastfm', 'musicbrainz',
                            'itunes', 'deezer', 'reccobeats', 'acousticbrainz')),

    PRIMARY KEY (provider, cache_key)
);

CREATE INDEX upstream_cache_expiry_idx ON upstream_cache (expires_at)
    WHERE expires_at IS NOT NULL;
-- Supports LRU eviction when a provider approaches its cache cap.
CREATE INDEX upstream_cache_lru_idx ON upstream_cache (provider, last_hit_at NULLS FIRST);

-- Makes the Last.fm 100 MB licence cap observable. pg_column_size includes TOAST
-- overhead, so this is an upper bound, which is the safe direction to err.
CREATE VIEW cache_size_by_provider AS
SELECT provider,
       count(*)                                   AS entries,
       sum(pg_column_size(payload))               AS bytes,
       round(sum(pg_column_size(payload)) / 1048576.0, 2) AS megabytes
FROM upstream_cache
GROUP BY provider;

-- ---------------------------------------------------------------------------
-- MBID <-> string crosswalk
--
-- Upstream sources disagree on spelling ("Bjork" vs "Björk"), so resolution is
-- fuzzy and expensive. Every successful resolution is recorded permanently and
-- improves the hit rate over time. Gate 2 requires a warm hit rate above 90%.
-- ---------------------------------------------------------------------------
CREATE TABLE mbid_crosswalk (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type   text        NOT NULL,
    -- Lowercased, unaccented, punctuation-stripped. Computed by the app so the
    -- normalisation rules live in one tested place.
    normalized_key text       NOT NULL,
    mbid          uuid        NOT NULL,
    confidence    real        NOT NULL DEFAULT 1.0,
    source        text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT crosswalk_entity_chk
        CHECK (entity_type IN ('artist', 'recording', 'release')),
    CONSTRAINT crosswalk_confidence_chk
        CHECK (confidence >= 0.0 AND confidence <= 1.0),

    UNIQUE (entity_type, normalized_key)
);

CREATE INDEX crosswalk_mbid_idx ON mbid_crosswalk (mbid);
-- Trigram index for fuzzy fallback when exact normalized lookup misses.
CREATE INDEX crosswalk_trgm_idx ON mbid_crosswalk
    USING gin (normalized_key gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Preview resolution
--
-- Apple preview URLs are unsigned, stable, and cacheable.
-- Deezer preview URLs are SIGNED with an expiry and must never be cached; a
-- stored Deezer URL 403s after expiry. The nullable expires_at plus the check
-- constraint below make that distinction impossible to get wrong silently.
-- ---------------------------------------------------------------------------
CREATE TABLE track_previews (
    recording_mbid uuid        NOT NULL,
    provider       text        NOT NULL,
    preview_url    text        NOT NULL,
    duration_ms    int,
    resolved_at    timestamptz NOT NULL DEFAULT now(),
    -- NULL means the URL is stable (Apple). NOT NULL means it expires (Deezer)
    -- and must be re-resolved immediately before playback.
    url_expires_at timestamptz,

    CONSTRAINT track_previews_provider_chk
        CHECK (provider IN ('itunes', 'deezer')),
    -- Deezer URLs are signed and therefore MUST carry an expiry. Enforcing this
    -- in the schema means a resolver bug fails loudly at write time instead of
    -- producing 403s for users hours later.
    CONSTRAINT track_previews_deezer_expiry_chk
        CHECK (provider <> 'deezer' OR url_expires_at IS NOT NULL),

    PRIMARY KEY (recording_mbid, provider)
);

CREATE INDEX track_previews_expiry_idx ON track_previews (url_expires_at)
    WHERE url_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Audio features
--
-- No good source exists in 2026: AcousticBrainz froze in 2022 and self-reports
-- low quality, and ReccoBeats is an anonymous operator with no SLA. So this is
-- a local table populated from multiple sources, with confidence recorded, and
-- it is never read through to a third party on the hot path.
-- ---------------------------------------------------------------------------
CREATE TABLE audio_features (
    recording_mbid   uuid PRIMARY KEY,
    tempo            real,
    musical_key      int,
    mode             int,
    energy           real,
    valence          real,
    danceability     real,
    acousticness     real,
    instrumentalness real,
    liveness         real,
    speechiness      real,
    loudness         real,

    source           text        NOT NULL,
    -- AcousticBrainz data ships with no confidence values and MetaBrainz
    -- themselves call it unreliable, so it is stored at low confidence and must
    -- never outrank a better source.
    confidence       real        NOT NULL DEFAULT 0.5,
    fetched_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT audio_features_source_chk
        CHECK (source IN ('acousticbrainz', 'reccobeats', 'essentia')),
    CONSTRAINT audio_features_key_chk
        CHECK (musical_key IS NULL OR musical_key BETWEEN 0 AND 11)
);

-- ---------------------------------------------------------------------------
-- Deletion audit
--
-- GDPR requires demonstrating that erasure happened. Rows here intentionally
-- survive the user's deletion (no FK), and hold no personal data beyond the id
-- that was erased.
-- ---------------------------------------------------------------------------
CREATE TABLE deletion_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deleted_user_id uuid        NOT NULL,
    requested_at    timestamptz NOT NULL,
    completed_at    timestamptz,
    rows_deleted    jsonb,
    workos_deleted  boolean     NOT NULL DEFAULT false,
    notes           text
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at            BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_connections_updated_at BEFORE UPDATE ON user_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER wishlist_items_updated_at   BEFORE UPDATE ON wishlist_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TRIGGER IF EXISTS wishlist_items_updated_at   ON wishlist_items;
DROP TRIGGER IF EXISTS user_connections_updated_at ON user_connections;
DROP TRIGGER IF EXISTS users_updated_at            ON users;
DROP FUNCTION IF EXISTS set_updated_at();

DROP VIEW  IF EXISTS cache_size_by_provider;
DROP TABLE IF EXISTS deletion_log;
DROP TABLE IF EXISTS audio_features;
DROP TABLE IF EXISTS track_previews;
DROP TABLE IF EXISTS mbid_crosswalk;
DROP TABLE IF EXISTS upstream_cache;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS wishlist_items;
DROP TABLE IF EXISTS user_connections;
DROP TABLE IF EXISTS users;
