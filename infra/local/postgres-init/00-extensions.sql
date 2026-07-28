-- Extensions the schema depends on. Created once at cluster init so migrations
-- can assume they exist. Mirrored in the production provisioning path.

-- Deterministic, index-friendly UUIDv7-style ids come from the app layer, but
-- pgcrypto gives us gen_random_uuid() plus the primitives used by the
-- encrypted-token column checks.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram index support for the unified /v1/search endpoint (artist/track/album
-- fuzzy matching against the local crosswalk cache).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent-insensitive matching: "Bjork" must find "Björk". Critical for the
-- MBID<->string crosswalk hit-rate that Gate 2 measures.
CREATE EXTENSION IF NOT EXISTS unaccent;
