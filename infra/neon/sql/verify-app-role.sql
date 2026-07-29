-- ===========================================================================
-- Pull.fm - assertions about the least-privilege application role.
--
-- Read-only apart from one probe table that is created and dropped inside a
-- single transaction. Safe to run against production.
--
--   psql -v ON_ERROR_STOP=1 \
--        -f infra/neon/sql/verify-app-role.sql \
--        "$(terraform -chdir=infra/neon output -raw main_database_url_owner_direct)"
--
-- Run it as the OWNER, not as the app role: several checks read catalogs and
-- ownership that the app role deliberately cannot see, and a check that the app
-- role can skip is not a check.
--
-- Exits non-zero if any assertion fails, and prints the full table either way,
-- so a failure names the specific privilege rather than just the verdict.
--
-- WHY A NEGATIVE TEST SUITE AND NOT JUST THE GRANT SCRIPT
--
-- Every dangerous outcome here is a privilege that is PRESENT when it should be
-- absent. Re-running the grant script proves nothing about those: it only adds.
-- The check that matters is "the role still cannot do X", and the only way to
-- have that is to assert it.
-- ===========================================================================

\set ON_ERROR_STOP on

CREATE TEMP TABLE _pullfm_privcheck (
  seq      int GENERATED ALWAYS AS IDENTITY,
  category text NOT NULL,
  check_   text NOT NULL,
  expected text NOT NULL,
  actual   text NOT NULL,
  ok       boolean NOT NULL
);

-- ---------------------------------------------------------------------------
-- Group 1: the role must NOT be an administrator.
--
-- This is the group that catches the Neon-specific trap. A role created through
-- the Neon API is a member of neon_superuser until something revokes it, and a
-- member may SET ROLE to it and pick up CREATEDB, CREATEROLE, BYPASSRLS and
-- REPLICATION along with pg_read_all_data and pg_write_all_data.
-- ---------------------------------------------------------------------------

-- THE neon_superuser ASSERTION IS SEPARATE, UNCONDITIONAL AND FAIL-CLOSED.
--
-- It is the single guarantee this whole file exists to hold, so it does not
-- share the guarded loop below. The guard on that loop (`WHERE EXISTS ... FROM
-- pg_roles`) is there because pg_has_role() raises when asked about a role that
-- does not exist, and it has a failure mode of its own: if the role is missing,
-- the guard removes the row and the check silently does not happen. A check that
-- can vanish is not a guarantee.
--
-- So there are two distinct failures here and they are reported differently:
--
--   membership held      -> the role is an administrator. This is the
--                           regression the file is watching for, and it can
--                           come back: recreating the role through Terraform,
--                           the Neon console or the CLI re-grants it, and the
--                           grant is unrevocable afterwards (see
--                           create-app-role.sql). Anything that recreates the
--                           role must be followed by running this file.
--   role does not exist  -> the check could not be performed. Reported as a
--                           FAILURE rather than skipped, because on Neon this
--                           role always exists and its absence means this is
--                           not the database anybody thinks it is.
INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT
  'GUARANTEE',
  'pullfm_app is NOT a member of neon_superuser',
  'false',
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')
      THEN 'UNVERIFIABLE: role neon_superuser does not exist on this database'
    WHEN pg_has_role('pullfm_app', 'neon_superuser', 'MEMBER')
      THEN 'true: THE APPLICATION ROLE IS AN ADMINISTRATOR'
    ELSE 'false'
  END,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')
    AND NOT pg_has_role('pullfm_app', 'neon_superuser', 'MEMBER');

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT
  'not an admin',
  'member of ' || r,
  'false',
  pg_has_role('pullfm_app', r, 'MEMBER')::text,
  NOT pg_has_role('pullfm_app', r, 'MEMBER')
FROM unnest(ARRAY[
  'pg_read_all_data', 'pg_write_all_data',
  'pg_monitor', 'pg_signal_backend', 'pg_create_subscription',
  'pg_read_all_settings', 'neondb_owner'
]) AS t(r)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t.r);

-- Role attributes. Not inherited through membership, so these are about the
-- role itself rather than about neon_superuser.
INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT 'not an admin', a.attr, 'false', a.val::text, NOT a.val
FROM pg_roles r,
LATERAL (VALUES
  ('attribute rolsuper',       r.rolsuper),
  ('attribute rolcreatedb',    r.rolcreatedb),
  ('attribute rolcreaterole',  r.rolcreaterole),
  ('attribute rolbypassrls',   r.rolbypassrls),
  ('attribute rolreplication', r.rolreplication)
) AS a(attr, val)
WHERE r.rolname = 'pullfm_app';

-- Login is the one attribute that must be TRUE.
INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT 'can authenticate', 'attribute rolcanlogin', 'true', rolcanlogin::text, rolcanlogin
FROM pg_roles WHERE rolname = 'pullfm_app';

-- ---------------------------------------------------------------------------
-- Group 2: the role must own nothing.
--
-- This is the real proof of "cannot DROP tables and cannot ALTER schema".
-- DROP and ALTER are not privileges that can be granted; they are reserved to
-- the owner of an object (and to roles that can SET ROLE to the owner, which
-- group 1 already excluded). A role that owns nothing therefore cannot drop
-- anything, and it stays that way for as long as it has no CREATE privilege
-- anywhere to make itself an owner - which group 3 asserts.
-- ---------------------------------------------------------------------------

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT 'owns nothing', 'objects owned in pg_class', '0', c::text, c = 0
FROM (
  SELECT count(*) AS c FROM pg_class
  WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'pullfm_app')
) s;

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT 'owns nothing', 'schemas owned', '0', c::text, c = 0
FROM (
  SELECT count(*) AS c FROM pg_namespace
  WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'pullfm_app')
) s;

-- ---------------------------------------------------------------------------
-- Group 3: schema and database privileges.
-- ---------------------------------------------------------------------------

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
VALUES (
  'schema', 'CREATE on schema public', 'false',
  has_schema_privilege('pullfm_app', 'public', 'CREATE')::text,
  NOT has_schema_privilege('pullfm_app', 'public', 'CREATE')
), (
  'schema', 'USAGE on schema public', 'true',
  has_schema_privilege('pullfm_app', 'public', 'USAGE')::text,
  has_schema_privilege('pullfm_app', 'public', 'USAGE')
), (
  'database', 'CONNECT on neondb', 'true',
  has_database_privilege('pullfm_app', current_database(), 'CONNECT')::text,
  has_database_privilege('pullfm_app', current_database(), 'CONNECT')
), (
  'database', 'CREATE on neondb', 'false',
  has_database_privilege('pullfm_app', current_database(), 'CREATE')::text,
  NOT has_database_privilege('pullfm_app', current_database(), 'CREATE')
), (
  'database', 'TEMP on neondb', 'false',
  has_database_privilege('pullfm_app', current_database(), 'TEMP')::text,
  NOT has_database_privilege('pullfm_app', current_database(), 'TEMP')
);

-- pg_authid holds the password hashes of every role. Superuser-only in stock
-- Postgres; asserted because "cannot read roles" is a stated requirement and
-- pg_read_all_data membership (group 1) is not the only way it could arrive.
INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
VALUES (
  'catalogs', 'SELECT on pg_authid', 'false',
  has_table_privilege('pullfm_app', 'pg_authid', 'SELECT')::text,
  NOT has_table_privilege('pullfm_app', 'pg_authid', 'SELECT')
);

-- ---------------------------------------------------------------------------
-- Group 4: existing application tables. Every one, individually.
--
-- Aggregated as counts so that a schema which grows a table does not need this
-- file edited, and so a single missed table fails the check rather than hiding
-- inside a sampled spot check.
-- ---------------------------------------------------------------------------

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT
  'existing tables',
  'tables in public WITHOUT ' || pr.p,
  '0',
  count(*) FILTER (WHERE NOT has_table_privilege('pullfm_app', c.oid, pr.p))::text,
  count(*) FILTER (WHERE NOT has_table_privilege('pullfm_app', c.oid, pr.p)) = 0
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace,
     unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS pr(p)
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
GROUP BY pr.p;

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT
  'existing tables',
  'tables in public WITH ' || pr.p || ' (must be none)',
  '0',
  count(*) FILTER (WHERE has_table_privilege('pullfm_app', c.oid, pr.p))::text,
  count(*) FILTER (WHERE has_table_privilege('pullfm_app', c.oid, pr.p)) = 0
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace,
     unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) AS pr(p)
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
GROUP BY pr.p;

-- Views, so the cache_size_by_provider view from migration 0001 is covered.
INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT
  'existing views', 'views in public without SELECT', '0',
  count(*) FILTER (WHERE NOT has_table_privilege('pullfm_app', c.oid, 'SELECT'))::text,
  count(*) FILTER (WHERE NOT has_table_privilege('pullfm_app', c.oid, 'SELECT')) = 0
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm');

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT
  'existing sequences', 'sequences in public without USAGE', '0',
  count(*) FILTER (WHERE NOT has_sequence_privilege('pullfm_app', c.oid, 'USAGE'))::text,
  count(*) FILTER (WHERE NOT has_sequence_privilege('pullfm_app', c.oid, 'USAGE')) = 0
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S';

-- ---------------------------------------------------------------------------
-- Group 5: FUTURE tables. The check that stops the next migration breaking
-- production silently.
--
-- Two independent assertions, because they can fail apart from one another.
--
--   (a) The default-ACL catalog entry exists and is keyed on neondb_owner. This
--       is what a wrong or missing FOR ROLE clause gets wrong, and it is
--       invisible in every other view of the system.
--   (b) A table is actually created and its ACL inspected. This is the one that
--       cannot be fooled: it exercises the same code path a migration does.
-- ---------------------------------------------------------------------------

INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
SELECT
  'future tables',
  'default ACL for role neondb_owner, ' ||
    CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END,
  'grants pullfm_app',
  coalesce(array_to_string(d.defaclacl, ' '), '<missing>'),
  coalesce(array_to_string(d.defaclacl, ' ') LIKE '%pullfm_app=%', false)
FROM (VALUES ('r'::"char"), ('S'::"char")) AS t(objtype)
LEFT JOIN (
  SELECT a.defaclobjtype, a.defaclacl
  FROM pg_default_acl a
  JOIN pg_namespace n ON n.oid = a.defaclnamespace
  WHERE n.nspname = 'public'
    AND a.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'neondb_owner')
) d ON d.defaclobjtype = t.objtype;

-- The live probe. Creates a table as the owner (exactly as a migration does),
-- reads the privileges the new table was born with, then drops it. Wrapped so a
-- failure anywhere still removes the probe table.
DO $$
DECLARE
  missing text;
  extra   text;
BEGIN
  CREATE TABLE _pullfm_defacl_probe (id bigint);

  SELECT string_agg(p, ', ' ORDER BY p) INTO missing
  FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
  WHERE NOT has_table_privilege('pullfm_app', '_pullfm_defacl_probe', p);

  SELECT string_agg(p, ', ' ORDER BY p) INTO extra
  FROM unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
  WHERE has_table_privilege('pullfm_app', '_pullfm_defacl_probe', p);

  INSERT INTO _pullfm_privcheck (category, check_, expected, actual, ok)
  VALUES (
    'future tables',
    'live probe: privileges on a newly created table',
    'SELECT, INSERT, UPDATE, DELETE',
    CASE
      WHEN missing IS NOT NULL THEN 'MISSING: ' || missing
      WHEN extra IS NOT NULL THEN 'EXCESS: ' || extra
      ELSE 'SELECT, INSERT, UPDATE, DELETE'
    END,
    missing IS NULL AND extra IS NULL
  );

  DROP TABLE _pullfm_defacl_probe;
END $$;

-- ---------------------------------------------------------------------------
-- Report.
-- ---------------------------------------------------------------------------

SELECT
  CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
  category,
  check_ AS "check",
  expected,
  actual
FROM _pullfm_privcheck
ORDER BY ok, seq;

DO $$
DECLARE
  n         int;
  guarantee int;
BEGIN
  SELECT count(*) INTO n FROM _pullfm_privcheck WHERE NOT ok;
  SELECT count(*) INTO guarantee
  FROM _pullfm_privcheck WHERE NOT ok AND category = 'GUARANTEE';

  IF guarantee > 0 THEN
    RAISE EXCEPTION
      'THE neon_superuser GUARANTEE HAS FAILED, along with % other assertion(s). '
      'pullfm_app is an administrator, or it could not be proved not to be. This '
      'cannot be repaired by re-running grant-app-role.sql: the membership is '
      'unrevocable once Neon has granted it. The role must be dropped and '
      'recreated with infra/neon/sql/create-app-role.sql. Stop the application '
      'from using this credential first.', n - guarantee;
  END IF;

  IF n > 0 THEN
    RAISE EXCEPTION
      '% privilege assertion(s) failed. pullfm_app is not in the intended state; '
      'see the FAIL rows above. Do not point DATABASE_URL at it until they pass.', n;
  END IF;

  RAISE NOTICE
    'all % privilege assertions passed for pullfm_app on database %',
    (SELECT count(*) FROM _pullfm_privcheck), current_database();
END $$;
