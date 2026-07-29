/**
 * The SigV4 signer and the two-operation S3 client.
 *
 * The signer is hand-rolled (see the header of r2.ts for why), so it is tested
 * the way a hand-rolled signer has to be: every input that MUST change the
 * signature is shown to change it, and every field of the canonical form that a
 * server recomputes is asserted independently. A signer that is wrong is not
 * subtly wrong - it fails every request - but it fails them on the account
 * deletion path, so it is worth catching here rather than in an incident.
 */

import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { R2Client, R2Error, signRequest } from "./r2.js";

const BASE = {
  endpoint: "https://acct.eu.r2.cloudflarestorage.com",
  bucket: "pull-fm-backups-staging",
  key: "ledger/deletions/11111111-2222-3333-4444-555555555555.json",
  accessKeyId: "AKIAFIXTURENOTAREALKEY",
  // Not a credential: a fixed string so the signature is reproducible.
  secretAccessKey: "fixture-secret-not-a-real-credential",
  now: new Date("2026-07-29T10:15:00.000Z"),
} as const;

describe("signRequest", () => {
  test("is deterministic for the same inputs", () => {
    const a = signRequest({ ...BASE, method: "PUT", body: "{}" });
    const b = signRequest({ ...BASE, method: "PUT", body: "{}" });
    expect(a.headers["authorization"]).toBe(b.headers["authorization"]);
  });

  test("puts the payload hash in the header the server recomputes", () => {
    const body = '{"deleted_user_id":"x"}';
    const signed = signRequest({ ...BASE, method: "PUT", body });
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update(body, "utf8").digest("hex"),
    );
  });

  test("changes when the body changes", () => {
    // The property that makes the signature a signature rather than a token.
    const a = signRequest({ ...BASE, method: "PUT", body: "{}" });
    const b = signRequest({ ...BASE, method: "PUT", body: "{ }" });
    expect(a.headers["authorization"]).not.toBe(b.headers["authorization"]);
  });

  test("changes when the key, the method, or the clock changes", () => {
    const base = signRequest({ ...BASE, method: "PUT", body: "{}" });
    const otherKey = signRequest({
      ...BASE,
      key: "ledger/deletions/other.json",
      method: "PUT",
      body: "{}",
    });
    const otherMethod = signRequest({ ...BASE, method: "HEAD", body: "" });
    const otherDay = signRequest({
      ...BASE,
      method: "PUT",
      body: "{}",
      now: new Date("2026-07-30T10:15:00.000Z"),
    });

    const signatures = new Set([
      base.headers["authorization"],
      otherKey.headers["authorization"],
      otherMethod.headers["authorization"],
      otherDay.headers["authorization"],
    ]);
    expect(signatures.size).toBe(4);
  });

  test("scopes the credential to the day, the auto region and s3", () => {
    const signed = signRequest({ ...BASE, method: "PUT", body: "{}" });
    expect(signed.headers["authorization"]).toContain(
      "Credential=AKIAFIXTURENOTAREALKEY/20260729/auto/s3/aws4_request",
    );
    expect(signed.headers["x-amz-date"]).toBe("20260729T101500Z");
  });

  test("signs exactly the headers it declares, in sorted order", () => {
    const put = signRequest({
      ...BASE,
      method: "PUT",
      body: "{}",
      contentType: "application/json",
    });
    expect(put.headers["authorization"]).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );

    const head = signRequest({ ...BASE, method: "HEAD", body: "" });
    expect(head.headers["authorization"]).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date",
    );
  });

  test("addresses the bucket path-style, keeping key separators", () => {
    // Virtual-host style would require synthesising a hostname from a
    // configured endpoint, and infra/lib/backup-common.sh documents what
    // guessing an R2 host costs: an EU-jurisdiction bucket answers NoSuchBucket
    // on the account's default host.
    const signed = signRequest({ ...BASE, method: "PUT", body: "{}" });
    expect(signed.url).toBe(
      "https://acct.eu.r2.cloudflarestorage.com/pull-fm-backups-staging/" +
        "ledger/deletions/11111111-2222-3333-4444-555555555555.json",
    );
  });

  test("percent-encodes a key character encodeURIComponent would leave alone", () => {
    // `!'()*` are the four RFC 3986 characters encodeURIComponent skips and
    // SigV4 does not. Ledger keys are UUIDs today; this keeps the signer honest
    // if the key scheme ever changes.
    const signed = signRequest({
      ...BASE,
      key: "ledger/deletions/a(b)!c.json",
      method: "PUT",
      body: "{}",
    });
    expect(signed.url).toContain("a%28b%29%21c.json");
    expect(signed.url).not.toContain("(b)");
  });
});

/** A fetch stand-in that records what it was asked to do. */
function fakeFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { impl: typeof fetch; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: String(init.method) });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(impl: typeof fetch): R2Client {
  return new R2Client({
    endpoint: BASE.endpoint,
    bucket: BASE.bucket,
    accessKeyId: BASE.accessKeyId,
    secretAccessKey: BASE.secretAccessKey,
    timeoutMs: 1000,
    fetchImpl: impl,
    now: () => BASE.now,
  });
}

describe("R2Client", () => {
  test("reads 200 as present and 404 as absent", async () => {
    const present = fakeFetch(() => new Response(null, { status: 200 }));
    const absent = fakeFetch(() => new Response(null, { status: 404 }));
    await expect(client(present.impl).exists("k")).resolves.toBe(true);
    await expect(client(absent.impl).exists("k")).resolves.toBe(false);
  });

  test("treats any other HEAD status as a failure, not as absent", async () => {
    // A 403 read as "absent" would make the ledger overwrite itself, and a 500
    // read as "absent" would make an append-only store silently mutable.
    const forbidden = fakeFetch(() => new Response(null, { status: 403 }));
    await expect(client(forbidden.impl).exists("k")).rejects.toBeInstanceOf(
      R2Error,
    );
  });

  test("sends the body on a PUT and accepts any 2xx", async () => {
    let seen: string | undefined;
    const f = fakeFetch((_url, init) => {
      seen = init.body as string;
      return new Response(null, { status: 200 });
    });
    await client(f.impl).put("k", '{"a":1}');
    expect(seen).toBe('{"a":1}');
    expect(f.calls[0]?.method).toBe("PUT");
  });

  test("throws on a non-2xx PUT, carrying the status", async () => {
    const f = fakeFetch(
      () => new Response("<Error>AccessDenied</Error>", { status: 403 }),
    );
    await expect(client(f.impl).put("k", "{}")).rejects.toMatchObject({
      name: "R2Error",
      status: 403,
    });
  });

  test("turns a transport failure into an R2Error rather than leaking it", async () => {
    // The deletion path decides what to do with this, and it must be able to
    // recognise it. A raw TypeError from fetch would be indistinguishable from
    // a bug in our own code.
    const f = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await client(f.impl)
      .put("k", "{}")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(R2Error);
    expect((err as R2Error).status).toBeNull();
  });

  test("bounds every request with a timeout signal", async () => {
    // A hung object store on the deletion path must become a fast, retryable
    // failure rather than a request that never returns.
    const f = fakeFetch((_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(null, { status: 200 });
    });
    await client(f.impl).put("k", "{}");
    expect.assertions(1);
  });

  test("truncates the error body it carries into the log", async () => {
    const f = fakeFetch(
      () => new Response("x".repeat(4096), { status: 500 }),
    );
    const err = (await client(f.impl)
      .put("k", "{}")
      .catch((e: unknown) => e)) as R2Error;
    expect(err.detail?.length).toBe(512);
  });

  test("exposes no way to delete or list", () => {
    // Structural: a credential that can erase the erasure record defeats the
    // point of keeping it outside Postgres, and this client cannot express the
    // operation even if the token could perform it.
    const c = client(fakeFetch(() => new Response(null)).impl);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(c)).sort()).toEqual(
      ["constructor", "exists", "put"],
    );
  });

  test("does not retry: the caller owns that decision", async () => {
    const f = fakeFetch(() => new Response(null, { status: 500 }));
    await client(f.impl)
      .put("k", "{}")
      .catch(() => undefined);
    expect(f.calls).toHaveLength(1);
  });
});

describe("the signer is not accidentally clock-independent", () => {
  test("a second on the same day still changes the signature", () => {
    const a = signRequest({
      ...BASE,
      method: "PUT",
      body: "{}",
      now: new Date("2026-07-29T10:15:00.000Z"),
    });
    const b = signRequest({
      ...BASE,
      method: "PUT",
      body: "{}",
      now: new Date("2026-07-29T10:15:01.000Z"),
    });
    expect(a.headers["authorization"]).not.toBe(b.headers["authorization"]);
    expect(vi.isMockFunction(signRequest)).toBe(false);
  });
});
