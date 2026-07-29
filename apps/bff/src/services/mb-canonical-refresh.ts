/**
 * The fortnightly job that keeps `mb.canonical` current.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND WHY IT IS SO THIN
 *
 * The load itself is infra/mb-loader/mb-canonical-load.sh, and it is a shell
 * script rather than TypeScript because the work is a pipeline of four processes
 * -   curl -> zstd -> tar -> psql COPY   - moving 2.3 GB of compressed archive
 * and 7.5 GB of CSV without staging either. A Node reimplementation would either
 * buffer the CSV or spawn the same four processes with extra ceremony, and it
 * would need a Postgres COPY-FROM-STDIN client this package does not have and is
 * not adding.
 *
 * What is left for this class is the part a shell script does badly:
 * MUTUAL EXCLUSION and OUTCOME CLASSIFICATION. Both are here, both are tested,
 * and neither is in the script.
 *
 * ---------------------------------------------------------------------------
 * THE LOCK IS ON A PINNED CONNECTION, AND THAT IS NOT A DETAIL
 *
 * `pg_try_advisory_lock` without the `_xact_` infix is bound to the SESSION, and
 * on a pool "the session" is whichever connection happened to serve that one
 * query. Taking it through `db.query` is doubly broken: the lock lands on an
 * arbitrary connection which is immediately returned to the pool, so the unlock
 * usually runs on a DIFFERENT connection, fails to find the lock and leaks it;
 * meanwhile a concurrent caller handed the same connection re-acquires it
 * successfully, because advisory locks are re-entrant within a session. The
 * mutual exclusion then silently does not exist while every symptom of having it
 * remains. `Database.withConnection` pins one connection for the whole run,
 * which is the only way this works.
 *
 * The transaction-scoped variant is unavailable here for the same reason it is
 * unavailable to the directory reaper: a load runs for many minutes and cannot
 * hold a transaction open under `idle_in_transaction_session_timeout`.
 *
 * `try` rather than a blocking wait, so an overlapping invocation DECLINES
 * instead of queueing behind a load that may be about to time out. A scheduled
 * job that silently piles up is how a cron becomes an outage.
 *
 * THE KEY IS DELIBERATELY NOT THE LOADER'S. The loader takes
 * `pg_advisory_xact_lock(7, hashtext('mb:canonical:swap'))` around its swap. If
 * this job held that same key for the whole run, the loader it spawned would
 * block on its own parent, forever, from a different session. Two keys in one
 * namespace, doing two different jobs: this one excludes concurrent RUNS, that
 * one excludes concurrent SWAPS.
 *
 * ---------------------------------------------------------------------------
 * FORTNIGHTLY, AND WHY RUNNING MORE OFTEN IS FREE
 *
 * MetaBrainz publish twice a month and retain exactly two dumps. The loader
 * checks `mb.load_state` for the dump it discovered and exits 0 without doing
 * anything when it is already loaded, so a daily schedule costs one directory
 * listing and one row read on the days nothing is new. Running LESS often than
 * fortnightly is the real risk: only two dumps are retained, so a job that
 * sleeps through both of them has to wait for the next publication rather than
 * catching up.
 *
 * The cadence is also a documented lie worth knowing about. MetaBrainz say "the
 * 1st and 15th"; the published directories are dated the 3rd and the 17th. The
 * loader enumerates the directory and never computes a date, which is what makes
 * the discrepancy harmless.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS REPORTED, NOT THROWN
 *
 * `run` returns an outcome; it throws only for things that stop the job existing
 * at all. That is the same shape as `DirectoryReaper.run` and it exists for the
 * same reason: a scheduler has to tell "nothing to do" from "another run holds
 * the lock" from "the loader failed" without parsing an error string.
 *
 * It also matters because of a bug class this codebase has already been bitten
 * by. `WorkOsClient.deleteUser` REPORTS failure by return value rather than
 * throwing, and an earlier draft of the reaper checked only for a thrown error
 * and therefore counted every refused deletion as a success. The equivalent here
 * is the child process: a non-zero EXIT CODE is not an exception, and code that
 * only wrapped `spawn` in try/catch would report a clean run for every failed
 * load. `#spawn` below resolves with the code and never rejects on a non-zero
 * one, so the caller is forced to look at it.
 */

import { spawn } from "node:child_process";

import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
  type Database,
  type Queryable,
} from "../lib/db.js";

/**
 * Advisory-lock key, inside the shared namespace registry in lib/db.ts.
 *
 * Registered there rather than picked as a bare constant, so two features
 * cannot silently collide on one key space.
 */
export const MB_REFRESH_LOCK_KEY = "mb:canonical:refresh";

export interface MbCanonicalRefreshOptions {
  /** Absolute path to infra/mb-loader/mb-canonical-load.sh. */
  readonly loaderPath: string;
  /**
   * The connection the loader uses.
   *
   * The DIRECT URL, not the pooled one, and that is a correctness requirement.
   * The swap takes `ACCESS EXCLUSIVE` and holds an advisory lock across several
   * statements; a transaction pooler hands the server connection to somebody
   * else at COMMIT, which breaks both. Neon's pooled endpoint is PgBouncer in
   * transaction mode, so this is not hypothetical.
   */
  readonly databaseUrl: string;
  /**
   * Ceiling on one run, in milliseconds.
   *
   * A load that has not finished by now is not going to: something upstream is
   * stalled, and a job holding an advisory lock forever prevents every later
   * run from starting. Killing it is safe by construction, because everything
   * the loader has done up to the swap lives in a staging table nobody reads.
   */
  readonly timeoutMs: number;
  /** Extra arguments, e.g. `--with-trgm` or `--max-rows`. */
  readonly extraArgs?: readonly string[];
  /** Injected in tests. Defaults to a real `spawn`. */
  readonly runner?: LoaderRunner;
}

/** What the child process did. Never throws for a non-zero exit. */
export interface LoaderResult {
  readonly code: number;
  /** True when the run was killed for exceeding `timeoutMs`. */
  readonly timedOut: boolean;
  /** Last lines of stderr, for the log. Never contains a connection string. */
  readonly tail: string;
}

export type LoaderRunner = (
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<LoaderResult>;

export interface RefreshOutcome {
  /** False when another run held the lock. NOT an error. */
  readonly ran: boolean;
  /** The loader's exit code, or null when it never started. */
  readonly code: number | null;
  readonly timedOut: boolean;
  /** The dump being served after this run, when it could be read. */
  readonly dumpId: string | null;
  readonly rowsLoaded: number | null;
  readonly tail: string;
}

const EMPTY: RefreshOutcome = {
  ran: false,
  code: null,
  timedOut: false,
  dumpId: null,
  rowsLoaded: null,
  tail: "",
};

export class MbCanonicalRefresh {
  readonly #db: Database;
  readonly #opts: MbCanonicalRefreshOptions;
  readonly #run: LoaderRunner;

  constructor(db: Database, opts: MbCanonicalRefreshOptions) {
    this.#db = db;
    this.#opts = opts;
    this.#run = opts.runner ?? defaultRunner;
  }

  /**
   * Runs one refresh, or declines because another one is in progress.
   *
   * The lock is held on ONE pinned connection for the whole run. See the header
   * for why taking it through the pool would produce a lock that excludes
   * nothing at all.
   */
  async run(): Promise<RefreshOutcome> {
    return await this.#db.withConnection(async (locked) => {
      if (
        !(await tryAdvisoryLock(
          locked,
          LOCK_NAMESPACE.mbCanonicalRefresh,
          MB_REFRESH_LOCK_KEY,
        ))
      ) {
        // Another refresh is in progress. Declining is correct behaviour, not
        // an error, so the scheduler is not paged for working as designed.
        return EMPTY;
      }

      try {
        const result = await this.#run(
          this.#opts.loaderPath,
          this.#opts.extraArgs ?? [],
          // The credential goes in the ENVIRONMENT, never in argv, where every
          // local user could read it out of `ps` for the life of the process.
          { ...process.env, DATABASE_URL_DIRECT: this.#opts.databaseUrl },
          this.#opts.timeoutMs,
        );

        // Read on the same pinned connection, after the loader has finished, so
        // what is reported is what is actually being served rather than what
        // the loader believed it published.
        const state = await this.#loadState(locked);

        return {
          ran: true,
          code: result.code,
          timedOut: result.timedOut,
          dumpId: state?.dumpId ?? null,
          rowsLoaded: state?.rowsLoaded ?? null,
          tail: result.tail,
        };
      } finally {
        // Same connection, so this actually finds the lock. Swallowed because a
        // failure to unlock must not mask the run's own result; the lock is
        // released by the session ending in the worst case.
        await advisoryUnlock(
          locked,
          LOCK_NAMESPACE.mbCanonicalRefresh,
          MB_REFRESH_LOCK_KEY,
        ).catch(() => undefined);
      }
    });
  }

  /**
   * The dump currently being served.
   *
   * Tolerates the whole schema being absent, because a database restored from a
   * backup that excluded `mb` has no `load_state` to read and that is a
   * supported state rather than a failure.
   */
  async #loadState(
    client: Queryable,
  ): Promise<{ dumpId: string; rowsLoaded: number } | null> {
    try {
      const { rows } = await client.query<{
        dump_id: string;
        rows_loaded: string | number | null;
      }>(
        `SELECT dump_id, rows_loaded
           FROM mb.load_state
          WHERE status = 'ok'
          ORDER BY finished_at DESC
          LIMIT 1`,
      );
      const row = rows[0];
      if (row === undefined) return null;
      return { dumpId: row.dump_id, rowsLoaded: Number(row.rows_loaded ?? 0) };
    } catch {
      return null;
    }
  }
}

/**
 * Spawns the loader and RESOLVES with its exit code rather than rejecting.
 *
 * The distinction is the whole reason this function is separate and named. A
 * non-zero exit is not an exception in Node, so a caller that only guarded
 * against a throw would treat every failed load as a success - which is exactly
 * the bug the directory reaper shipped with against `deleteUser`, whose failure
 * is also a return value rather than a throw.
 *
 * stderr is kept, stdout is not: the loader writes its log to stderr and reserves
 * stdout, and only the tail is retained so a 7 GB load cannot produce a 7 GB
 * buffer. The loader never prints a connection string.
 */
const TAIL_BYTES = 4096;

function defaultRunner(
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<LoaderResult> {
  return new Promise<LoaderResult>((resolve) => {
    const child = spawn(path, [...args], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let tail = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-TAIL_BYTES);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM, so the loader's own EXIT trap runs and drops its staging
      // table. SIGKILL would leave it behind for the next run to trip over.
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();

    const finish = (code: number): void => {
      clearTimeout(timer);
      resolve({ code, timedOut, tail });
    };

    // `error` fires when the binary is missing or not executable. Reported as a
    // failure code rather than a rejection, so every caller sees one shape.
    child.on("error", (err: Error) => {
      tail = `${tail}\nspawn failed: ${err.message}`.slice(-TAIL_BYTES);
      finish(1);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}

/**
 * Maps an outcome to a process exit code.
 *
 * Exported and pure so the mapping is assertable without spawning anything, and
 * so the entrypoint in scripts/ is the two lines it should be.
 *
 *   0  ran, or declined because another run held the lock
 *   1  could not run and changed nothing. THE ALERT-WORTHY CASE, because the
 *      local table goes stale until it succeeds and, with only two dumps
 *      retained upstream, a long enough outage means the dump we are behind on
 *      is no longer downloadable at all
 *   2  ran with failures, but nothing is unbounded and nothing is broken
 *
 * The loader's own exit codes use the same three meanings, so 1 MAPS STRAIGHT
 * THROUGH rather than being re-derived here. A loader that could not fetch the
 * directory listing, could not read its checksum, or found a licence it does not
 * recognise has changed nothing at all, and that is the same class of event as
 * this job failing to start.
 *
 * A TIMEOUT IS 2, NOT 1, and the distinction is deliberate. The loader was
 * killed with SIGTERM partway through, which its EXIT trap turns into a dropped
 * staging table and an untouched live table. Nothing changed and nothing is
 * broken; the previous dump is still serving. That is "look at this", not "wake
 * somebody up" - and conflating the two is how an operator learns to ignore
 * page-worthy alerts.
 */
export function refreshExitCode(outcome: RefreshOutcome): 0 | 1 | 2 {
  if (!outcome.ran) return 0;
  if (outcome.timedOut) return 2;
  if (outcome.code === 0) return 0;
  if (outcome.code === 1) return 1;
  return 2;
}
