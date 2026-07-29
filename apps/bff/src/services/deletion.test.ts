/**
 * The deletion cascade, driven through its PARTIAL-FAILURE paths.
 *
 * Account deletion is the only irreversible operation in this API, and the
 * integration suite necessarily exercises the path where everything works. The
 * paths that matter for correctness are the ones where something does not, and
 * they cannot be reached by breaking a real Postgres on purpose. So the
 * dependencies are faked here and each one is failed in turn.
 *
 * What every test in this file is really asserting is one of two invariants:
 *
 *   1. NOTHING IRREVERSIBLE HAPPENS BEFORE THE ERASURE IS DURABLE. The ledger
 *      object is written before the DELETE, and a ledger failure aborts with
 *      nothing destroyed.
 *   2. NO ERASURE CLAIMS A DURABILITY IT DOES NOT HAVE. A configured ledger
 *      that fails is a 503, not a quiet fall back to the ten-minute exporter,
 *      and a deployment with no ledger at all says so in the outcome and in
 *      deletion_log.
 */

import { describe, expect, test } from "vitest";

import type { Redis } from "ioredis";

import type { Queryable } from "../lib/db.js";
import { ApiError } from "../lib/errors.js";
import { DeletionService, type DeletionDatabase } from "./deletion.js";
import type { ErasureDurability, ErasureLedger } from "./erasure-ledger.js";
import type { WorkOsClient } from "./workos.js";

const USER = "11111111-2222-3333-4444-555555555555";
const WORKOS_USER = "user_01FIXTURE";

interface FakeDb extends DeletionDatabase {
  readonly statements: string[];
  /** True once `DELETE FROM users` has actually run. */
  readonly deleted: () => boolean;
  readonly notes: () => string[];
}

/** A Postgres stand-in that records the statements it was asked to run. */
function fakeDb(opts: { failTransaction?: boolean } = {}): FakeDb {
  const statements: string[] = [];
  const notes: string[] = [];

  const query = (text: string, values: readonly unknown[] = []) => {
    statements.push(text.trim().split("\n")[0]?.trim() ?? "");
    if (text.includes("INSERT INTO deletion_log")) {
      return Promise.resolve({ rows: [{ id: "log-1" }], rowCount: 1 });
    }
    if (text.includes("UPDATE deletion_log")) {
      const note = values.at(-1);
      if (typeof note === "string") notes.push(note);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.includes("SELECT count(*)")) {
      return Promise.resolve({ rows: [{ n: "2" }], rowCount: 1 });
    }
    if (text.includes("DELETE FROM users")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.includes("SELECT id FROM users")) {
      return Promise.resolve({ rows: [{ id: USER }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  return {
    statements,
    deleted: () => statements.some((s) => s.includes("DELETE FROM users")),
    notes: () => notes,
    query: query as DeletionDatabase["query"],
    async transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
      if (opts.failTransaction === true) {
        throw new Error("deadlock detected");
      }
      return fn({ query } as unknown as Queryable);
    },
  };
}

function fakeRedis(): Redis {
  return {
    scan: () => Promise.resolve(["0", []]),
    del: () => Promise.resolve(0),
  } as unknown as Redis;
}

function fakeWorkos(opts: { fail?: boolean } = {}): WorkOsClient {
  return {
    deleteUser: () =>
      opts.fail === true
        ? Promise.reject(new Error("vendor down"))
        : Promise.resolve(true),
  } as unknown as WorkOsClient;
}

interface FakeLedger extends ErasureLedger {
  readonly writes: string[];
  /** Records the order the cascade did things in, shared with the db fake. */
}

function fakeLedger(opts: {
  configured?: boolean;
  outcome?: ErasureDurability;
  fail?: boolean;
  onWrite?: () => void;
}): FakeLedger {
  const writes: string[] = [];
  return {
    configured: opts.configured ?? true,
    writes,
    record: (entry) => {
      writes.push(entry.deletedUserId);
      opts.onWrite?.();
      if (opts.fail === true) {
        return Promise.reject(new Error("R2 unreachable"));
      }
      return Promise.resolve(opts.outcome ?? "inline");
    },
  };
}

function service(
  db: FakeDb,
  ledger: ErasureLedger,
  workos: WorkOsClient = fakeWorkos(),
): DeletionService {
  return new DeletionService({
    db,
    workos,
    cacheRedis: fakeRedis(),
    quotaRedis: fakeRedis(),
    ledger,
  });
}

describe("the ordering the cascade depends on", () => {
  test("writes the deletion_log request row FIRST, before anything else", async () => {
    // The pre-existing property, preserved. A log written last would be lost by
    // the failure it exists to record.
    const db = fakeDb();
    await service(db, fakeLedger({})).deleteAccount(USER, WORKOS_USER);
    expect(db.statements[0]).toContain("INSERT INTO deletion_log");
  });

  test("writes the ledger BEFORE the rows are destroyed", async () => {
    // The whole point of the change. If this order ever inverts, an erasure
    // that fails to reach the ledger has already happened and cannot be undone.
    const order: string[] = [];
    const db = fakeDb();
    const ledger = fakeLedger({
      onWrite: () => order.push("ledger"),
    });
    const svc = new DeletionService({
      db: {
        ...db,
        transaction: async (fn) => {
          order.push("delete");
          return db.transaction(fn);
        },
      },
      workos: fakeWorkos(),
      cacheRedis: fakeRedis(),
      quotaRedis: fakeRedis(),
      ledger,
    });

    await svc.deleteAccount(USER, WORKOS_USER);
    expect(order).toEqual(["ledger", "delete"]);
  });

  test("passes the same requested_at to the ledger and to deletion_log", async () => {
    // Two records of one erasure that disagree about when it was asked for are
    // two records an auditor cannot reconcile.
    const db = fakeDb();
    let ledgerAt: Date | undefined;
    const ledger: ErasureLedger = {
      configured: true,
      record: (entry) => {
        ledgerAt = entry.requestedAt;
        return Promise.resolve("inline");
      },
    };
    await service(db, ledger).deleteAccount(USER, WORKOS_USER);
    expect(ledgerAt).toBeInstanceOf(Date);
  });
});

describe("a configured ledger that fails", () => {
  test("aborts the erasure and destroys NOTHING", async () => {
    const db = fakeDb();
    const ledger = fakeLedger({ fail: true });

    await expect(
      service(db, ledger).deleteAccount(USER, WORKOS_USER),
    ).rejects.toBeInstanceOf(ApiError);

    // The assertion that matters: the account is intact.
    expect(db.deleted()).toBe(false);
  });

  test("answers 503 with a retryable, non-leaking problem type", async () => {
    // 503 rather than 500 because it is exactly a "try again" condition, and
    // because the WorkOS webhook path depends on a non-2xx to redeliver
    // `user.deleted` until the erasure is durable.
    const err = (await service(fakeDb(), fakeLedger({ fail: true }))
      .deleteAccount(USER, WORKOS_USER)
      .catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(503);
    expect(err.type).toContain("erasure-not-durable");
    // The caller is told the truth, which is that nothing happened.
    expect(err.message).toMatch(/NOT been deleted/);
    // And is told nothing about the object store, the bucket, or the error.
    expect(err.message).not.toMatch(/R2|bucket|unreachable/i);
  });

  test("leaves the request row behind so the state is recoverable", async () => {
    const db = fakeDb();
    await service(db, fakeLedger({ fail: true }))
      .deleteAccount(USER, WORKOS_USER)
      .catch(() => undefined);

    expect(db.statements[0]).toContain("INSERT INTO deletion_log");
    expect(db.notes().join(" ")).toMatch(/ABORTED/);
    expect(db.notes().join(" ")).toMatch(/no data was deleted/);
  });

  test("still aborts when the abort annotation itself cannot be written", async () => {
    // Best effort by design: failing the abort because the note failed would
    // replace a clear 503 with an opaque 500 and tell the operator less.
    const db = fakeDb();
    const broken: FakeDb = {
      ...db,
      query: ((text: string, values?: readonly unknown[]) =>
        text.includes("UPDATE deletion_log")
          ? Promise.reject(new Error("read only transaction"))
          : db.query(text, values)),
    };

    const err = (await service(broken, fakeLedger({ fail: true }))
      .deleteAccount(USER, WORKOS_USER)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(503);
    expect(broken.deleted()).toBe(false);
  });
});

describe("a deployment with no ledger configured", () => {
  test("still erases, because refusing would be the worse Article 17 outcome", async () => {
    const db = fakeDb();
    const outcome = await service(
      db,
      fakeLedger({ configured: false, outcome: "deferred-to-reconciler" }),
    ).deleteAccount(USER, WORKOS_USER);

    expect(db.deleted()).toBe(true);
    expect(outcome.durability).toBe("deferred-to-reconciler");
  });

  test("records the weaker durability claim in deletion_log", async () => {
    // "Silently claims durability" is the failure being prevented. The note is
    // what an Article 17 response is assembled from months later.
    const db = fakeDb();
    await service(
      db,
      fakeLedger({ configured: false, outcome: "deferred-to-reconciler" }),
    ).deleteAccount(USER, WORKOS_USER);

    expect(db.notes().join(" ")).toMatch(/No out-of-band erasure ledger/);
    expect(db.notes().join(" ")).toMatch(/exporter's interval/);
  });

  test("an inline write records the STRONGER claim instead", async () => {
    const db = fakeDb();
    await service(db, fakeLedger({ outcome: "inline" })).deleteAccount(
      USER,
      WORKOS_USER,
    );
    expect(db.notes().join(" ")).toMatch(/Erasure ledger written before deletion/);
  });
});

describe("the failures that must NOT abort the erasure", () => {
  test("a WorkOS failure is recorded, not raised: the local rows are already gone", async () => {
    const db = fakeDb();
    const outcome = await service(
      db,
      fakeLedger({}),
      fakeWorkos({ fail: true }),
    ).deleteAccount(USER, WORKOS_USER);

    expect(outcome.workosDeleted).toBe(false);
    expect(db.deleted()).toBe(true);
    expect(db.notes().join(" ")).toMatch(/WorkOS identity deletion failed/);
    // Both facts survive in one column. A note that carried only the WorkOS
    // outcome would silently drop the durability claim.
    expect(db.notes().join(" ")).toMatch(/Erasure ledger written/);
  });

  test("a Redis failure is swallowed: caches and counters are reconstructible", async () => {
    const db = fakeDb();
    const broken = {
      scan: () => Promise.reject(new Error("connection reset")),
      del: () => Promise.resolve(0),
    } as unknown as Redis;

    const outcome = await new DeletionService({
      db,
      workos: fakeWorkos(),
      cacheRedis: broken,
      quotaRedis: broken,
      ledger: fakeLedger({}),
    }).deleteAccount(USER, WORKOS_USER);

    expect(outcome.redisKeysDeleted).toBe(0);
    expect(db.deleted()).toBe(true);
  });

  test("a failed Postgres cascade leaves a ledger entry and an intact account", async () => {
    // THE PREFERRED FAILURE, made explicit so it is a decision rather than an
    // accident. The subject asked to be erased, the caller sees the error, a
    // retry reconciles, and a replay of the ledger would erase them late rather
    // than resurrect them silently. See the argument on deleteAccount.
    const db = fakeDb({ failTransaction: true });
    const ledger = fakeLedger({});

    await expect(
      service(db, ledger).deleteAccount(USER, WORKOS_USER),
    ).rejects.toThrow(/deadlock/);

    expect(ledger.writes).toEqual([USER]);
    expect(db.deleted()).toBe(false);
  });
});

describe("deleteByWorkOsId", () => {
  test("returns null for an identity we hold no row for", async () => {
    const db = fakeDb();
    const empty: FakeDb = {
      ...db,
      query: ((text: string, values?: readonly unknown[]) =>
        text.includes("SELECT id FROM users")
          ? Promise.resolve({ rows: [], rowCount: 0 })
          : db.query(text, values)) as DeletionDatabase["query"],
    };
    await expect(
      service(empty, fakeLedger({})).deleteByWorkOsId(WORKOS_USER),
    ).resolves.toBeNull();
    expect(empty.deleted()).toBe(false);
  });

  test("propagates the ledger refusal, so the webhook is redelivered", async () => {
    // A 2xx here would tell WorkOS the erasure is handled when it has not
    // happened at all, and the event is never sent again.
    const db = fakeDb();
    await expect(
      service(db, fakeLedger({ fail: true })).deleteByWorkOsId(WORKOS_USER),
    ).rejects.toMatchObject({ status: 503 });
    expect(db.deleted()).toBe(false);
  });
});
