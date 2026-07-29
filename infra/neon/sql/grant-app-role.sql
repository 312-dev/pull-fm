-- ===========================================================================
-- Pull.fm - privileges for the least-privilege application role.
--
-- THIS FILE IS NOT MANAGED BY TERRAFORM AND CANNOT BE.
--
-- The Neon provider (kislerdm/neon v0.14.0) exposes exactly eleven resources
-- and none of them can express a GRANT. `neon_role` has a four-attribute
-- schema - project_id, branch_id, name, and a computed password - read from
-- provider/resource_role.go, not from the documentation. There is no
-- `neon_grant`, no `neon_privilege`, and no SQL-executing resource anywhere in
-- the provider. Terraform can therefore create the role object and hand back
-- its password; everything below is SQL and has to be applied by an operator.
--
-- Faking it with a `postgresql` provider or a `null_resource` running psql was
-- considered and rejected: both would put the production database password into
-- a second provider's configuration and into plan output, and this repository
-- is public. See docs/runbooks/neon-migration.md section 10.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------------
--
--   psql -v ON_ERROR_STOP=1 \
--        -f infra/neon/sql/grant-app-role.sql \
--        "$(terraform -chdir=infra/neon output -raw main_database_url_owner_direct)"
--
-- Three properties of that command line are load-bearing:
--
--   * OWNER connection string. ALTER DEFAULT PRIVILEGES binds to a specific
--     creating role, and the role that creates future tables is the role that
--     runs migrations, which is the owner. Running this as anybody else
--     produces default privileges that never fire. The script refuses to run
--     as the wrong role rather than trusting the operator to notice.
--   * DIRECT endpoint, not the pooler. This is a DDL-ish session doing
--     catalog writes; it is the shape a transaction pooler handles worst.
--   * ONCE PER BRANCH. A Neon branch is a copy-on-write clone taken at a
--     moment in time, so grants made on `main` BEFORE `staging` was cut are
--     inherited by `staging` and grants made after it are not. Run it against
--     every branch that serves traffic, and again after any branch reset that
--     predates the grants.
--
-- Idempotent. Re-running it is the correct response to "I am not sure whether
-- this was applied".
--
-- Verify with infra/neon/sql/verify-app-role.sql, which asserts both what the
-- role CAN do and what it MUST NOT be able to do.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. Preconditions
--
-- Every name below is a literal rather than a psql variable, and it must agree
-- with the defaults in infra/neon/variables.tf (`owner_role_name`,
-- `app_role_name`, `database_name`). A silent disagreement between this file
-- and Terraform is the failure this block exists to make loud.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION
      'wrong database: expected neondb, connected to %. '
      'Use the connection string from `terraform output`, not a hand-edited one.',
      current_database();
  END IF;

  IF current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION
      'must run as neondb_owner, connected as %. '
      'ALTER DEFAULT PRIVILEGES binds to the role that creates the objects, and '
      'migrations run as neondb_owner. Running this as any other role produces '
      'default privileges that never apply to a single future table.',
      current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pullfm_app') THEN
    RAISE EXCEPTION
      'role pullfm_app does not exist on this branch. '
      'Either set create_app_role = true and apply infra/neon, or create it with '
      'SQL (see the FALLBACK note at the foot of this file). Note that a branch '
      'only inherits roles that existed when the branch was cut.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Strip neon_superuser. THIS IS THE STEP THAT MAKES THE ROLE LEAST-PRIVILEGE.
--
-- Neon grants membership in `neon_superuser` to every role created through the
-- Console, the API or the CLI, which includes every role Terraform creates,
-- because `neon_role` is an API call. Neon's own documentation is explicit:
-- "Your Postgres role and roles created in the Neon Console, API, and CLI are
-- granted membership in the neon_superuser role", and separately, "roles
-- created with SQL ... are only granted the basic public schema privileges
-- granted to newly created roles in a standalone Postgres installation".
--
-- neon_superuser carries CREATEDB, CREATEROLE, BYPASSRLS and REPLICATION, plus
-- membership in pg_read_all_data, pg_write_all_data, pg_monitor,
-- pg_signal_backend and pg_create_subscription, plus ALL on tables in the
-- public schema WITH GRANT OPTION.
--
-- Role ATTRIBUTES are not inherited through membership, so it is tempting to
-- conclude the membership is harmless. It is not: a member may `SET ROLE
-- neon_superuser` (NOLOGIN does not prevent SET ROLE) and act with every one of
-- those attributes. So an app role created by Terraform and left alone is a
-- second administrator wearing a different name, and pointing DATABASE_URL at
-- it would be security theatre rather than hardening.
--
-- The membership is therefore revoked and then ASSERTED, because a REVOKE that
-- silently does nothing is the one outcome that would leave every artifact in
-- this repository looking correct while production ran as an admin.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')
     AND pg_has_role('pullfm_app', 'neon_superuser', 'MEMBER') THEN
    EXECUTE 'REVOKE neon_superuser FROM pullfm_app';
    RAISE NOTICE 'revoked neon_superuser from pullfm_app';
  END IF;
END $$;

-- Assert, separately from the revoke, so that "the REVOKE was not permitted"
-- and "the REVOKE worked" cannot be confused for one another.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(t.r, ', ' ORDER BY t.r) INTO bad
  FROM unnest(ARRAY[
    'neon_superuser', 'pg_read_all_data', 'pg_write_all_data',
    'pg_monitor', 'pg_signal_backend', 'pg_create_subscription'
  ]) AS t(r)
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.r)
    AND pg_has_role('pullfm_app', t.r, 'MEMBER');

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'pullfm_app is still a member of: %. It is not a least-privilege role and '
      'DATABASE_URL must not point at it. If the REVOKE above was refused, the '
      'owner does not hold ADMIN OPTION on neon_superuser; use the SQL-created '
      'role fallback documented at the foot of this file instead.',
      bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Database level.
--
-- Postgres grants CONNECT and TEMP on a new database to PUBLIC, so without the
-- REVOKE the explicit GRANT below would be decoration: every present and future
-- role could connect anyway. Neon documents this same pair.
--
-- TEMP is deliberately not granted back. A temp table is the one way a role
-- with no CREATE anywhere can still make the database allocate storage on its
-- behalf, and the BFF has no use for one.
-- ---------------------------------------------------------------------------

REVOKE ALL ON DATABASE neondb FROM PUBLIC;
GRANT CONNECT ON DATABASE neondb TO pullfm_app;

-- ---------------------------------------------------------------------------
-- 3. Schema level. USAGE only, NEVER CREATE.
--
-- Neon's own read-write example grants `USAGE, CREATE ON SCHEMA`. That is wrong
-- for this role and the difference is the whole point of the exercise: CREATE on
-- a schema lets the role create tables, the creator of a table OWNS it, and an
-- owner may ALTER and DROP it. A role with CREATE on public can therefore
-- satisfy "must not be able to DROP tables" only until it creates one.
--
-- The REVOKE is belt and braces. Postgres 15 stopped granting CREATE on the
-- public schema to PUBLIC, and this project runs 18, so on a stock cluster this
-- is a no-op. It is written anyway because Neon does modify the public schema's
-- default ACL for neon_superuser, and a no-op REVOKE costs nothing.
-- ---------------------------------------------------------------------------

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pullfm_app;

-- ---------------------------------------------------------------------------
-- 4. Existing objects.
--
-- SELECT, INSERT, UPDATE, DELETE and nothing else. Specifically NOT:
--
--   TRUNCATE   - unbounded destruction in one statement, no WHERE clause to get
--                wrong and no row-by-row cost to notice it happening. Verified
--                against apps/bff/src: the BFF issues no TRUNCATE.
--   REFERENCES - creating a foreign key is schema change, and it can also block
--                writes on the referenced table.
--   TRIGGER    - attaching a trigger to a table is arbitrary code execution in
--                the writer's session.
--
-- ALL TABLES covers views too, which is what the `cache_size_by_provider` view
-- from migration 0001 needs.
--
-- Sequence USAGE is what nextval() requires. The only sequence in the schema
-- today backs `audit_log.id GENERATED ALWAYS AS IDENTITY`; the grant is written
-- unconditionally so that the first migration to add a `serial`-style column
-- does not produce an insert failure that looks like an application bug.
-- SELECT and UPDATE on sequences are not granted: the first only exposes
-- last_value, and the second permits setval().
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pullfm_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pullfm_app;

-- ---------------------------------------------------------------------------
-- 5. FUTURE objects. Read this block before editing anything above it.
--
-- Section 4 grants privileges on the tables that exist RIGHT NOW. Default
-- privileges are not retroactive and ordinary grants are not prospective, so
-- both are required and neither substitutes for the other. Without this block,
-- the next migration that runs `CREATE TABLE` produces a table the application
-- role cannot read, the deploy reports success, and the API starts returning
-- "permission denied for table ..." for one endpoint. That is a silent
-- production break introduced by an unrelated change, which is why this is the
-- part of the file most worth getting right.
--
-- FOR ROLE neondb_owner is not optional and is not decoration. A default-ACL
-- entry is keyed on (creating role, schema, object type). Omitting FOR ROLE
-- defaults to the CURRENT role, so the entry created would be correct only by
-- coincidence, and only for as long as this script is run by the same role that
-- runs migrations. Naming the role means the entry is right independently of
-- who runs this file - and the precondition block above already refuses any
-- other role, so the two agree by construction rather than by luck.
--
-- The invariant this depends on, stated so it can be checked rather than
-- assumed: MIGRATIONS ALWAYS RUN AS neondb_owner. That is true because
-- packages/db/scripts/migrate.mjs connects with DATABASE_URL_DIRECT, and the
-- `*_database_url_owner_direct` outputs are the owner's. If a second migration
-- identity is ever introduced, it needs its own ALTER DEFAULT PRIVILEGES line
-- here, or its tables will be invisible to the application.
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pullfm_app;

ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO pullfm_app;

-- ---------------------------------------------------------------------------
-- 6. Session guards.
--
-- Role-scoped rather than cluster-scoped, so the migration runner and psql are
-- unaffected: a migration that legitimately takes four minutes must not be
-- killed by a limit that exists to bound an application query.
--
-- T10 in security/THREAT-MODEL.md is connection-pool exhaustion through a slow
-- or unbounded query. Neon's pooled endpoint bounds the connection count; only
-- a statement timeout bounds how long one of them can be held.
--
-- Best-effort. ALTER ROLE ... SET needs admin rights over the target role, and
-- whether the owner holds them over an API-created role is a Neon
-- implementation detail rather than a documented guarantee. A failure here
-- leaves every grant above intact, so it warns rather than aborting.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER ROLE pullfm_app SET statement_timeout = ''30s''';
    EXECUTE 'ALTER ROLE pullfm_app SET idle_in_transaction_session_timeout = ''60s''';
    RAISE NOTICE 'set session guards on pullfm_app as the owner';
  EXCEPTION WHEN insufficient_privilege THEN
    -- ALTER ROLE ... SET needs admin rights over the target role. Postgres 16
    -- grants those to whoever CREATEd the role, which for a role made by
    -- create-app-role.sql is neon_superuser rather than the owner. Borrowing
    -- that role for two statements is the documented Neon way to do
    -- role administration and does not widen anything permanently.
    BEGIN
      EXECUTE 'SET ROLE neon_superuser';
      EXECUTE 'ALTER ROLE pullfm_app SET statement_timeout = ''30s''';
      EXECUTE 'ALTER ROLE pullfm_app SET idle_in_transaction_session_timeout = ''60s''';
      EXECUTE 'RESET ROLE';
      RAISE NOTICE 'set session guards on pullfm_app via SET ROLE neon_superuser';
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING
        'could not set session guards on pullfm_app (%). Every GRANT above is '
        'still applied; only the timeouts are missing.', SQLERRM;
    END;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- FALLBACK: creating the role in SQL instead of in Terraform.
--
-- Required if section 1 aborts, which happens when the owner cannot revoke
-- neon_superuser. A role created by the statement below is never a member of
-- neon_superuser in the first place, so the problem does not arise; the cost is
-- that Terraform no longer knows the password, so `create_app_role` must be
-- false and the `*_app_*` connection-string outputs become null and have to be
-- assembled by hand into 1Password.
--
--   CREATE ROLE pullfm_app WITH LOGIN PASSWORD '<32+ bytes from a CSPRNG>';
--
-- Then re-run this file from section 2 onward. Do not paste the password into a
-- shell that records history.
-- ===========================================================================
