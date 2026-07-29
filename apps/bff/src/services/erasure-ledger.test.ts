/**
 * The erasure ledger.
 *
 * Two properties are being defended and they pull in opposite directions:
 *
 *   APPEND-ONLY   a second write must never replace an existing record, because
 *                 the record is the only evidence of an erasure that survives a
 *                 Postgres restore.
 *   IDEMPOTENT    a retried deletion must be able to make progress, because the
 *                 cascade refuses to destroy anything until this succeeds.
 *
 * HEAD-before-PUT is what satisfies both, and these tests are what stop
 * somebody simplifying it away.
 */

import { describe, expect, test } from "vitest";

import type { ErasureLedgerConfig } from "../config.js";
import {
  R2ErasureLedger,
  UnconfiguredErasureLedger,
  createErasureLedger,
} from "./erasure-ledger.js";

const CONFIG: ErasureLedgerConfig = {
  endpoint: "https://acct.eu.r2.cloudflarestorage.com",
  bucket: "pull-fm-backups-staging",
  accessKeyId: "AKIAFIXTURENOTAREALKEY",
  secretAccessKey: "fixture-secret-not-a-real-credential",
  prefix: "ledger/deletions",
  timeoutMs: 1000,
};

const USER = "11111111-2222-3333-4444-555555555555";
const REQUESTED_AT = new Date("2026-07-29T10:15:00.000Z");

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

function ledgerWith(
  responder: (req: Recorded) => Response,
): { ledger: R2ErasureLedger; calls: Recorded[] } {
  const calls: Recorded[] = [];
  // Not `async`: the body never awaits, and an async arrow with no await
  // trips require-await. Returning the promise directly is equivalent.
  const fetchImpl = ((input: unknown, init: RequestInit = {}) => {
    const req: Recorded = {
      method: String(init.method),
      url: String(input),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(req);
    return responder(req);
  }) as unknown as typeof fetch;

  return {
    ledger: new R2ErasureLedger({ config: CONFIG, fetchImpl }),
    calls,
  };
}

describe("R2ErasureLedger", () => {
  test("keys the object exactly as the exporter does", () => {
    // `_ledger_key()` in infra/backup/pullfm-backup.sh. If these ever diverge
    // the inline writer and the reconciler write two objects per erasure and
    // neither one deduplicates the other.
    const { ledger } = ledgerWith(() => new Response(null, { status: 404 }));
    expect(ledger.keyFor(USER)).toBe(`ledger/deletions/${USER}.json`);
  });

  test("writes an object replay-deletions can parse", async () => {
    const { ledger, calls } = ledgerWith((req) =>
      req.method === "HEAD"
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 200 }),
    );

    await expect(
      ledger.record({ deletedUserId: USER, requestedAt: REQUESTED_AT }),
    ).resolves.toBe("inline");

    const put = calls.find((c) => c.method === "PUT");
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    // The three fields replay-deletions reads. `completed_at` is null by
    // construction: the object is written BEFORE the destructive delete, and it
    // falls back to requested_at on the replay side.
    expect(body["deleted_user_id"]).toBe(USER);
    expect(body["requested_at"]).toBe("2026-07-29T10:15:00.000Z");
    expect(body["completed_at"]).toBeNull();
    // Postgres has to accept requested_at as a timestamptz in a \copy.
    expect(new Date(body["requested_at"] as string).getTime()).toBe(
      REQUESTED_AT.getTime(),
    );
  });

  test("HEADs before it PUTs", async () => {
    const { ledger, calls } = ledgerWith((req) =>
      req.method === "HEAD"
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 200 }),
    );
    await ledger.record({ deletedUserId: USER, requestedAt: REQUESTED_AT });
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "PUT"]);
  });

  test("an existing record is left alone and reported as durable", async () => {
    // The retry path. An erasure that failed AFTER the ledger write and is
    // retried must find its own entry and proceed, not replace an immutable
    // record with a second version of itself.
    const { ledger, calls } = ledgerWith(() => new Response(null, { status: 200 }));
    await expect(
      ledger.record({ deletedUserId: USER, requestedAt: REQUESTED_AT }),
    ).resolves.toBe("already-present");
    expect(calls.map((c) => c.method)).toEqual(["HEAD"]);
  });

  test("a failed PUT throws rather than reporting durability", async () => {
    const { ledger } = ledgerWith((req) =>
      req.method === "HEAD"
        ? new Response(null, { status: 404 })
        : new Response("<Error/>", { status: 500 }),
    );
    await expect(
      ledger.record({ deletedUserId: USER, requestedAt: REQUESTED_AT }),
    ).rejects.toMatchObject({ name: "R2Error" });
  });

  test("a failed HEAD throws rather than assuming the key is absent", async () => {
    // Assuming absent on a 403 would silently convert an append-only store into
    // a last-writer-wins one.
    const { ledger } = ledgerWith(() => new Response(null, { status: 403 }));
    await expect(
      ledger.record({ deletedUserId: USER, requestedAt: REQUESTED_AT }),
    ).rejects.toMatchObject({ name: "R2Error" });
  });

  test("an unreachable object store throws", async () => {
    const fetchImpl = (() => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const ledger = new R2ErasureLedger({ config: CONFIG, fetchImpl });
    await expect(
      ledger.record({ deletedUserId: USER, requestedAt: REQUESTED_AT }),
    ).rejects.toMatchObject({ name: "R2Error" });
  });
});

describe("UnconfiguredErasureLedger", () => {
  test("reports deferred durability and never throws", async () => {
    const ledger = new UnconfiguredErasureLedger();
    expect(ledger.configured).toBe(false);
    await expect(ledger.record()).resolves.toBe("deferred-to-reconciler");
  });
});

describe("createErasureLedger", () => {
  test("returns a ledger object even with no configuration", () => {
    // Never null. A dependency that can be absent is one the cascade could
    // forget to consider, and the cascade is the only irreversible operation in
    // the API.
    const ledger = createErasureLedger(null);
    expect(ledger.configured).toBe(false);
    expect(typeof ledger.record).toBe("function");
  });

  test("returns the R2 implementation when configured", () => {
    expect(createErasureLedger(CONFIG).configured).toBe(true);
  });
});
