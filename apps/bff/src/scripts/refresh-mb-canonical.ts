/**
 * Refreshes the local MusicBrainz canonical dump.
 *
 *   pnpm --filter @pull-fm/bff refresh:mb-canonical
 *
 * Run FORTNIGHTLY, or more often. MetaBrainz publish twice a month and retain
 * exactly two dumps, so running more often is nearly free (the loader exits 0
 * without doing anything when the newest dump is already loaded) and running
 * less often is the real risk: sleep through two publications and the dump you
 * are behind on is no longer downloadable.
 *
 * Why a script rather than an in-process timer, same as the other four jobs: a
 * BFF node is horizontally scaled, so an interval inside it runs once per node
 * and turns a 2.3 GB download into an N-way race. The advisory lock would make
 * that safe, but "safe because a lock catches it" is worse than not doing it -
 * the losing nodes still pay for the wiring and the behaviour changes silently
 * when the node count does.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE DOES NOT GO THROUGH `buildServices`
 *
 * Every other scheduled job is constructed in wiring.ts so the entrypoint runs
 * the same object the suites exercise. This one is not, and the reason is a
 * property of the work rather than a preference.
 *
 * The loader needs the DIRECT database URL. `buildServices` wires `DATABASE_URL`,
 * which in this deployment is Neon's pooled endpoint - PgBouncer in transaction
 * mode. The loader holds a session advisory lock across several statements and
 * takes ACCESS EXCLUSIVE inside a transaction; a transaction pooler hands the
 * server connection to somebody else at COMMIT, so both of those silently stop
 * working. packages/db/scripts/migrate.mjs is out of the bundle for exactly the
 * same reason and says so at length.
 *
 * It also builds NO Redis clients, NO WorkOS client and NO upstream provider
 * clients, none of which this job touches. A job container that opens four
 * connections it will not use is four more things that can fail at 3am.
 *
 * ---------------------------------------------------------------------------
 * EXIT CODES
 *
 *   0  the refresh ran, or declined because another run held the lock, or found
 *      that the newest published dump is already loaded
 *   1  it could not run and changed nothing. THE CASE WORTH PAGING ABOUT: the
 *      local table goes stale until it succeeds, and with only two dumps
 *      retained upstream a long enough outage means the missed dump is gone
 *   2  it ran and something needs a look. The previous data is still serving in
 *      every one of these cases, because the loader never mutates the live
 *      table - it builds a staging table and swaps in one transaction
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "../lib/db.js";
import { intFromEnv } from "../lib/job-env.js";
import { jobLogger, runJob } from "./job-env.js";
import {
  MbCanonicalRefresh,
  refreshExitCode,
} from "../services/mb-canonical-refresh.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Finds the loader.
 *
 * Probed rather than configured, and probed in both layouts, for the same
 * reason migrate.mjs probes for its migrations directory: an environment
 * variable that must be remembered on the deploy path is one more thing that is
 * missing the first time it matters. `MB_LOADER_PATH` overrides it for anyone
 * who needs to.
 */
function loaderPath(): string {
  const override = process.env["MB_LOADER_PATH"];
  if (override !== undefined && override !== "") return override;
  // src/scripts -> src -> app root -> apps/bff -> apps -> repo root
  return resolve(
    join(
      HERE,
      "..",
      "..",
      "..",
      "..",
      "infra",
      "mb-loader",
      "mb-canonical-load.sh",
    ),
  );
}

async function main(): Promise<number> {
  const log = jobLogger();

  // DIRECT, never pooled. See the header.
  const url =
    process.env["DATABASE_URL_DIRECT"] ?? process.env["DATABASE_URL"] ?? "";
  if (url === "") {
    throw new Error("DATABASE_URL_DIRECT or DATABASE_URL is required");
  }

  // A tiny pool. This process issues three queries in total and one of them
  // holds a connection for the whole run; anything larger is connections taken
  // from the API for no reason.
  const db = new Database({
    connectionString: url,
    max: 2,
    // Generous, because the last query runs after a load that may have taken an
    // hour and the connection has been idle throughout.
    statementTimeoutMs: 60_000,
  });

  const extra: string[] = [];
  // Present so an operator can cap a load in a size-limited environment without
  // editing anything. Absent by default: a partial table is refused by the
  // loader's own row floor, so this is opt-in and loud.
  const maxRows = process.env["MB_CANONICAL_MAX_ROWS"];
  if (maxRows !== undefined && maxRows !== "") {
    extra.push("--max-rows", maxRows);
  }
  if (process.env["MB_CANONICAL_WITH_TRGM"] === "true") {
    extra.push("--with-trgm");
  }

  const job = new MbCanonicalRefresh(db, {
    loaderPath: loaderPath(),
    databaseUrl: url,
    // Six hours. A full load is minutes, not hours, so this is a ceiling on a
    // stall rather than a budget: past it, something upstream has hung and the
    // advisory lock must be released for the next run.
    timeoutMs: intFromEnv("MB_CANONICAL_TIMEOUT_MS", 6 * 60 * 60 * 1000),
    extraArgs: extra,
  });

  try {
    const outcome = await job.run();
    // stdout carries the machine-readable summary and nothing else; the loader's
    // own log went to stderr as it happened.
    process.stdout.write(
      `${JSON.stringify({
        ran: outcome.ran,
        code: outcome.code,
        timedOut: outcome.timedOut,
        dumpId: outcome.dumpId,
        rowsLoaded: outcome.rowsLoaded,
      })}\n`,
    );
    if (outcome.ran && outcome.code !== 0) {
      log.error(
        { code: outcome.code, timedOut: outcome.timedOut },
        outcome.tail,
      );
    }
    return refreshExitCode(outcome);
  } finally {
    await db.close();
  }
}

runJob("the MusicBrainz canonical refresh", main);
