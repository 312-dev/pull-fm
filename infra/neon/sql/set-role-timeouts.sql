-- ===========================================================================
-- Pull.fm - server-side query ceilings, as ROLE DEFAULTS.
--
-- THE POOLED ENDPOINT IS WHY THIS FILE EXISTS.
--
-- `apps/bff/src/lib/db.ts` sets `statement_timeout` and
-- `idle_in_transaction_session_timeout` on the pg.Pool, and node-postgres sends
-- both in the libpq StartupMessage. That is the only place the application can
-- express the ceiling, and IT DOES NOT SURVIVE A TRANSACTION POOLER. Measured
-- against a local PgBouncer, and the failure is silent in the worst of the two
-- configurations:
--
--   without `ignore_startup_parameters`  the connection is REFUSED outright,
--                                        "unsupported startup parameter:
--                                        statement_timeout"
--   with it                              the connection SUCCEEDS and the value
--                                        is DISCARDED. The backend reports
--                                        current_setting('statement_timeout')
--                                        = '0' and SELECT pg_sleep(6) runs to
--                                        completion.
--
-- `ignore_startup_parameters` means IGNORE, not FORWARD, and the name is the
-- whole trap. `track_extra_parameters` does not help either: it stops the
-- rejection but the value is still dropped, because Postgres does not
-- GUC_REPORT either setting, so PgBouncer never observes them and never
-- forwards them.
--
-- NEON'S POOLED ENDPOINT (`*-pooler.*.neon.tech`) IS PGBOUNCER IN TRANSACTION
-- MODE, operated by Neon, so all of the above is true of this deployment and
-- not only of the laptop. `DATABASE_URL` points at the pooled host. Without the
-- statements below, every request-path connection in every environment runs
-- with NO statement timeout whatever `DATABASE_STATEMENT_TIMEOUT_MS` says, and
-- security/THREAT-MODEL.md T10 - pool exhaustion through a slow or unbounded
-- query - has no mitigation at all.
--
-- A ROLE DEFAULT is the one mechanism that holds. It is applied by the backend
-- at session start, before any pooler is involved, and `DISCARD ALL` - which is
-- what PgBouncer issues between transactions - RESETS TO IT rather than away
-- from it. It works identically through session pooling, transaction pooling
-- and a direct connection.
--
-- infra/local/postgres-init/01-role-timeouts.sql is the local mirror of this
-- file. Neither is a workaround for the other; they are the same control
-- applied to the two places the application connects to.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------------
--
--   psql -v ON_ERROR_STOP=1 \
--        -f infra/neon/sql/set-role-timeouts.sql \
--        "$(terraform -chdir=infra/neon output -raw main_database_url_owner_direct)"
--
-- Idempotent, and re-running it is the documented repair. Run it ONCE PER
-- BRANCH: a Neon branch inherits role settings as they were when it was cut, so
-- a branch created before this file was applied does not have them.
--
-- Run it on the DIRECT endpoint. `ALTER ROLE` is DDL against a shared catalog
-- and has no business going through a transaction pooler.
--
-- IT DOES NOT REACH POOLED CONNECTIONS THAT ALREADY EXIST, and that is the one
-- thing to know when applying it to a live branch. A role default is read by
-- the backend at session start, and PgBouncer keeps server connections parked
-- for reuse, so a backend that started before this ran keeps the OLD value
-- until it is recycled. Measured on staging, 2026-07-29: immediately after
-- applying it, a single connection through the pooled endpoint was served by
-- the parked pre-change backend and reported statement_timeout = 0. Opening 20
-- concurrent sessions forced PgBouncer to source new backends and 19 of the 20
-- reported the new value.
--
-- So a single probe after applying this can report the old value and look like
-- a failure when nothing failed. Fan out, or wait for the pooler to recycle.
-- Nothing needs to be restarted: the stale connections age out on their own.
--
-- `infra/neon/sql/verify-app-role.sql` asserts every value set here, so the
-- guarantee is checked on every verification run rather than proved once on the
-- day it was applied.
-- ===========================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'wrong database: expected neondb, connected to %', current_database();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The application role. THIS IS THE T10 MITIGATION.
--
-- 30 seconds, and it is a CEILING rather than the intended value. The
-- application asks for DATABASE_STATEMENT_TIMEOUT_MS (10s by default) and gets
-- it on a direct connection; through the pooler that request is discarded and
-- this is the number that applies. So the effective request-path ceiling in
-- this deployment is 30s, and lowering the application setting alone cannot
-- change that. Anyone tightening the request path must change BOTH.
--
-- The gap between the two is deliberate rather than sloppy. A role default that
-- exactly equalled the application's value would make every application-level
-- timeout indistinguishable from the server-side backstop in the logs, and the
-- backstop is meant to catch the case where the application-level control is
-- absent - which, through the pooler, is every case.
--
-- 60s for idle_in_transaction. Long enough that no legitimate request-path
-- transaction reaches it, short enough that a leaked BEGIN cannot hold a pooled
-- connection and its locks indefinitely.
--
-- These same two statements are in create-app-role.sql so a freshly created
-- role is never unbounded, even briefly. THIS FILE IS THE AUTHORITY and
-- verify-app-role.sql asserts the values, so the two cannot drift silently.
--
-- NO `SET ROLE neon_superuser` HERE, unlike create-app-role.sql, and the
-- difference was measured rather than assumed. `ALTER ROLE ... SET` on another
-- role needs the CREATEROLE attribute plus ADMIN OPTION on the target, and
-- neondb_owner turns out to have both. Measured on 2026-07-29, Postgres 18:
--
--   rolname       | rolsuper | rolcreaterole | rolcreatedb | rolinherit
--   neondb_owner  | f        | t             | t           | t
--
--   member         | role       | admin_option | grantor
--   neon_superuser | pullfm_app | t            | cloud_admin
--
-- CREATEROLE is a direct attribute of neondb_owner (Neon grants it), and the
-- ADMIN OPTION arrives through membership in neon_superuser, which IS
-- inherited - membership privileges are, only ATTRIBUTES are not. So both
-- statements below succeed as the owner, and borrowing neon_superuser to run
-- them would be privilege nobody needs.
ALTER ROLE pullfm_app SET statement_timeout = '30s';
ALTER ROLE pullfm_app SET idle_in_transaction_session_timeout = '60s';

-- ---------------------------------------------------------------------------
-- The owner role. NOT the request path, and the value reflects that.
--
-- Three things connect as neondb_owner: the forward migration runner
-- (packages/db/scripts/migrate.mjs), the MusicBrainz canonical loader
-- (infra/mb-loader/mb-canonical-load.sh), and a human with psql. None of them
-- is behind the pooler and none of them is bounded by anything else, so before
-- this file the owner ran with statement_timeout = 0 - genuinely unbounded -
-- on both branches. Measured on 2026-07-29, before applying it:
--
--   neondb=> select current_setting('statement_timeout');
--    0
--
-- 15 MINUTES, NOT 30 SECONDS. This role legitimately runs statements that take
-- minutes: a migration that adds an index to a large table, and the canonical
-- loader's `COPY` of a 7.5 GB CSV. A ceiling tight enough to be interesting on
-- the request path would turn a normal deploy into a failed one, which is how a
-- safety control gets removed rather than fixed. What 15 minutes bounds is the
-- case actually worth bounding here: a session that is wedged rather than slow,
-- holding locks against the application until somebody notices.
--
-- It is a DEFAULT, so anything that genuinely needs longer opts out explicitly
-- and visibly. Exactly one thing does, and it says so where it does it:
-- infra/mb-loader/mb-canonical-load.sh exports
-- `PGOPTIONS=-c statement_timeout=0`, because a single `COPY` of the full dump
-- is one statement that runs for as long as the download does.
--
-- idle_in_transaction is set to the value Neon already applies cluster-wide.
-- That is not a no-op: unset, it is a VENDOR DEFAULT that can change under us
-- without notice and that nothing in this repository asserts. Set here, it is
-- our number, in our file, checked by verify-app-role.sql.
ALTER ROLE neondb_owner SET statement_timeout = '15min';
ALTER ROLE neondb_owner SET idle_in_transaction_session_timeout = '5min';

-- ---------------------------------------------------------------------------
-- Report what is now recorded. `pg_db_role_setting` is the catalog the pooler
-- cannot get between: what is in here is what the backend applies at session
-- start.
--
-- Note that these are NOT visible in the current session. `ALTER ROLE ... SET`
-- takes effect on the NEXT connection, so `SELECT current_setting(...)` here
-- would report the old value and look like a failure. Reconnect to observe it,
-- which is what verify-app-role.sql does.
-- ---------------------------------------------------------------------------
SELECT
  r.rolname AS role,
  coalesce(array_to_string(s.setconfig, ', '), '<none>') AS settings
FROM pg_roles r
LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
WHERE r.rolname IN ('neondb_owner', 'pullfm_app')
ORDER BY r.rolname;

DO $$
BEGIN
  RAISE NOTICE
    'Role defaults applied. They take effect on the NEXT connection, not this '
    'one. Verify with infra/neon/sql/verify-app-role.sql, and prove the pooled '
    'path separately: connect through the -pooler host and check '
    'current_setting(''statement_timeout'') - that is the value a startup '
    'parameter cannot reach.';
END $$;
