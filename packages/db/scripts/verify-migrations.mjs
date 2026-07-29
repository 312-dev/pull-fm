#!/usr/bin/env node
/**
 * Gate 1: proves migrations are reversible and that the schema's defensive
 * constraints actually fire.
 *
 * Runs against a scratch database so it can never touch real data. Two full
 * up/down cycles are executed rather than one, because a migration can be
 * reversible once and still leave residue (an orphaned type, function, or
 * extension) that breaks the second application. That failure mode only ever
 * shows up in production, during a rollback, at the worst possible moment.
 *
 * Usage:
 *   node scripts/verify-migrations.mjs
 *   ADMIN_URL=postgres://user:pw@host:5432/postgres node scripts/verify-migrations.mjs
 *
 * THREE THINGS HERE EXIST BECAUSE THIS WAS RUN AGAINST NEON ON 2026-07-29 AND
 * NOT BECAUSE THEY WERE REASONED ABOUT. Every assertion below passed on the
 * first attempt; all three failures were in the harness, and all three are
 * invisible against a local docker Postgres:
 *
 *   1. `scrub()`. execFileSync puts the ENTIRE command line into err.message,
 *      and the command line is a connection string. Locally that leaks
 *      `pullfm_local_dev_not_a_secret`, which is why nobody noticed. Against
 *      Neon it prints the production database owner's password to stdout, into
 *      CI logs and into whatever scrollback the operator is using. A harness
 *      that discloses the credential on failure is worse than no harness.
 *   2. `WITH (FORCE)` on DROP DATABASE. See dropScratch().
 *   3. `scratchUrl()` rewrites only the PATH. The previous expression
 *      (`ADMIN_URL.replace(/\/[^/]*$/, "/" + db)`) also ate the query string,
 *      so `?sslmode=require` was silently discarded. Locally there is no query
 *      string, so this was invisible; against Neon it downgraded every one of
 *      these connections from `require` to libpq's default `prefer`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");

const ADMIN_URL =
  process.env["ADMIN_URL"] ??
  "postgres://pullfm:pullfm_local_dev_not_a_secret@127.0.0.1:5432/postgres";
const SCRATCH_DB = process.env["SCRATCH_DB"] ?? "pullfm_migration_verify";

let failures = 0;

/**
 * Removes the password from anything on its way to a log. The userinfo half of
 * a postgres URI is `user:password@`, so this replaces the password of every
 * connection string in the text regardless of which one it came from.
 *
 * Applied to every message this script emits, not just the ones known to carry
 * a URL: the point is that a future edit cannot reintroduce the disclosure by
 * logging a field nobody thought about.
 */
const scrub = (s) =>
  String(s).replace(
    /(postgres(?:ql)?:\/\/[^:@/\s]+:)[^@\s]*@/gi,
    "$1<REDACTED>@",
  );

const pass = (m) => console.log(`  PASS  ${scrub(m)}`);
const fail = (m, detail) => {
  failures++;
  console.error(`  FAIL  ${scrub(m)}`);
  if (detail) console.error(`        ${scrub(detail).split("\n")[0]}`);
};

/**
 * ADMIN_URL with its database swapped, preserving the query string.
 *
 * Splitting on `?` first is the whole point: `?sslmode=require` is not part of
 * the path and must survive. Neon rejects nothing when it is dropped, it just
 * negotiates under libpq's weaker default, which is the kind of downgrade that
 * never announces itself.
 */
function scratchUrl(db) {
  const q = ADMIN_URL.indexOf("?");
  const base = q === -1 ? ADMIN_URL : ADMIN_URL.slice(0, q);
  const query = q === -1 ? "" : ADMIN_URL.slice(q);
  return `${base.replace(/\/[^/]*$/, `/${db}`)}${query}`;
}

/** Runs SQL via psql. Returns stdout, or throws with stderr attached. */
function psql(db, sql, { expectFailure = false } = {}) {
  const url = scratchUrl(db);
  try {
    const out = execFileSync(
      "psql",
      [url, "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (expectFailure)
      throw new Error(`expected failure but statement succeeded`);
    return out.trim();
  } catch (err) {
    if (expectFailure) return scrub(err.stderr ?? err.message);
    throw new Error(scrub(`${err.message}\n${String(err.stderr ?? "")}`));
  }
}

function psqlFile(db, sql) {
  const url = scratchUrl(db);
  try {
    return execFileSync(
      "psql",
      [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
      {
        encoding: "utf8",
        input: sql,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    throw new Error(scrub(`${err.message}\n${String(err.stderr ?? "")}`));
  }
}

/**
 * Drops the scratch database, terminating anything still attached to it.
 *
 * `WITH (FORCE)` is not defensive programming, it is required against Neon and
 * it took a failed run to learn that. A plain DROP DATABASE succeeds locally
 * because a docker Postgres reaps a backend the instant the client
 * disconnects. Neon does not: its proxy holds the server-side backend open
 * after psql has exited, and the backend was still there, `state=idle`,
 * `application_name=psql`, THREE MINUTES later. So the drop in the `finally`
 * block failed with
 *
 *   ERROR:  database "pullfm_migration_verify" is being accessed by other users
 *   DETAIL:  There is 1 other session using the database.
 *
 * and the scratch database survived the run, which is exactly the residue this
 * harness is supposed to guarantee it never leaves. Waiting does not fix it;
 * the session had to be terminated by hand. FORCE does that as part of the drop
 * and is a no-op locally, where there is nothing left to terminate.
 *
 * Requires Postgres 13 or newer, which both the local stack (18) and Neon (18)
 * satisfy.
 */
function dropScratch() {
  psql("postgres", `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
}

/** Splits a dbmate-style migration into its up and down halves. */
function splitMigration(text) {
  const upStart = text.indexOf("-- migrate:up");
  const downStart = text.indexOf("-- migrate:down");
  if (upStart === -1 || downStart === -1) {
    throw new Error(
      "migration must contain both -- migrate:up and -- migrate:down",
    );
  }
  return {
    up: text.slice(upStart + "-- migrate:up".length, downStart),
    down: text.slice(downStart + "-- migrate:down".length),
  };
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (files.length === 0) {
  console.error("no migrations found");
  process.exit(1);
}

const migrations = files.map((f) => ({
  name: f,
  ...splitMigration(readFileSync(join(MIGRATIONS_DIR, f), "utf8")),
}));

console.log(
  `\nGate 1: migration verification (${String(migrations.length)} migration(s))\n`,
);

// --- Setup -----------------------------------------------------------------
dropScratch();
psql("postgres", `CREATE DATABASE ${SCRATCH_DB}`);

try {
  // --- 1. Reversibility over two cycles ------------------------------------
  console.log("Reversibility");
  for (let cycle = 1; cycle <= 2; cycle++) {
    try {
      for (const m of migrations) psqlFile(SCRATCH_DB, m.up);
      pass(`cycle ${String(cycle)}: up`);
    } catch (err) {
      fail(`cycle ${String(cycle)}: up`, err.message);
      break;
    }
    try {
      for (const m of [...migrations].reverse()) psqlFile(SCRATCH_DB, m.down);
      pass(`cycle ${String(cycle)}: down`);
    } catch (err) {
      fail(`cycle ${String(cycle)}: down`, err.message);
      break;
    }
  }

  const leftover = psql(
    SCRATCH_DB,
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
  );
  if (leftover === "0") {
    pass("down leaves no tables behind");
  } else {
    fail(`down left ${leftover} table(s) behind`);
  }

  // Re-apply for the constraint checks below.
  for (const m of migrations) psqlFile(SCRATCH_DB, m.up);

  // --- 2. Deletion cascade (Gate L) ----------------------------------------
  console.log("\nAccount deletion cascade");
  psqlFile(
    SCRATCH_DB,
    `
    INSERT INTO users (workos_user_id, email) VALUES ('u_verify', 'v@example.com');
    INSERT INTO wishlist_items (user_id, artist_name, title, recording_mbid)
      SELECT id, 'Artist', 'Title', gen_random_uuid() FROM users;
    INSERT INTO user_connections (user_id, provider, provider_account_id, kek_id, wrapped_dek, access_token_ct)
      SELECT id, 'lastfm', 'acct', 'kek:v1', '\\x00', decode(repeat('ab',40),'hex') FROM users;
    INSERT INTO idempotency_keys (user_id, key, request_hash)
      SELECT id, 'k', 'h' FROM users;
  `,
  );
  psql(SCRATCH_DB, "DELETE FROM users");
  const orphans = psql(
    SCRATCH_DB,
    `SELECT (SELECT count(*) FROM wishlist_items)
          + (SELECT count(*) FROM user_connections)
          + (SELECT count(*) FROM idempotency_keys)`,
  );
  if (orphans === "0") {
    pass("deleting a user removes all dependent rows in one statement");
  } else {
    fail(`deletion left ${orphans} orphaned row(s)`);
  }

  // --- 3. Defensive constraints --------------------------------------------
  // These encode licence and security rules in the schema, so a bug fails at
  // write time rather than producing broken behaviour for users later.
  console.log("\nDefensive constraints");

  const checks = [
    {
      name: "Deezer preview without an expiry is rejected (URLs are signed)",
      sql: `INSERT INTO track_previews (recording_mbid, provider, preview_url)
            VALUES (gen_random_uuid(), 'deezer', 'https://example/x.mp3')`,
      expect: "track_previews_deezer_expiry_chk",
    },
    {
      name: "iTunes preview without an expiry is allowed (URLs are stable)",
      sql: `INSERT INTO track_previews (recording_mbid, provider, preview_url)
            VALUES (gen_random_uuid(), 'itunes', 'https://example/x.m4a')`,
      expect: null,
    },
    {
      name: "ciphertext too short to be valid GCM is rejected",
      sql: `INSERT INTO users (workos_user_id) VALUES ('u_ct');
            INSERT INTO user_connections (user_id, provider, provider_account_id, kek_id, wrapped_dek, access_token_ct)
            SELECT id, 'lastfm', 'a', 'kek:v1', '\\x00', '\\x0102' FROM users WHERE workos_user_id = 'u_ct'`,
      expect: "user_connections_ct_len_chk",
    },
    {
      name: "unknown cache provider is rejected",
      sql: `INSERT INTO upstream_cache (provider, cache_key, payload)
            VALUES ('spotify', 'k', '{}'::jsonb)`,
      expect: "upstream_cache_provider_chk",
    },
    {
      // The magic-link-only decision, enforced in the schema rather than by
      // memory. Widening this set is a migration and therefore a review; see
      // apps/bff/src/routes/v1/auth.ts for why social and passkeys are
      // deferred rather than merely unimplemented.
      name: "an auth method other than magic_auth is rejected",
      sql: `INSERT INTO users (workos_user_id, auth_method)
            VALUES ('u_social', 'social')`,
      expect: "users_auth_method_chk",
    },
    {
      // With magic-link sign-in the address IS the thing a user proves control
      // of, so two live rows sharing one would be two accounts one person can
      // sign into and cannot tell apart.
      //
      // Both values are lowercase because 0001's users_email_lower CHECK
      // already refuses anything else, so a mixed-case probe would be caught
      // one constraint earlier and would prove nothing about this index. Case
      // insensitivity is covered twice over: the column is citext and the
      // stored form is forced to lowercase.
      name: "two live accounts cannot share an email address",
      sql: `INSERT INTO users (workos_user_id, email) VALUES ('u_dupe_a', 'dupe@example.com');
            INSERT INTO users (workos_user_id, email) VALUES ('u_dupe_b', 'dupe@example.com')`,
      expect: "users_active_email_idx",
    },
    {
      // Erasure means gone, not tombstoned: a soft-deleted account must not
      // block the same person signing up again.
      name: "a soft-deleted account does not block reuse of its address",
      sql: `INSERT INTO users (workos_user_id, email, deleted_at)
              VALUES ('u_gone', 'reuse@example.com', now());
            INSERT INTO users (workos_user_id, email)
              VALUES ('u_fresh', 'reuse@example.com')`,
      expect: null,
    },
    {
      // docs/compliance/data-retention-policy.md section 8.1. The constraint is
      // the structural guarantee that a half-applied anonymization cannot
      // exist: a row carrying BOTH a real user_id and a pseudonym would hand
      // whoever reads the table the mapping the whole design exists to
      // destroy. No bug in the purge job, no interrupted batch and no hand-run
      // SQL can produce one, because the database refuses to store it.
      name: "an anonymized audit row cannot keep its user_id",
      sql: `INSERT INTO audit_log (user_id, action, outcome, anonymized_at)
            VALUES (gen_random_uuid(), 'account.deleted', 'ok', now())`,
      expect: "audit_log_identity_chk",
    },
    {
      // The other direction: a pseudonym may only exist on a row that has
      // actually been through the sweep. Otherwise a bug could mint pseudonyms
      // alongside live user ids and the correlation would be reconstructable.
      name: "a pseudonym cannot appear on a row that was never anonymized",
      sql: `INSERT INTO audit_log (action, outcome, subject_pseudonym)
            VALUES ('account.deleted', 'ok', gen_random_uuid())`,
      expect: "audit_log_identity_chk",
    },
    {
      name: "a fully anonymized audit row is accepted",
      sql: `INSERT INTO audit_log (action, outcome, anonymized_at, subject_pseudonym)
            VALUES ('account.deleted', 'ok', now(), gen_random_uuid())`,
      expect: null,
    },
    {
      // An event that never had a subject - a rejected webhook, a reaped
      // directory record - is anonymized with NO pseudonym, because there is no
      // actor to correlate and minting one would fabricate a subject rather
      // than protect one. It still carries an `ip`, so it still needs the sweep.
      name: "an anonymized audit row with no subject needs no pseudonym",
      sql: `INSERT INTO audit_log (action, outcome, anonymized_at)
            VALUES ('webhook.rejected', 'denied', now())`,
      expect: null,
    },
    {
      name: "duplicate wishlist entry for the same recording is rejected",
      sql: `INSERT INTO users (workos_user_id) VALUES ('u_dup');
            INSERT INTO wishlist_items (user_id, artist_name, title, recording_mbid)
              SELECT id, 'A', 'T', '11111111-1111-1111-1111-111111111111' FROM users WHERE workos_user_id='u_dup';
            INSERT INTO wishlist_items (user_id, artist_name, title, recording_mbid)
              SELECT id, 'A', 'T', '11111111-1111-1111-1111-111111111111' FROM users WHERE workos_user_id='u_dup'`,
      expect: "wishlist_items_user_id_recording_mbid_key",
    },
  ];

  for (const c of checks) {
    if (c.expect === null) {
      try {
        psqlFile(SCRATCH_DB, c.sql);
        pass(c.name);
      } catch (err) {
        fail(c.name, err.message);
      }
      continue;
    }
    const out = psql(SCRATCH_DB, c.sql, { expectFailure: true });
    if (out.includes(c.expect)) {
      pass(c.name);
    } else {
      fail(
        c.name,
        `expected constraint ${c.expect}, got: ${out.slice(0, 160)}`,
      );
    }
  }

  // --- 4. Audit-log retention (docs/compliance/data-retention-policy.md) ----
  //
  // Section 8 of that document asks for five assertions. Two of them are
  // schema-level and live here; the other three run the job itself and live in
  // apps/bff/test/integration/audit-retention.test.ts.
  console.log("\nAudit-log retention");

  // 8.1: the constraint EXISTS, by name, so a later migration cannot quietly
  // drop the structural guarantee while the CHECK-fires tests above keep
  // passing against nothing. The tests above prove it works; this proves it is
  // still the thing that is working.
  const constraint = psql(
    SCRATCH_DB,
    `SELECT count(*) FROM pg_constraint
      WHERE conname = 'audit_log_identity_chk'
        AND conrelid = 'audit_log'::regclass
        AND contype = 'c'`,
  );
  if (constraint === "1") {
    pass("audit_log_identity_chk is present on audit_log");
  } else {
    fail(
      "audit_log_identity_chk is missing: a half-applied anonymization is representable again",
    );
  }

  // 8.5: the standing invariant. Asserted twice, because "0" on a scratch
  // database proves nothing on its own - a query with a typo in the predicate
  // also returns 0. So: it must be 0 with only fresh rows present, and it must
  // find a seeded violation. A CI check that cannot fail is not a check.
  const invariant = `SELECT count(*) FROM audit_log
                      WHERE anonymized_at IS NULL
                        AND created_at < now() - interval '91 days'`;

  if (psql(SCRATCH_DB, invariant) === "0") {
    pass("the retention invariant holds when every row is inside the window");
  } else {
    fail("the retention invariant reported a violation on fresh rows only");
  }

  psql(
    SCRATCH_DB,
    `INSERT INTO audit_log (user_id, action, outcome, ip, created_at)
     VALUES (gen_random_uuid(), 'auth.callback', 'ok', '203.0.113.7',
             now() - interval '120 days')`,
  );
  if (psql(SCRATCH_DB, invariant) === "1") {
    pass(
      "the retention invariant detects a row past the window (query is not vacuous)",
    );
  } else {
    fail(
      "the retention invariant missed a row 120 days old and never anonymized",
    );
  }

  // --- 5. Cache accounting (Last.fm 100 MB licence cap) ---------------------
  console.log("\nLicence compliance support");
  const view = psql(
    SCRATCH_DB,
    "SELECT count(*) FROM pg_views WHERE viewname = 'cache_size_by_provider'",
  );
  if (view === "1") {
    pass("per-provider cache size is measurable (Last.fm ToS 4.3.4 cap)");
  } else {
    fail("cache_size_by_provider view is missing");
  }

  // --- 6. Server-side query ceilings (THREAT-MODEL T10) --------------------
  //
  // WHY THIS IS IN GATE 1 AND NOT ONLY IN THE NEON RUNBOOK
  //
  // `statement_timeout` is set in three places and exactly one of them takes
  // effect in a deployed environment:
  //
  //   apps/bff/src/lib/db.ts               pg.Pool option -> libpq StartupMessage
  //   infra/neon/sql/set-role-timeouts.sql ALTER ROLE      -> the role default
  //   infra/local/postgres-init/01-...     ALTER ROLE      -> the local mirror
  //
  // The first one DOES NOTHING on Neon. Measured on 2026-07-29 with the exact
  // pg.Pool configuration the application uses, `statement_timeout: 3000`,
  // against BOTH Neon endpoints: the backend reported the ROLE DEFAULT rather
  // than 3000, and `SELECT pg_sleep(6)` ran to completion. Sending it inside
  // `options` instead is not a way round it either, that is refused outright
  // ("unsupported startup parameter in options"). So the role default is the
  // whole ceiling, and it is a thing set by hand on a database rather than
  // something a deploy carries with it.
  //
  // That combination - load-bearing, applied out of band, invisible from the
  // application - is what this section exists for. Two checks, because they
  // fail for different reasons:
  //
  //   6a  the NUMBERS agree across the files that assert them. Free, and it is
  //       the regression a code change can actually cause.
  //   6b  the MECHANISM still works on this Postgres. Not free, and it is the
  //       one that would catch a server-side behaviour change nobody expected.
  //
  // What Gate 1 CANNOT prove is that the numbers are applied to the Neon
  // branches, because CI holds no database credential. That is
  // `packages/db/scripts/verify-query-ceilings.mjs`, run by an operator against
  // the pooled endpoint, and it is deliberately not faked here: a green Gate 1
  // means the configuration is coherent, NOT that production is bounded.
  console.log("\nServer-side query ceilings (T10)");

  const NEON_TIMEOUTS = join(HERE, "..", "..", "..", "infra", "neon", "sql", "set-role-timeouts.sql"); // prettier-ignore
  const LOCAL_TIMEOUTS = join(HERE, "..", "..", "..", "infra", "local", "postgres-init", "01-role-timeouts.sql"); // prettier-ignore
  const VERIFY_ROLE_SQL = join(HERE, "..", "..", "..", "infra", "neon", "sql", "verify-app-role.sql"); // prettier-ignore

  const TIMEOUT_GUCS = "statement_timeout|idle_in_transaction_session_timeout";

  /** `{ "<role>.<setting>": "<literal>" }` from every ALTER ROLE in a file. */
  const alterRoleValues = (path) => {
    const out = {};
    const re = new RegExp(
      String.raw`ALTER\s+ROLE\s+(\w+)\s+SET\s+(${TIMEOUT_GUCS})\s*=\s*'?([^';]+?)'?\s*;`,
      "gi",
    );
    for (const m of readFileSync(path, "utf8").matchAll(re)) {
      out[`${m[1]}.${m[2]}`] = m[3].trim();
    }
    return out;
  };

  const applied = alterRoleValues(NEON_TIMEOUTS);

  /**
   * The expectation table in verify-app-role.sql group 4b, which is written as
   * `('<role>', '<setting>', '<want>')` rows in a VALUES list.
   */
  const asserted = {};
  {
    const re = new RegExp(
      String.raw`\(\s*'(\w+)'\s*,\s*'(${TIMEOUT_GUCS})'\s*,\s*'([^']+)'\s*\)`,
      "gi",
    );
    for (const m of readFileSync(VERIFY_ROLE_SQL, "utf8").matchAll(re)) {
      asserted[`${m[1]}.${m[2]}`] = m[3].trim();
    }
  }

  if (Object.keys(applied).length === 0) {
    fail(
      "no ALTER ROLE ... SET statement_timeout found in infra/neon/sql/set-role-timeouts.sql",
    );
  }
  if (Object.keys(asserted).length === 0) {
    fail(
      "no query-ceiling expectations found in infra/neon/sql/verify-app-role.sql",
    );
  }

  // Compared as TEXT, not as durations, and that is not laziness.
  // verify-app-role.sql compares `split_part(cfg, '=', 2)` from
  // pg_db_role_setting to its literal with `IS NOT DISTINCT FROM`, so '30s' and
  // '30000ms' are the same ceiling and a DIFFERENT check result. Text equality
  // here is the condition that check actually needs.
  for (const key of new Set([
    ...Object.keys(applied),
    ...Object.keys(asserted),
  ])) {
    const set = applied[key];
    const want = asserted[key];
    if (set === undefined) {
      fail(
        `verify-app-role.sql asserts ${key} = '${want}' but set-role-timeouts.sql never sets it`,
      );
    } else if (want === undefined) {
      fail(
        `set-role-timeouts.sql sets ${key} = '${set}' but verify-app-role.sql never asserts it`,
      );
    } else if (set !== want) {
      fail(
        `${key}: set-role-timeouts.sql applies '${set}', verify-app-role.sql expects '${want}'`,
      );
    } else {
      pass(`${key} = '${set}' is applied and asserted consistently`);
    }
  }

  // NO CEILING MAY BE ZERO, in either file, for any role.
  //
  // Every check above is a comparison, and a comparison passes when both sides
  // are wrong in the same way. `statement_timeout = 0` is valid SQL, applies
  // cleanly, reads back correctly, and means UNBOUNDED; a change that set it to
  // 0 in set-role-timeouts.sql and 0 in verify-app-role.sql would satisfy every
  // consistency check here and every assertion there while removing the control
  // completely. This is the one assertion that is about the VALUE rather than
  // about agreement, and it is the reason the others cannot be quietly
  // neutralised.
  //
  // Postgres spells "no limit" three ways for these GUCs and all three are
  // rejected: 0, a bare 0 with a unit, and the empty string.
  const isUnbounded = (v) => /^0\s*(us|ms|s|min|h|d)?$/i.test(v.trim());
  for (const [where, table] of [
    ["set-role-timeouts.sql", applied],
    ["verify-app-role.sql", asserted],
  ]) {
    const zeroed = Object.entries(table).filter(([, v]) => isUnbounded(v));
    if (zeroed.length > 0) {
      fail(
        `${where} gives ${zeroed.map(([k]) => k).join(", ")} a ceiling of 0, which is UNBOUNDED`,
        "0 is not a large timeout, it is the absence of one. T10 has no other mitigation on Neon.",
      );
    } else {
      pass(`${where} sets no ceiling to 0 (unbounded)`);
    }
  }

  // The local mirror is a different role with a deliberately tighter number, so
  // only its PRESENCE is checked. A dev stack with no ceiling is how "it works
  // on my machine" becomes an unbounded query in production.
  const localApplied = alterRoleValues(LOCAL_TIMEOUTS);
  for (const guc of TIMEOUT_GUCS.split("|")) {
    const entries = Object.entries(localApplied).filter(([k]) =>
      k.endsWith(`.${guc}`),
    );
    if (entries.length === 0) {
      fail(
        `infra/local/postgres-init/01-role-timeouts.sql no longer sets ${guc}`,
      );
    } else if (entries.some(([, v]) => isUnbounded(v))) {
      fail(
        `infra/local/postgres-init/01-role-timeouts.sql sets ${guc} to 0 (unbounded)`,
      );
    } else {
      pass(`the local stack sets ${guc} as a non-zero role default too`);
    }
  }

  // 6b: the mechanism, exercised rather than assumed.
  //
  // `ALTER ROLE ... IN DATABASE <scratch>` and not a plain `ALTER ROLE`. The
  // scoped form touches only this harness's throwaway database, so it cannot
  // change the ceiling of the role running it - which, if someone points
  // ADMIN_URL at Neon, is neondb_owner on a real branch. DROP DATABASE removes
  // the pg_db_role_setting row with it (verified: no orphan rows survive), so
  // the existing `finally` is already the cleanup.
  //
  // Each psql() below is a fresh connection, which is the point: a role default
  // is read at session start and is invisible to the session that set it.
  const CEIL_MS = 1000;
  const IDLE_MS = 2000;
  psql(
    "postgres",
    `ALTER ROLE CURRENT_USER IN DATABASE ${SCRATCH_DB}
       SET statement_timeout = '${String(CEIL_MS)}ms'`,
  );
  psql(
    "postgres",
    `ALTER ROLE CURRENT_USER IN DATABASE ${SCRATCH_DB}
       SET idle_in_transaction_session_timeout = '${String(IDLE_MS)}ms'`,
  );

  const reported = psql(
    SCRATCH_DB,
    "SELECT setting FROM pg_settings WHERE name = 'statement_timeout'",
  );
  if (reported === String(CEIL_MS)) {
    pass("a role default is applied to a NEW session by the backend itself");
  } else {
    fail(
      `a role default of ${String(CEIL_MS)}ms was recorded but a new session reports ${reported}ms`,
    );
  }

  // The assertion that matters. A setting that reads back correctly and does
  // not fire is the failure mode this whole control is guarding against, and it
  // is indistinguishable from success by every other means.
  const slept = Date.now();
  const sleepErr = psql(SCRATCH_DB, "SELECT pg_sleep(4)", {
    expectFailure: true,
  });
  const sleptFor = Date.now() - slept;
  if (!/canceling statement due to statement timeout/i.test(sleepErr)) {
    fail(
      `pg_sleep(4) was not killed by a ${String(CEIL_MS)}ms statement_timeout`,
      sleepErr,
    );
  } else if (sleptFor > 3000) {
    fail(
      `the statement was cancelled but only after ${String(sleptFor)}ms, so the ${String(CEIL_MS)}ms ceiling is not what stopped it`,
    );
  } else {
    pass(
      `a statement exceeding the role default is CANCELLED (after ${String(sleptFor)}ms)`,
    );
  }

  // `\! sleep` and not pg_sleep: idle_in_transaction_session_timeout only fires
  // while the session is idle AND inside a transaction, so the wait has to
  // happen on the client side. pg_sleep inside a transaction is a running
  // statement and would be caught by the check above instead.
  let idleOut;
  try {
    psqlFile(
      SCRATCH_DB,
      `BEGIN;\nSELECT 1;\n\\! sleep ${String(IDLE_MS / 1000 + 2)}\nSELECT 'STILL ALIVE';\n`,
    );
    idleOut = "STILL ALIVE";
  } catch (err) {
    idleOut = err.message;
  }
  if (/idle[- ]in[- ]transaction timeout/i.test(idleOut)) {
    pass("a session left idle inside a transaction is TERMINATED");
  } else {
    fail(
      "a session sat idle inside a transaction past the ceiling and survived",
      idleOut,
    );
  }
} finally {
  dropScratch();
}

console.log(
  failures === 0
    ? "\nGate 1 migration checks: PASS\n"
    : `\nGate 1 migration checks: FAIL (${String(failures)} failure(s))\n`,
);
process.exit(failures === 0 ? 0 : 1);
