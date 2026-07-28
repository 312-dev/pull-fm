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

  // --- 4. Cache accounting (Last.fm 100 MB licence cap) ---------------------
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
