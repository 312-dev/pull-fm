/**
 * The refresh job, tested for the two things it actually owns.
 *
 * The load is a shell script and is proven by infra/mb-loader/selftest.sh
 * against a real Postgres. What is asserted here is the part written in
 * TypeScript, and both halves of it are places this codebase has been bitten
 * before:
 *
 *   1. MUTUAL EXCLUSION on a PINNED connection. A session advisory lock taken
 *      through the pool excludes nothing while looking exactly like it does, so
 *      the test proves the lock and the unlock ran on the SAME client object.
 *   2. FAILURE REPORTED BY RETURN VALUE. A non-zero exit code is not an
 *      exception, so a job that only guarded against a throw would report every
 *      failed load as a success - the same shape as the `deleteUser` bug the
 *      directory reaper shipped with.
 */

import { describe, expect, it, vi } from "vitest";

import type { Database } from "../lib/db.js";
import {
  MbCanonicalRefresh,
  refreshExitCode,
  type LoaderResult,
  type RefreshOutcome,
} from "./mb-canonical-refresh.js";

interface Query {
  readonly client: object;
  readonly sql: string;
}

/**
 * A `Database` that hands out DISTINCT client objects per `withConnection`.
 *
 * Distinct on purpose: it is what lets a test assert that the lock and the
 * unlock landed on one connection, which is the property the pool silently
 * destroys and the entire reason `withConnection` exists.
 */
class FakeDb {
  readonly queries: Query[] = [];
  readonly clients: object[] = [];
  lockGranted = true;
  loadStateRows: unknown[] = [];
  #connections = 0;

  async withConnection<T>(fn: (c: never) => Promise<T>): Promise<T> {
    this.#connections += 1;
    const client = {
      id: this.#connections,
      query: (sql: string): Promise<{ rows: unknown[] }> => {
        this.queries.push({ client, sql });
        if (sql.includes("pg_try_advisory_lock")) {
          return Promise.resolve({ rows: [{ acquired: this.lockGranted }] });
        }
        if (sql.includes("mb.load_state")) {
          return Promise.resolve({ rows: this.loadStateRows });
        }
        return Promise.resolve({ rows: [] });
      },
    };
    this.clients.push(client);
    return await fn(client as never);
  }

  sqlOn(client: object): string[] {
    return this.queries.filter((q) => q.client === client).map((q) => q.sql);
  }
}

function make(
  db: FakeDb,
  result: LoaderResult,
  args: readonly string[] = [],
): { job: MbCanonicalRefresh; runner: ReturnType<typeof vi.fn> } {
  const runner = vi.fn().mockResolvedValue(result);
  const job = new MbCanonicalRefresh(db as unknown as Database, {
    loaderPath: "/opt/pullfm/mb-canonical-load.sh",
    databaseUrl: "postgres://u:p@direct.example/db",
    timeoutMs: 1000,
    extraArgs: args,
    runner: runner as never,
  });
  return { job, runner };
}

const OK: LoaderResult = { code: 0, timedOut: false, tail: "" };

describe("mutual exclusion", () => {
  it("takes and releases the lock on ONE pinned connection", async () => {
    const db = new FakeDb();
    const { job } = make(db, OK);

    await job.run();

    // One connection for the whole run. Two would mean the unlock could not
    // find the lock, which is the failure this design exists to prevent.
    expect(db.clients).toHaveLength(1);
    const first = db.clients[0];
    if (first === undefined) throw new Error("no connection was taken");
    const sql = db.sqlOn(first);
    expect(sql[0]).toContain("pg_try_advisory_lock");
    expect(sql[sql.length - 1]).toContain("pg_advisory_unlock");
  });

  it("uses `try` rather than a blocking wait", async () => {
    const db = new FakeDb();
    const { job } = make(db, OK);
    await job.run();
    // `pg_advisory_lock` would queue a second scheduled invocation behind a run
    // that may be about to time out, which is how a cron becomes an outage.
    expect(db.queries[0]?.sql).toContain("pg_try_advisory_lock");
    expect(db.queries[0]?.sql).not.toMatch(/SELECT pg_advisory_lock\(/);
  });

  it("DECLINES rather than failing when another run holds the lock", async () => {
    const db = new FakeDb();
    db.lockGranted = false;
    const { job, runner } = make(db, OK);

    const outcome = await job.run();

    expect(outcome.ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    // Declining is designed behaviour, so it must not page anybody.
    expect(refreshExitCode(outcome)).toBe(0);
  });

  it("releases the lock even when the loader throws", async () => {
    const db = new FakeDb();
    const runner = vi.fn().mockRejectedValue(new Error("spawn exploded"));
    const job = new MbCanonicalRefresh(db as unknown as Database, {
      loaderPath: "/x",
      databaseUrl: "postgres://u:p@h/d",
      timeoutMs: 10,
      runner: runner as never,
    });

    await expect(job.run()).rejects.toThrow("spawn exploded");
    // A leaked advisory lock would block every later run until the session dies.
    expect(db.queries.some((q) => q.sql.includes("pg_advisory_unlock"))).toBe(
      true,
    );
  });

  it("does not let a failed unlock mask the run's own result", async () => {
    const db = new FakeDb();
    const original = db.withConnection.bind(db);
    db.withConnection = async <T>(fn: (c: never) => Promise<T>): Promise<T> =>
      await original(async (client: never) => {
        const c = client as unknown as { query: (s: string) => unknown };
        const inner = c.query.bind(c);
        c.query = (sql: string): unknown => {
          if (sql.includes("pg_advisory_unlock")) {
            return Promise.reject(new Error("connection gone"));
          }
          return inner(sql);
        };
        return await fn(client);
      });

    const { job } = make(db, OK);
    await expect(job.run()).resolves.toMatchObject({ ran: true, code: 0 });
  });
});

describe("the loader reports failure by RETURN VALUE, not by throwing", () => {
  it("surfaces a non-zero exit rather than reporting a clean run", async () => {
    const db = new FakeDb();
    const { job } = make(db, {
      code: 1,
      timedOut: false,
      tail: "FATAL: could not fetch the published sha256",
    });

    const outcome = await job.run();

    expect(outcome.ran).toBe(true);
    expect(outcome.code).toBe(1);
    expect(outcome.tail).toContain("sha256");
  });

  it("passes the credential in the ENVIRONMENT and never in argv", async () => {
    const db = new FakeDb();
    const { job, runner } = make(db, OK, ["--with-trgm"]);

    await job.run();

    const [path, args, env] = runner.mock.calls[0] as [
      string,
      string[],
      NodeJS.ProcessEnv,
    ];
    expect(path).toBe("/opt/pullfm/mb-canonical-load.sh");
    expect(args).toEqual(["--with-trgm"]);
    expect(env["DATABASE_URL_DIRECT"]).toBe("postgres://u:p@direct.example/db");
    // argv is readable from `ps` by every local user, for the whole life of a
    // process that may run for an hour.
    expect(args.join(" ")).not.toContain("postgres://");
  });

  it("reports what is actually being served, read after the loader finished", async () => {
    const db = new FakeDb();
    db.loadStateRows = [
      {
        dump_id: "musicbrainz-canonical-dump-20260717-080003",
        rows_loaded: "33000000",
      },
    ];
    const { job } = make(db, OK);

    const outcome = await job.run();

    expect(outcome.dumpId).toBe("musicbrainz-canonical-dump-20260717-080003");
    expect(outcome.rowsLoaded).toBe(33_000_000);
  });

  it("tolerates the mb schema being absent entirely", async () => {
    // What a database restored from a backup that excluded `mb` looks like.
    const db = new FakeDb();
    const original = db.withConnection.bind(db);
    db.withConnection = async <T>(fn: (c: never) => Promise<T>): Promise<T> =>
      await original(async (client: never) => {
        const c = client as unknown as { query: (s: string) => unknown };
        const inner = c.query.bind(c);
        c.query = (sql: string): unknown =>
          sql.includes("mb.load_state")
            ? Promise.reject(
                new Error('relation "mb.load_state" does not exist'),
              )
            : inner(sql);
        return await fn(client);
      });

    const { job } = make(db, OK);
    await expect(job.run()).resolves.toMatchObject({ ran: true, dumpId: null });
  });
});

describe("refreshExitCode", () => {
  const outcome = (over: Partial<RefreshOutcome>): RefreshOutcome => ({
    ran: true,
    code: 0,
    timedOut: false,
    dumpId: null,
    rowsLoaded: null,
    tail: "",
    ...over,
  });

  it("0 when it ran cleanly", () => {
    expect(refreshExitCode(outcome({}))).toBe(0);
  });

  it("0 when it declined because another run held the lock", () => {
    expect(refreshExitCode(outcome({ ran: false, code: null }))).toBe(0);
  });

  it("1 when the loader could not run and changed nothing", () => {
    // Straight through from the loader, which uses the same three meanings. A
    // stale local table is the alert-worthy case because only two dumps are
    // retained upstream.
    expect(refreshExitCode(outcome({ code: 1 }))).toBe(1);
  });

  it("2 for a timeout, because nothing changed and nothing is broken", () => {
    // SIGTERM runs the loader's EXIT trap, which drops the staging table. The
    // live table was never touched. Paging for this teaches an operator to
    // ignore the code that does mean something.
    expect(refreshExitCode(outcome({ code: 143, timedOut: true }))).toBe(2);
  });

  it("2 for any other non-zero exit", () => {
    expect(refreshExitCode(outcome({ code: 2 }))).toBe(2);
    expect(refreshExitCode(outcome({ code: 137 }))).toBe(2);
  });
});
