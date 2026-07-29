-- ---------------------------------------------------------------------------
-- Pull.fm schema v2 - personal API tokens, connect state, and the audit trail
--
-- Additive only. Nothing in 0001 is altered or dropped, so this migration can
-- be applied to a live database and reversed without touching existing rows.
--
-- Three tables land together because they are the three pieces of state the
-- Phase 2 platform surface cannot be built without, and splitting them across
-- migrations would leave an intermediate revision where the API is half
-- functional:
--
--   api_tokens     personal read-only API tokens (the new operator requirement)
--   connect_states the single-use, subject-bound OAuth state store that makes
--                  GET /v1/connections/:service/callback safe (THREAT-MODEL M20)
--   audit_log      append-only record of credential-affecting events (M22)
-- ---------------------------------------------------------------------------

-- migrate:up

-- ---------------------------------------------------------------------------
-- Personal API tokens
--
-- Purpose: a user fetching THEIR OWN recommendations from a script, without a
-- browser session. Legally this is a person reading their own data, which is
-- why it is permissible at all; see docs/api/data-portability.md for why the
-- token surface deliberately exposes no raw upstream payloads.
--
-- The security-relevant column is token_hash, and what matters is what is NOT
-- here: the token itself. Only sha256(token) is stored, so a database
-- disclosure yields no usable credential.
--
-- Why a bare SHA-256 rather than bcrypt/argon2 - the question a reviewer will
-- ask, answered here so it is not re-litigated:
--
--   A password is low-entropy and chosen by a human, so it must be slow to
--   guess. This token is 256 bits from a CSPRNG. There is no dictionary, no
--   reuse across sites, and no offline attack that a work factor would slow
--   down in any meaningful sense. A slow KDF would instead force a table scan
--   (you cannot index on a per-row salted hash), turning every authenticated
--   request into a sequential scan over every token in the system, which is
--   both a latency and a denial-of-service problem. SHA-256 keeps the lookup a
--   single index probe.
--
-- The trade-off that DOES apply to a fast hash is offline brute force, and it
-- is defeated by entropy rather than by work factor. The CHECK on
-- token_hash length is a cheap guard against a code path accidentally storing
-- something that is not a hex sha256 digest, including the token itself.
-- ---------------------------------------------------------------------------
CREATE TABLE api_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- Human label chosen by the user, e.g. "laptop scrobble script".
    name            text        NOT NULL,

    -- sha256(full token), lowercase hex. UNIQUE so a hash collision or a
    -- duplicate insert is a constraint error rather than two live tokens.
    token_hash      text        NOT NULL UNIQUE,

    -- Non-secret display material so the UI and a leak triage can identify a
    -- token without holding it: the environment prefix ('pfm_live' / 'pfm_test')
    -- and the last four characters of the secret.
    token_prefix    text        NOT NULL,
    last_four       text        NOT NULL,

    -- Read-only to start. Stored as an array rather than a bitmask so adding a
    -- scope is a code change, not a migration, and so a scope grant is legible
    -- in a plain SELECT during an incident.
    scopes          text[]      NOT NULL DEFAULT ARRAY['read:me', 'read:wishlist', 'read:recommendations'],

    -- Per-token rate limit. Held here rather than only in Redis so the limit
    -- survives a Redis flush and so it is visible in the export and the audit.
    rate_limit_per_minute int   NOT NULL DEFAULT 60,

    -- Every token expires. A personal access token with no expiry is a
    -- credential that outlives the reason it was created.
    expires_at      timestamptz NOT NULL,
    -- Written at most once a minute by the auth path; see tokens service.
    last_used_at    timestamptz,
    last_used_ip    inet,
    revoked_at      timestamptz,

    -- Set when this token replaced another via POST /v1/tokens/:id/rotate, so
    -- a rotation chain is reconstructable after the fact.
    rotated_from_id uuid,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT api_tokens_name_len_chk
        CHECK (char_length(name) BETWEEN 1 AND 64),
    -- A sha256 hex digest is exactly 64 lowercase hex characters. Anything else
    -- means a bug wrote the wrong value into the column, and the most dangerous
    -- wrong value is the plaintext token.
    CONSTRAINT api_tokens_hash_shape_chk
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT api_tokens_prefix_chk
        CHECK (token_prefix IN ('pfm_live', 'pfm_test')),
    CONSTRAINT api_tokens_last_four_chk
        CHECK (char_length(last_four) = 4),
    CONSTRAINT api_tokens_rate_limit_chk
        CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
    -- Read-only surface. Widening this set is a deliberate, reviewable change.
    CONSTRAINT api_tokens_scopes_chk
        CHECK (scopes <@ ARRAY['read:me', 'read:wishlist', 'read:recommendations', 'read:connections']),
    CONSTRAINT api_tokens_scopes_nonempty_chk
        CHECK (array_length(scopes, 1) >= 1),
    CONSTRAINT api_tokens_expiry_chk
        CHECK (expires_at > created_at),

    -- One name per user, so "rotate the laptop token" is unambiguous.
    UNIQUE (user_id, name)
);

-- The authentication hot path: exactly one index probe per request.
-- token_hash is already UNIQUE, which supplies that index.
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, created_at DESC);
-- Drives the expiry sweep; partial so it stays small.
CREATE INDEX api_tokens_expiry_idx ON api_tokens (expires_at)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Connect-flow state (THREAT-MODEL M20 / T22)
--
-- Last.fm's auth.getSession flow needs a callback, and a callback with no
-- server-side state is a connection-grafting vulnerability: an attacker gets a
-- victim's browser to complete a flow that binds the ATTACKER's Last.fm account
-- to the victim's subject, or the reverse. Last.fm session keys do not expire,
-- so the resulting channel is permanent.
--
-- State lives in Postgres rather than Redis on purpose. Consumption must be
-- atomic and exactly-once, and it must not be possible for a cache eviction to
-- silently turn "already used" into "never seen". A DELETE ... RETURNING gives
-- exactly-once for free, and the row is tiny and short-lived.
-- ---------------------------------------------------------------------------
CREATE TABLE connect_states (
    -- The opaque value handed to the provider. High-entropy, so it is treated
    -- as a secret and stored hashed for the same reason api_tokens is.
    state_hash   text        PRIMARY KEY,
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider     text        NOT NULL,
    -- Exact-match allowlisted at issue time; recorded so the callback cannot be
    -- talked into a different destination than the one the flow started with.
    redirect_uri text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,

    CONSTRAINT connect_states_provider_chk
        CHECK (provider IN ('listenbrainz', 'lastfm')),
    CONSTRAINT connect_states_hash_shape_chk
        CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT connect_states_expiry_chk
        CHECK (expires_at > created_at)
);

CREATE INDEX connect_states_expiry_idx ON connect_states (expires_at);
-- One in-flight connect per user per provider keeps a script from filling the
-- table, and makes "start the flow again" mean "replace the previous attempt".
CREATE UNIQUE INDEX connect_states_user_provider_idx
    ON connect_states (user_id, provider);

-- ---------------------------------------------------------------------------
-- Audit log (THREAT-MODEL M22 / T24)
--
-- Repudiation is normally the least interesting STRIDE letter. Here it decides
-- whether a credential incident produces a scoped disclosure notice or an
-- instruction to every user to rotate everything.
--
-- Deliberately has NO foreign key to users: these rows must survive account
-- deletion, exactly like deletion_log. They therefore hold no personal data
-- beyond the subject id, and never a credential.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     uuid,
    action      text        NOT NULL,
    -- The object acted on: a connection id, a token id, a provider name.
    subject_ref text,
    outcome     text        NOT NULL,
    -- Non-secret context only. Enforced by review plus the logger redaction
    -- list; there is no legitimate reason for a token to reach this column.
    detail      jsonb,
    ip          inet,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT audit_log_outcome_chk
        CHECK (outcome IN ('ok', 'denied', 'error'))
);

CREATE INDEX audit_log_user_idx   ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);

CREATE TRIGGER api_tokens_updated_at BEFORE UPDATE ON api_tokens
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TRIGGER IF EXISTS api_tokens_updated_at ON api_tokens;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS connect_states;
DROP TABLE IF EXISTS api_tokens;
