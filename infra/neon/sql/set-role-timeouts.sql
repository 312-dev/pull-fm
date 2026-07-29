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
-- ON NEON IT IS WORSE THAN THE POOLER, AND THIS FILE ORIGINALLY SAID
-- OTHERWISE. Measured on 2026-07-29 against the live staging branch, with the
-- exact `pg.Pool` configuration the application uses (`statement_timeout:
-- 3000`, `idle_in_transaction_session_timeout: 3000`, node-postgres 8.22, which
-- puts both in the StartupMessage - see `getStartupConf` in `pg/lib/client.js`):
--
--   endpoint                     current_setting('statement_timeout')
--   ep-...-pooler.<...>          30s      (the role default, NOT the 3s asked for)
--   ep-...<direct, no -pooler>   15min    (the role default, NOT the 3s asked for)
--
-- and `SELECT pg_sleep(6)` ran to completion on both, in 6168 ms and 6150 ms.
--
-- So NEON'S PROXY discards these startup parameters, not merely its pooler, and
-- the DIRECT endpoint is not an escape hatch. The same thing sent the other
-- legal way is not silently dropped but loudly refused, on BOTH endpoints:
--
--   $ PGOPTIONS='-c statement_timeout=3s' psql "$DIRECT_URL"
--   ERROR:  unsupported startup parameter in options: statement_timeout.
--           Please use unpooled connection or remove this parameter from the
--           startup package.
--
-- Note what that message advises, and note that following it does not work:
-- the unpooled endpoint produced the identical error. Neon's proxy sits in
-- front of every endpoint it offers.
--
-- The consequence is the reason this file is the whole control rather than a
-- backstop: on Neon there is NO connection-time way for a client to set either
-- of these. `DATABASE_STATEMENT_TIMEOUT_MS` in apps/bff/src/config.ts has no
-- effect in any deployed environment, and the numbers below are the only
-- ceilings that exist. Lowering the application setting cannot tighten the
-- request path; only editing this file and re-applying it can.
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
-- PRECONDITIONS
-- ---------------------------------------------------------------------------
--
-- NOTHING IN THIS FILE NAMES A PROJECT, A REGION, AN ENDPOINT, A BRANCH OR A
-- CONNECTION STRING, and that is a requirement rather than a coincidence. Neon
-- regions are immutable at creation, so "move region" means "new project", and
-- a bootstrap step that needs hand-editing on the way is a bootstrap step that
-- gets skipped. This file must run verbatim against a brand new empty project.
--
-- What must already exist when it runs:
--
--   1. The OWNER role, `neondb_owner`. Neon creates it with the project; this
--      file must be run AS it, on the direct endpoint.
--   2. The APPLICATION role, `pullfm_app`, created by
--      `infra/neon/sql/create-app-role.sql`. That script is a separate bootstrap
--      step and must have run first, on this branch.
--   3. A database named `neondb`, which is Neon's default. Override with
--      `-v expect_database=<name>` if a project ever uses another one; do not
--      edit the file.
--
-- Both role checks below RAISE rather than letting Postgres emit a bare
-- `role "pullfm_app" does not exist`, because the useful information is not
-- that the role is missing, it is which script creates it and that the branch
-- is currently unbounded until it has run.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------------
--
--   psql -v ON_ERROR_STOP=1 \
--        -f infra/neon/sql/set-role-timeouts.sql \
--        "<owner connection string, DIRECT endpoint, this branch>"
--
-- The connection string comes from wherever the project keeps it: a
-- `terraform output -raw <branch>_database_url_owner_direct` for a project this
-- repository manages, or the Neon console for one being bootstrapped. It is
-- deliberately not written into this file.
--
-- Idempotent, and re-running it is the documented repair. Run it ONCE PER
-- BRANCH: a Neon branch inherits role settings as they were when it was cut, so
-- a branch created before this file was applied does not have them. On a new
-- project that means every branch, including the default one.
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
-- AND THE CONVERSE, WHICH IS THE DANGEROUS HALF AND WAS NOT OBVIOUS. A parked
-- backend keeps the old value in BOTH directions: after REMOVING a ceiling, a
-- pooled session can keep reporting and enforcing it. Measured on 2026-07-29
-- against the local PgBouncer stack, which is the same shape as Neon's:
-- `ALTER ROLE pullfm SET statement_timeout = 0` was applied, pg_db_role_setting
-- confirmed the role was now unbounded, and eight concurrent pooled sessions
-- all still reported 10000 ms and all still cancelled `pg_sleep(15)` at ~10 s.
--
-- A verifier that trusts what a session reports therefore passes on a database
-- whose ceiling has just been deleted. `pg_db_role_setting` is the only
-- authority a parked backend cannot forge, which is why both verifiers read the
-- catalog FIRST and treat the live session as corroboration:
--
--   infra/neon/sql/verify-app-role.sql            catalog, run as the owner on
--                                                 the direct endpoint
--   packages/db/scripts/verify-query-ceilings.mjs catalog, then a fan-out, then
--                                                 an actual pg_sleep over the
--                                                 POOLED endpoint as the app
--                                                 role - the only check that
--                                                 exercises the request path
--
-- Measured with the second one on 2026-07-29, after applying this file to both
-- branches, over the pooled endpoint as pullfm_app:
--
--   branch   20/20 sessions   pg_sleep(35)              idle in transaction 70s
--   staging  30000 / 60000ms  cancelled after 31045 ms  session TERMINATED
--   main     30000 / 60000ms  cancelled after 31099 ms  session TERMINATED
--
-- with `canceling statement due to statement timeout` and `terminating
-- connection due to idle-in-transaction timeout` respectively. That is the
-- evidence that these are ceilings and not merely catalog rows.
-- ===========================================================================

\set ON_ERROR_STOP on

-- Neon's default database name, overridable with `-v expect_database=<name>` so
-- a project that does not use the default needs no edit to this file.
\if :{?expect_database}
\else
  \set expect_database neondb
\endif

-- Handed to the block below through a session GUC rather than written into it.
-- psql does NOT interpolate `:'var'` inside a dollar-quoted string - it sees
-- `$$ ... $$` as a quoted literal and leaves it alone - so the obvious spelling
-- fails with `syntax error at or near ":"`. set_config is the way across that
-- boundary, and it keeps the check in PL/pgSQL where it can RAISE a message
-- worth reading.
SELECT set_config('pullfm.expect_database', :'expect_database', false);

DO $$
BEGIN
  IF current_database() <> current_setting('pullfm.expect_database') THEN
    RAISE EXCEPTION 'wrong database: expected %, connected to %',
      current_setting('pullfm.expect_database'), current_database();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The preconditions, checked rather than assumed.
--
-- WHY THIS IS NOT LEFT TO POSTGRES. Without it, a run against a branch where
-- create-app-role.sql has not been applied fails on the first ALTER ROLE with
-- `role "pullfm_app" does not exist`, which reads as a typo rather than as
-- "this branch has no application role yet AND no query ceiling". On a new
-- project, where every step is being done for the first time and in an order
-- somebody is deciding as they go, that is the difference between fixing it now
-- and shipping an unbounded database.
--
-- It also fails CLOSED in the case that matters most: a branch on which this
-- file half-ran (owner set, app role missing) is left with the owner bounded
-- and the request path unbounded, which is the exact combination that looks
-- healthy from an operator's psql session.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(r, ', ' ORDER BY r) INTO missing
  FROM unnest(ARRAY['neondb_owner', 'pullfm_app']) AS r
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot set query ceilings: role(s) % do not exist on this branch. '
      'Run infra/neon/sql/create-app-role.sql (and grant-app-role.sql) against '
      'THIS branch first, then re-run this file. Until it has run, every '
      'connection on this branch is UNBOUNDED and THREAT-MODEL T10 has no '
      'mitigation.', missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The application role. THIS IS THE T10 MITIGATION.
--
-- 30 seconds, and on Neon it is not a backstop behind the application's
-- DATABASE_STATEMENT_TIMEOUT_MS (10s), it IS the request-path ceiling. The
-- measurement at the top of this file is what settles that: the application's
-- request for 3s was discarded on both endpoints, so nothing the application
-- says reaches the backend and 30s is the only number in play. Anyone
-- tightening the request path has to change THIS LINE and re-apply the file;
-- editing config.ts does nothing.
--
-- The gap between the two is still deliberate rather than sloppy, because it is
-- what makes the two distinguishable in a log on a deployment where the
-- application's setting DOES arrive (a bare Postgres, no Neon proxy in front).
-- A role default that exactly equalled the application's value would make every
-- application-level timeout indistinguishable from the server-side backstop.
--
-- WHY 30s AND NOT TIGHTER. It has to clear the slowest thing the request path
-- legitimately does, with room for a cold start, or the control gets removed
-- rather than fixed the first time it kills real work. The candidates, all in
-- packages/upstream/src/musicbrainz/canonical-store.ts against a 31-million-row
-- `mb.canonical`:
--
--   exact lookup        equality on `combined_lookup`, served whole by
--                       canonical_lookup_idx including the ORDER BY
--   artist prefix scan  a `text_pattern_ops` range plus a sort on `score`; the
--                       only one whose row count is not bounded by the index,
--                       and it still carries a LIMIT
--   MBID existence      three index probes with LIMIT 1
--
-- and the four background sweeps (expiry-sweeper.ts, audit-retention.ts), every
-- one of which deletes in batches with a per-statement LIMIT specifically so no
-- single statement is long. Nothing here is a multi-second query, let alone a
-- 30-second one. 30s is roughly three times the application's own intent and
-- orders of magnitude above measured work: comfortably out of the way of
-- legitimate traffic, and still short enough that a wedged statement cannot
-- hold a pooled connection long enough to matter.
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
