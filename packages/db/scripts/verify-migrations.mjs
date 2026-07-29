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
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, detail) => {
  failures++;
  console.error(`  FAIL  ${m}`);
  if (detail) console.error(`        ${String(detail).split("\n")[0]}`);
};

/** Runs SQL via psql. Returns stdout, or throws with stderr attached. */
function psql(db, sql, { expectFailure = false } = {}) {
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${db}`);
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
    if (expectFailure) return String(err.stderr ?? err.message);
    throw new Error(`${err.message}\n${String(err.stderr ?? "")}`);
  }
}

function psqlFile(db, sql) {
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${db}`);
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
psql("postgres", `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
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
} finally {
  psql("postgres", `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
}

console.log(
  failures === 0
    ? "\nGate 1 migration checks: PASS\n"
    : `\nGate 1 migration checks: FAIL (${String(failures)} failure(s))\n`,
);
process.exit(failures === 0 ? 0 : 1);
