#!/usr/bin/env node
/**
 * Forward migration runner.
 *
 * Deliberately small and dependency-free beyond `pg`, because this runs on the
 * deployment path: anything it needs is one more thing that can be missing at
 * 3am. `verify-migrations.mjs` is the Gate 1 harness and owns the down path and
 * the constraint assertions; this only ever moves forward.
 *
 * Properties that matter, each of which prevents a real failure:
 *
 *   - A session-level advisory lock serialises concurrent runners. Two BFF
 *     nodes deploying at once would otherwise both see zero applied migrations
 *     and both run `CREATE TABLE`.
 *   - Each migration runs inside its own transaction together with the insert
 *     into `schema_migrations`, so a crash mid-file can never record a
 *     migration that did not fully apply.
 *   - The checksum of an already-applied file is compared, so editing a
 *     migration that has shipped is a loud failure rather than a silent drift
 *     between environments.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/migrate.mjs
 *   DATABASE_URL=postgres://... node scripts/migrate.mjs --dry-run
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The migrations live one directory up in the repository (`packages/db/`) and
 * alongside this file inside the runtime image, where the flattened layout is
 * `/app/migrate.mjs` plus `/app/migrations`. Probing both beats maintaining a
 * second code path, and beats a MIGRATIONS_DIR that must be remembered on the
 * deploy path.
 */
function resolveMigrationsDir() {
  const override = process.env["MIGRATIONS_DIR"];
  if (override) return override;

  for (const candidate of [
    join(HERE, "migrations"),
    join(HERE, "..", "migrations"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no migrations directory found next to ${HERE} or its parent. ` +
      `Set MIGRATIONS_DIR to point at one.`,
  );
}

// Any 64-bit constant works; it only has to be the same in every runner.
const LOCK_KEY = 8_527_413_006_115_002n;

const DRY_RUN = process.argv.includes("--dry-run");

/** Splits a dbmate-style migration into its up and down halves. */
function upSection(text) {
  const upStart = text.indexOf("-- migrate:up");
  const downStart = text.indexOf("-- migrate:down");
  if (upStart === -1) {
    throw new Error("migration is missing a -- migrate:up marker");
  }
  return text.slice(
    upStart + "-- migrate:up".length,
    downStart === -1 ? undefined : downStart,
  );
}

async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const migrationsDir = resolveMigrationsDir();

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no migrations found in ${migrationsDir}`);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text        PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Session-level, so it is held across the per-migration transactions below
    // and released on disconnect even if this process is killed.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY.toString()]);

    const { rows } = await client.query(
      "SELECT version, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    let ran = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const text = readFileSync(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(text).digest("hex");

      const previous = applied.get(version);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `${file} has already been applied but its contents have changed. ` +
              `Ship a new migration instead of editing one that has shipped.`,
          );
        }
        continue;
      }

      if (DRY_RUN) {
        console.log(`would apply ${file}`);
        ran++;
        continue;
      }

      console.log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(upSection(text));
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [version, checksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`${file} failed: ${err.message}`);
      }
      ran++;
    }

    console.log(
      ran === 0
        ? `schema is up to date (${String(applied.size)} migrations applied)`
        : `${String(ran)} migration(s) ${DRY_RUN ? "pending" : "applied"}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`migration failed: ${err.message}`);
  process.exit(1);
});
