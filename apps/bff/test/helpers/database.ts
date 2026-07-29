/**
 * Scratch database provisioning for the integration and security suites.
 *
 * The suites run against a REAL Postgres, not a mock, and that is not
 * negotiable for this application. Every authorization control in it is a SQL
 * predicate: `WHERE id = $1 AND user_id = $2`, `DELETE ... RETURNING`,
 * `ON CONFLICT DO NOTHING`, `ON DELETE CASCADE`. A mocked query layer would
 * assert that we called a function, which is exactly the thing that is not in
 * question. The predicate is the control, so the database has to be real.
 *
 * `docker compose -f docker-compose.dev.yml up -d` provides it locally, and CI
 * provides it as a service container.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

export const ADMIN_URL =
  process.env["ADMIN_URL"] ??
  "postgres://pullfm:pullfm_local_dev_not_a_secret@127.0.0.1:5432/postgres";

export const TEST_DB = process.env["PULLFM_TEST_DB"] ?? "pullfm_bff_test";

export function testDatabaseUrl(): string {
  return ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
}

/** Extracts the `-- migrate:up` half of a dbmate-style migration. */
function upHalf(text: string): string {
  const up = text.indexOf("-- migrate:up");
  const down = text.indexOf("-- migrate:down");
  if (up === -1 || down === -1) {
    throw new Error("migration is missing -- migrate:up / -- migrate:down");
  }
  return text.slice(up + "-- migrate:up".length, down);
}

/**
 * Drops and recreates the scratch database, then applies every migration.
 *
 * Dropped rather than truncated, so a migration that only works against an
 * existing schema is caught here rather than in production. This mirrors what
 * `packages/db/scripts/verify-migrations.mjs` does for Gate 1.
 */
export async function resetTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    // Terminate stragglers first: a leftover connection from a crashed run
    // makes DROP DATABASE hang rather than fail, which is worse.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const target = new pg.Client({ connectionString: testDatabaseUrl() });
  await target.connect();
  try {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      await target.query(
        upHalf(readFileSync(join(MIGRATIONS_DIR, file), "utf8")),
      );
    }
  } finally {
    await target.end();
  }
}

/**
 * Fails loudly rather than skipping when Postgres is unreachable.
 *
 * A security gate that quietly skips when a dependency is missing is a security
 * gate that reports green on a machine where it never ran. The message names
 * the command that fixes it.
 */
export async function assertDatabaseReachable(): Promise<void> {
  const client = new pg.Client({
    connectionString: ADMIN_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    await client.end();
  } catch (err) {
    throw new Error(
      `Postgres is not reachable at ${ADMIN_URL.replace(/:[^:@/]*@/, ":***@")}.\n` +
        "These suites test SQL-level authorization predicates and cannot be run against a mock.\n" +
        "Start the stack with:  docker compose -f docker-compose.dev.yml up -d\n" +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
