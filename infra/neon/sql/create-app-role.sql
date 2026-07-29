-- ===========================================================================
-- Pull.fm - create the least-privilege application role.
--
-- THIS ROLE IS DELIBERATELY NOT A TERRAFORM RESOURCE, AND THAT IS A FINDING
-- ABOUT NEON RATHER THAN A GAP IN infra/neon.
--
-- `neon_role` creates a role through the Neon API, and Neon grants every role
-- created through the Console, API or CLI membership in `neon_superuser`.
-- That membership carries CREATEDB, CREATEROLE, BYPASSRLS and REPLICATION,
-- plus pg_read_all_data, pg_write_all_data and pg_monitor, plus ALL on the
-- public schema WITH GRANT OPTION. A member may `SET ROLE neon_superuser` and
-- use all of it, so a role created by Terraform is a second administrator no
-- matter what is granted or revoked afterwards.
--
-- The obvious repair, revoking the membership, DOES NOT WORK, and it fails in
-- the worst available way. Measured against Postgres 18 on 2026-07-29:
--
--   neondb_owner=> REVOKE neon_superuser FROM pullfm_app;
--   WARNING:  role "pullfm_app" has not been granted membership in role
--             "neon_superuser" by role "neondb_owner"
--   REVOKE ROLE
--
-- A warning, a success code, and no change. Postgres 16 made role membership
-- track its grantor, and a REVOKE only removes grants issued by the revoking
-- role. Neon's control plane issued this one. Naming the grantor explicitly is
-- refused as well, this time with an error rather than a warning:
--
--   ERROR:  permission denied to revoke privileges granted by role "..."
--
-- and ADMIN OPTION on neon_superuser does not help, because the restriction is
-- about the grantor rather than about admin rights. Only the original grantor
-- or a superuser can revoke it, and Neon gives its customers neither.
--
-- So a Terraform-created application role cannot be made least-privilege, and a
-- script that revoked and did not verify would have reported success while
-- production ran as an administrator. Neon documents the alternative: "roles
-- created with SQL ... are only granted the basic public schema privileges
-- granted to newly created roles in a standalone Postgres installation."
--
-- The cost of this choice is stated rather than hidden: Terraform does not know
-- this role's password, so the `*_app_*` outputs in outputs.tf are templates
-- with a placeholder rather than complete connection strings, and rotation is
-- an ALTER ROLE here rather than a Neon API call.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------------
--
--   openssl rand -base64 24                 # generate, do not invent
--   psql -v ON_ERROR_STOP=1 \
--        -f infra/neon/sql/create-app-role.sql \
--        "$(terraform -chdir=infra/neon output -raw main_database_url_owner_direct)"
--
-- It prompts for the password rather than taking it as `-v`, because a psql
-- variable set on the command line is visible in `ps` output and lands in shell
-- history. psql cannot suppress the echo, so the value does appear on screen;
-- treat the terminal accordingly and put it straight into 1Password as
-- `pull-fm/<env>/DATABASE_APP_PASSWORD`.
--
-- Run it ONCE PER BRANCH, then run grant-app-role.sql on the same branch. A
-- Neon branch inherits the roles that existed when it was cut, so a role
-- created on `main` today does not appear on a `staging` branch cut yesterday.
--
-- Re-running against a branch that already has the role resets the password,
-- which is exactly the rotation procedure.
-- ===========================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'wrong database: expected neondb, connected to %', current_database();
  END IF;
END $$;

\prompt 'Password for pullfm_app (paste from `openssl rand -base64 24`): ' app_password

-- neon_superuser is borrowed for exactly two statements.
--
-- Not laziness and not a shortcut: CREATEROLE is a role ATTRIBUTE, and
-- attributes are not inherited through membership, so neondb_owner cannot
-- create a role even though it is a member of a role that can. Measured:
--
--   neondb_owner=> CREATE ROLE pullfm_app LOGIN PASSWORD '...';
--   ERROR:  permission denied to create role
--   DETAIL:  Only roles with the CREATEROLE attribute may create roles.
--
-- The role created here is NOT a member of neon_superuser. Creating a role
-- while acting as neon_superuser grants the creator ADMIN OPTION over the new
-- role; it does not enrol the new role in anything. Verified on Postgres 18:
-- pg_has_role('pullfm_app', 'neon_superuser', 'MEMBER') is false immediately
-- after this block, which is the entire difference from the `neon_role` path.
SET ROLE neon_superuser;

-- CREATE on first run, ALTER on every later one, so that re-running this file
-- is the password ROTATION procedure rather than an error. The statement is
-- built and executed by \gexec instead of being written literally, because the
-- password has to reach the server as a properly quoted literal (%L) and must
-- not be concatenated into SQL by hand.
SELECT format(
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pullfm_app')
      THEN 'ALTER ROLE pullfm_app WITH LOGIN PASSWORD %L'
    ELSE 'CREATE ROLE pullfm_app WITH LOGIN PASSWORD %L'
  END,
  :'app_password'
)
\gexec

-- Bound how long one application session can hold a pooled connection.
-- security/THREAT-MODEL.md T10 is pool exhaustion through a slow or unbounded
-- query: Neon's pooler bounds the number of connections, and only a statement
-- timeout bounds how long one of them is held. Role-scoped on purpose, so a
-- migration that legitimately runs for four minutes is unaffected.
ALTER ROLE pullfm_app SET statement_timeout = '30s';
ALTER ROLE pullfm_app SET idle_in_transaction_session_timeout = '60s';

RESET ROLE;

-- Fail loudly if the role came out of that block as an administrator anyway.
-- Cheap, and it is the assumption everything downstream rests on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')
     AND pg_has_role('pullfm_app', 'neon_superuser', 'MEMBER') THEN
    RAISE EXCEPTION
      'pullfm_app was created as a member of neon_superuser. This is not the '
      'expected behaviour of CREATE ROLE and it cannot be revoked afterwards; '
      'drop the role and raise the discrepancy before going further.';
  END IF;
  RAISE NOTICE
    'pullfm_app is present with the supplied password. Run '
    'infra/neon/sql/grant-app-role.sql against THIS branch (safe to re-run), '
    'then infra/neon/sql/verify-app-role.sql, then update 1Password.';
END $$;
