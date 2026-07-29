/**
 * The platform surface: identity, erasure, portability, wishlist, webhooks.
 *
 * Gate L asks for `DELETE /me` and `GET /me/export` "verified end to end
 * including cascade to WorkOS, Redis, and logs" plus "a documented backup
 * retention position for deleted data". The first three are asserted here; the
 * fourth is prose, and its home is docs/api/deletion-and-backups.md and the
 * header comment of src/services/deletion.ts.
 */

import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  buildTestApp,
  FIXTURE_SESSION_KEY,
  type TestApp,
} from "../helpers/app.js";
import {
  provisionSubject,
  seedFixtures,
  type Subject,
} from "../helpers/subjects.js";
import { jsonOf } from "../helpers/json.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const auth = (s: Subject) => ({ authorization: `Bearer ${s.token}` });

describe("GET /v1/config", () => {
  test("is public and discloses nothing operational", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/v1/config" });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<Record<string, unknown>>(res);
    expect(Object.keys(body).sort()).toEqual([
      "features",
      "maintenance",
      "minSupportedBuild",
      "providers",
    ]);
    // A reconnaissance endpoint by nature (API9), so it must not name internal
    // hosts, versions, or which providers hold credentials.
    expect(res.body).not.toMatch(/127\.0\.0\.1|postgres|redis|sk_/i);
  });
});

describe("wishlist", () => {
  test("pages with a keyset cursor and terminates", async () => {
    const s = await provisionSubject(ctx, "wl");
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/v1/wishlist",
        headers: { ...auth(s), "idempotency-key": randomUUID() },
        payload: {
          artistName: `A${String(i)}`,
          title: `T${String(i)}`,
          recordingMbid: randomUUID(),
        },
      });
      created.push(jsonOf<{ id: string }>(res).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url: string =
        cursor === null
          ? "/v1/wishlist?limit=2"
          : `/v1/wishlist?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await ctx.app.inject({
        method: "GET",
        url,
        headers: auth(s),
      });
      expect(res.statusCode).toBe(200);
      const body = jsonOf<{
        items: { id: string }[];
        cursor: string | null;
      }>(res);
      seen.push(...body.items.map((i) => i.id));
      cursor = body.cursor;
      if (cursor === null) break;
    }

    // Every row exactly once: no skips, no repeats, which is the property a
    // naive OFFSET or a timestamp-only cursor gets wrong.
    expect(seen.sort()).toEqual([...created].sort());
    expect(new Set(seen).size).toBe(created.length);
  });

  test("a retried write with the same key returns the original response", async () => {
    const s = await provisionSubject(ctx, "wl");
    const key = randomUUID();
    const payload = {
      artistName: "Retry",
      title: "Retry",
      recordingMbid: randomUUID(),
    };

    const first = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: { ...auth(s), "idempotency-key": key },
      payload,
    });
    const second = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: { ...auth(s), "idempotency-key": key },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    const list = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist?limit=100",
      headers: auth(s),
    });
    expect(jsonOf<{ items: unknown[] }>(list).items).toHaveLength(1);
  });

  test("the same key with a different body is a 409", async () => {
    const s = await provisionSubject(ctx, "wl");
    const key = randomUUID();
    await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: { ...auth(s), "idempotency-key": key },
      payload: { artistName: "One", title: "One", recordingMbid: randomUUID() },
    });
    const conflict = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: { ...auth(s), "idempotency-key": key },
      payload: { artistName: "Two", title: "Two", recordingMbid: randomUUID() },
    });
    expect(conflict.statusCode).toBe(409);
  });

  test("the Idempotency-Key header is mandatory", async () => {
    const s = await provisionSubject(ctx, "wl");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: auth(s),
      payload: { artistName: "No Key", title: "No Key" },
    });
    expect(res.statusCode).toBe(400);
  });

  test("acquire links carry no affiliate parameters", async () => {
    // docs/PLAN.md section 1a: an affiliate tag would retroactively breach the
    // Last.fm, Deezer, and Apple terms simultaneously. Enforced by a test as
    // well as by a lint rule, because this one is worth catching twice.
    const s = await provisionSubject(ctx, "wl");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/wishlist",
      headers: { ...auth(s), "idempotency-key": randomUUID() },
      payload: {
        artistName: "Buy",
        title: "Me",
        recordingMbid: randomUUID(),
      },
    });
    const id = jsonOf<{ id: string }>(created).id;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/wishlist/${id}/acquire`,
      headers: auth(s),
    });
    expect(res.statusCode).toBe(200);
    const { links } = jsonOf<{ links: { url: string }[] }>(res);
    expect(links.length).toBeGreaterThan(0);
    for (const { url } of links) {
      expect(url).not.toMatch(
        /\b(tag|aff|affiliate|partner|at|ref|referrer|utm_source|linkCode|irclickid|clickid)=/i,
      );
    }
  });

  test("an unknown wishlist id is 404 with a problem document", async () => {
    const s = await provisionSubject(ctx, "wl");
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/wishlist/${randomUUID()}`,
      headers: auth(s),
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  test("a non-UUID id is rejected before any query runs", async () => {
    const s = await provisionSubject(ctx, "wl");
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/wishlist/not-a-uuid",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/me/export (GDPR Article 20)", () => {
  test("returns a ticket, not the document", async () => {
    const s = await provisionSubject(ctx, "exp");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/export",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(202);
    const body = jsonOf<{ downloadUrl: string; excludes: string[] }>(res);
    expect(body.downloadUrl).toContain("/v1/me/export/download?token=");
    expect(body.excludes.length).toBeGreaterThan(0);
  });

  test("the ticket is single-use", async () => {
    const s = await provisionSubject(ctx, "exp");
    const fixtures = await seedFixtures(ctx, s);
    const url = `/v1/me/export/download?token=${encodeURIComponent(fixtures.exportTicket)}`;

    expect(
      (await ctx.app.inject({ method: "GET", url, headers: auth(s) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: "GET", url, headers: auth(s) }))
        .statusCode,
    ).toBe(400);
  });

  test("EXCLUDES decrypted third-party credentials", async () => {
    // Portability does not require handing back a bearer secret for someone
    // else's system that the user can regenerate at the source in a minute.
    // Including it would turn a stolen session into a third-party account
    // compromise (AT-1 branch 2a).
    const s = await provisionSubject(ctx, "exp");
    const fixtures = await seedFixtures(ctx, s);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/me/export/download?token=${encodeURIComponent(fixtures.exportTicket)}`,
      headers: auth(s),
    });
    expect(res.statusCode).toBe(200);

    // The mock provider's credential, the API token secret, and every piece of
    // envelope material must be absent.
    expect(res.body).not.toContain(FIXTURE_SESSION_KEY);
    expect(res.body).not.toContain(fixtures.apiTokenSecret);
    for (const forbidden of [
      "access_token",
      "refresh_token",
      "session_key",
      "token_hash",
      "wrapped_dek",
      "kek_id",
      "access_token_ct",
    ]) {
      expect(res.body, `${forbidden} appeared in the export`).not.toContain(
        forbidden,
      );
    }

    // But the export is still complete as a record: connection metadata and
    // token metadata are present.
    const doc = jsonOf<{
      connections: { provider: string }[];
      wishlist: unknown[];
      apiTokens: unknown[];
      notice: string;
    }>(res);
    expect(doc.connections.length).toBeGreaterThan(0);
    expect(doc.wishlist.length).toBeGreaterThan(0);
    expect(doc.apiTokens.length).toBeGreaterThan(0);
    expect(doc.notice).toContain("regenerated");

    expect(res.headers["cache-control"]).toContain("no-store");
  });

  test("is throttled per subject", async () => {
    // Unthrottled, a loop over this route is an authenticated self-service
    // denial of service on the database that the per-IP edge limit never sees.
    const s = await provisionSubject(ctx, "exp");
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/v1/me/export",
          headers: auth(s),
        })
      ).statusCode,
    ).toBe(202);
    const second = await ctx.app.inject({
      method: "GET",
      url: "/v1/me/export",
      headers: auth(s),
    });
    expect(second.statusCode).toBe(429);
  });
});

describe("DELETE /v1/me", () => {
  test("requires the account email as confirmation", async () => {
    const s = await provisionSubject(ctx, "del");
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: auth(s),
      payload: { confirm: "someone.else@example.test" },
    });
    expect(res.statusCode).toBe(422);
  });

  test("requires a recently issued session (M16)", async () => {
    const s = await provisionSubject(ctx, "del");
    const stale = await ctx.idp.mint(s.workosUserId, {
      issuedAtOffsetSeconds: -(ctx.cfg.DELETE_FRESH_AUTH_MAX_AGE_S + 600),
    });
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: { authorization: `Bearer ${stale}` },
      payload: { confirm: s.email },
    });
    expect(res.statusCode).toBe(403);
  });

  test("cascades through Postgres, WorkOS, and Redis", async () => {
    const s = await provisionSubject(ctx, "del");
    await seedFixtures(ctx, s);

    // Something in each store, so the cascade has work to do.
    await ctx.services.cacheRedis.set(`u:${s.id}:feed`, "cached");
    await ctx.services.quotaRedis.set(`quota:user:${s.id}:search`, "7");

    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: auth(s),
      payload: { confirm: s.email },
    });
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      deleted: boolean;
      identityProviderDeleted: boolean;
      backupRetentionNotice: string;
    }>(res);
    expect(body.deleted).toBe(true);
    expect(body.identityProviderDeleted).toBe(true);
    // Gate L asks for a documented position on backups; the client is told it
    // rather than having to find it in a policy document.
    expect(body.backupRetentionNotice).toMatch(/backup/i);

    // Postgres: every user-owned table, in one transaction, by ON DELETE
    // CASCADE rather than an application sweep that can partially fail.
    for (const table of [
      "users",
      "user_connections",
      "wishlist_items",
      "api_tokens",
      "connect_states",
      "idempotency_keys",
    ]) {
      const { rows } = await ctx.services.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE ${table === "users" ? "id" : "user_id"} = $1`,
        [s.id],
      );
      expect(rows[0]?.n, `${table} still holds rows`).toBe("0");
    }

    // Redis, both instances.
    expect(await ctx.services.cacheRedis.exists(`u:${s.id}:feed`)).toBe(0);
    expect(
      await ctx.services.quotaRedis.exists(`quota:user:${s.id}:search`),
    ).toBe(0);

    // The deletion log survives, holds no personal data beyond the id, and is
    // the replay list that makes the deletion durable across a restore.
    const { rows: log } = await ctx.services.db.query<{
      completed_at: Date | null;
      workos_deleted: boolean;
      rows_deleted: Record<string, number>;
    }>(
      `SELECT completed_at, workos_deleted, rows_deleted FROM deletion_log
        WHERE deleted_user_id = $1`,
      [s.id],
    );
    expect(log).toHaveLength(1);
    expect(log[0]?.completed_at).not.toBeNull();
    expect(log[0]?.workos_deleted).toBe(true);
    expect(log[0]?.rows_deleted["users"]).toBe(1);

    // The session is dead afterwards.
    const after = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: auth(s),
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("POST /v1/webhooks/workos", () => {
  const send = (body: unknown, header?: string) =>
    ctx.app.inject({
      method: "POST",
      url: "/v1/webhooks/workos",
      headers: {
        "content-type": "application/json",
        ...(header === undefined ? {} : { "workos-signature": header }),
      },
      payload: JSON.stringify(body),
    });

  const signFor = (body: unknown): { raw: string; header: string } => {
    const raw = JSON.stringify(body);
    const t = Date.now();
    const mac = createHmac("sha256", ctx.webhookSecret)
      .update(`${String(t)}.${raw}`, "utf8")
      .digest("hex");
    return { raw, header: `t=${String(t)}, v1=${mac}` };
  };

  test("an unsigned delivery is refused and deletes nothing", async () => {
    // Without verification this route is an unauthenticated mass-deletion
    // endpoint published in the public API surface (T20).
    const s = await provisionSubject(ctx, "hook");
    const res = await send({
      event: "user.deleted",
      data: { id: s.workosUserId },
    });
    expect(res.statusCode).toBe(401);

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users WHERE id = $1`,
      [s.id],
    );
    expect(rows[0]?.n).toBe("1");
  });

  test("a forged signature is refused and deletes nothing", async () => {
    const s = await provisionSubject(ctx, "hook");
    const body = { event: "user.deleted", data: { id: s.workosUserId } };
    const t = Date.now();
    const forged = createHmac("sha256", "wrong-secret")
      .update(`${String(t)}.${JSON.stringify(body)}`, "utf8")
      .digest("hex");
    const res = await send(body, `t=${String(t)}, v1=${forged}`);
    expect(res.statusCode).toBe(401);

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users WHERE id = $1`,
      [s.id],
    );
    expect(rows[0]?.n).toBe("1");
  });

  test("a replayed delivery outside the window is refused", async () => {
    const s = await provisionSubject(ctx, "hook");
    const body = { event: "user.deleted", data: { id: s.workosUserId } };
    const raw = JSON.stringify(body);
    const stale = Date.now() - 6 * 60 * 1000;
    const mac = createHmac("sha256", ctx.webhookSecret)
      .update(`${String(stale)}.${raw}`, "utf8")
      .digest("hex");
    const res = await send(body, `t=${String(stale)}, v1=${mac}`);
    expect(res.statusCode).toBe(401);
  });

  test("a correctly signed user.deleted cascades", async () => {
    const s = await provisionSubject(ctx, "hook");
    await seedFixtures(ctx, s);
    const body = { event: "user.deleted", data: { id: s.workosUserId } };
    const { header } = signFor(body);

    const res = await send(body, header);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, handled: true });

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users WHERE id = $1`,
      [s.id],
    );
    expect(rows[0]?.n).toBe("0");
  });

  test("a verified but unhandled event still answers 200", async () => {
    // A provider retries non-2xx, and retrying an event we deliberately ignore
    // is a queue that never drains.
    const body = { event: "user.updated", data: { id: "user_whatever" } };
    const { header } = signFor(body);
    const res = await send(body, header);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, handled: false });
  });

  test("a rejected delivery is recorded in the audit trail", async () => {
    await send({ event: "user.deleted", data: { id: "user_x" } });
    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'webhook.rejected' AND outcome = 'denied'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });
});

describe("problem documents", () => {
  test("every error is RFC 9457 and carries a request id", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const body = jsonOf<Record<string, unknown>>(res);
    expect(body["type"]).toMatch(/^https:\/\/pull\.fm\/problems\//);
    expect(body["status"]).toBe(401);
    expect(body["instance"]).toBe(res.headers["x-request-id"]);
  });

  test("an unhandled error never echoes its message", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});
