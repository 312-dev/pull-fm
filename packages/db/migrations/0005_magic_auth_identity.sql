-- ---------------------------------------------------------------------------
-- Pull.fm schema v5 - the identity columns magic-link auth actually needs
--
-- Additive only. Nothing in 0001-0004 is altered or dropped, every column is
-- nullable or defaulted, so this applies to a live database without a rewrite
-- and reverses without touching a row that existed before it.
--
-- What is NOT here is the point of the file. Sign-in moved to WorkOS Magic
-- Auth, and this schema gains no secret whatsoever as a result:
--
--     no password hash          none is ever issued (docs/PLAN.md section 4)
--     no session signing key    the session cookie key is DERIVED from the KEK
--                               at startup (apps/bff/src/lib/session-cookie.ts)
--                               and is never at rest anywhere
--     no magic auth code        WorkOS mints, stores, expires and invalidates
--                               it; we never see it except in the one request
--                               that exchanges it
--     no MFA secret             there is no MFA enrolment in this application
--     no refresh token          it lives inside the sealed cookie, in the
--                               client, or in nothing at all
--
-- The whole link to the identity provider remains one column, `workos_user_id`,
-- added in 0001. That is deliberate and it is what makes the vendor
-- replaceable: there is nothing here that WorkOS could refuse to export,
-- because there is nothing here that came from WorkOS except an opaque id.
-- ---------------------------------------------------------------------------

-- migrate:up

-- ---------------------------------------------------------------------------
-- auth_method: the mechanism that last proved control of this account.
--
-- The CHECK is the enforcement of a product decision, in the same spirit as
-- 0002's read-only scope constraint: widening it is a migration, and therefore
-- a review, rather than a config flag someone flips at 2am.
--
-- Read apps/bff/src/services/workos.ts before adding a value here. Magic Auth
-- is a server-to-server exchange, which is why every screen in the sign-in flow
-- is ours and the user never sees a third-party hostname. 'social' would
-- require a hosted redirect and a paid custom domain to keep that property;
-- 'passkey' would bind every credential to a domain name we have not committed
-- to permanently. Both are deferred deliberately. Adding one to this list
-- without also solving that is how the property gets lost quietly.
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN auth_method text NOT NULL DEFAULT 'magic_auth';

ALTER TABLE users
    ADD CONSTRAINT users_auth_method_chk
        CHECK (auth_method IN ('magic_auth'));

-- ---------------------------------------------------------------------------
-- email_verified_at: when mailbox control was last demonstrated.
--
-- Under magic-link auth this is not a separate verification step that could be
-- skipped: completing a sign-in IS the proof, because the code only reaches
-- someone who can read the mailbox. Recording it makes that provable after the
-- fact, and it is the fact that justifies treating the address as the account's
-- durable identifier across a future identity-provider migration.
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN email_verified_at timestamptz;

-- ---------------------------------------------------------------------------
-- last_authenticated_at: when a session was last established from scratch.
--
-- Distinct from the JWT `iat` that DELETE /v1/me already checks (THREAT-MODEL
-- M16): that value proves the freshness of ONE credential and vanishes with it.
-- This column survives, so an incident responder can answer "when did this
-- account last actually sign in" without reconstructing it from the audit log.
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN last_authenticated_at timestamptz;

-- ---------------------------------------------------------------------------
-- One live account per address.
--
-- 0001 put no uniqueness on email because the address was decoration: the
-- identity was the WorkOS subject id and the address was a display field. With
-- magic-link sign-in the address IS the thing a user proves control of, so two
-- active rows sharing one would be two accounts one person can sign into and
-- cannot tell apart. That is an account-confusion bug that presents as data
-- loss, and it belongs in a constraint rather than in a code path.
--
-- Partial on two predicates, both required:
--
--   deleted_at IS NULL   a soft-deleted account must not block the same person
--                        signing up again. Erasure means gone, not tombstoned.
--   email IS NOT NULL    redundant in Postgres, since NULLs never collide in a
--                        unique index, and written anyway so the intent is not
--                        mistaken for an oversight by the next reader.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX users_active_email_idx ON users (email)
    WHERE deleted_at IS NULL AND email IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS users_active_email_idx;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_method_chk;
ALTER TABLE users DROP COLUMN IF EXISTS last_authenticated_at;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;
ALTER TABLE users DROP COLUMN IF EXISTS auth_method;
