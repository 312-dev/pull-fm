/**
 * One scratch database per test RUN, not per test file.
 *
 * vitest runs files in parallel workers. If each file reset the database, one
 * file would drop the schema out from under another mid-assertion, and the
 * resulting failure would look like an authorization bug. Resetting once here,
 * before any worker starts, removes that entire class of confusion.
 *
 * Files can still run in parallel afterwards because every test creates its own
 * subjects and every row and cache key is namespaced by subject id, so there is
 * no shared mutable state left to collide on.
 */

import {
  assertDatabaseReachable,
  resetTestDatabase,
} from "./helpers/database.js";

export async function setup(): Promise<void> {
  await assertDatabaseReachable();
  await resetTestDatabase();
}
