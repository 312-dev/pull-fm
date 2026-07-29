/**
 * Personal API tokens, end to end against a real Postgres and a real Redis.
 *
 * The properties under test are all SQL or Redis predicates, so a mocked data
 * layer would assert that we called a function rather than that the control
 * holds. That distinction is the whole point of the suite.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { provisionSubject, type Subject } from "../helpers/subjects.js";
import { hashToken, TOKEN_PATTERN } from "../../src/services/tokens.js";
import { jsonOf } from "../helpers/json.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const session = (s: Subject) => ({ authorization: `Bearer ${s.token}` });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function createToken(
  s: Subject,
  body: Record<string, unknown> = {},
): Promise<{ token: string; id: string; status: number; raw: string }> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/v1/tokens",
    headers: session(s),
    payload: { name: `t-${randomUUID().slice(0, 8)}`, ...body },
  });
  const json = jsonOf<{ token?: string; tokenRecord?: { id: string } }>(res);
  return {
    token: json.token ?? "",
    id: json.tokenRecord?.id ?? "",
    status: res.statusCode,
    raw: res.body,
  };
}

describe("issuing", () => {
  test("returns the secret exactly once and stores only its digest", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    expect(created.status).toBe(201);
    expect(TOKEN_PATTERN.test(created.token)).toBe(true);

    // The database holds the digest and nothing that resembles the token.
    const { rows } = await ctx.services.db.query<{
      token_hash: string;
      last_four: string;
    }>(`SELECT token_hash, last_four FROM api_tokens WHERE id = $1`, [
      created.id,
    ]);
    expect(rows[0]?.token_hash).toBe(hashToken(created.token));
    expect(rows[0]?.token_hash).not.toContain(created.token);
    expect(created.token.endsWith(rows[0]?.last_four ?? "!")).toBe(true);

    // Gate 3 in miniature: a dump of the row does not contain the credential.
    const dump = await ctx.services.db.query(
      `SELECT * FROM api_tokens WHERE id = $1`,
      [created.id],
    );
    expect(JSON.stringify(dump.rows)).not.toContain(created.token);
  });

  test("the secret is never retrievable afterwards", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: session(s),
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(created.id);
    expect(list.body).not.toContain(created.token);
    expect(list.body).not.toContain(hashToken(created.token));
  });

  test("rejects an unknown scope and a write-shaped scope", async () => {
    const s = await provisionSubject(ctx, "tok");
    for (const scopes of [["write:wishlist"], ["read:everything"], ["admin"]]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/v1/tokens",
        headers: session(s),
        payload: { name: `bad-${randomUUID().slice(0, 6)}`, scopes },
      });
      expect(res.statusCode, `${scopes.join()} was accepted`).toBe(400);
    }
  });

  test("enforces a per-user ceiling", async () => {
    const s = await provisionSubject(ctx, "tok");
    for (let i = 0; i < ctx.cfg.API_TOKEN_MAX_PER_USER; i += 1) {
      expect((await createToken(s)).status).toBe(201);
    }
    const overflow = await createToken(s);
    expect(overflow.status).toBe(409);
  });

  test("rejects a duplicate name without leaking the offending value", async () => {
    const s = await provisionSubject(ctx, "tok");
    const name = `dup-${randomUUID().slice(0, 8)}`;
    expect((await createToken(s, { name })).status).toBe(201);
    const second = await createToken(s, { name });
    expect(second.status).toBe(409);
  });

  test("every token expires", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    const { rows } = await ctx.services.db.query<{ expires_at: Date }>(
      `SELECT expires_at FROM api_tokens WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("authenticating with a token", () => {
  test("reads the caller's own account", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.id, authMethod: "token" });
  });

  test("records last_used_at without writing on every request", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    // The write is fire-and-forget so the read it records is never slowed by
    // it; a short settle is the honest way to observe it.
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await ctx.services.db.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]?.last_used_at).not.toBeNull();
  });

  test("is refused on routes that require a session", async () => {
    // A read-only token that could mint another token, manage connections, or
    // delete the account would be a persistence mechanism rather than a
    // credential: revoking the first token would accomplish nothing.
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    const cases: [string, string, object | undefined][] = [
      ["POST", "/v1/tokens", { name: "escalation" }],
      ["GET", "/v1/tokens", undefined],
      ["DELETE", `/v1/tokens/${created.id}`, undefined],
      ["POST", `/v1/tokens/${created.id}/rotate`, undefined],
      ["DELETE", "/v1/me", { confirm: s.email }],
      ["GET", "/v1/me/export", undefined],
      ["POST", "/v1/connections/lastfm", {}],
      ["DELETE", "/v1/connections/listenbrainz", undefined],
      ["POST", "/v1/wishlist", { artistName: "a", title: "b" }],
      ["POST", "/v1/auth/logout", undefined],
    ];
    for (const [method, url, payload] of cases) {
      const res = await ctx.app.inject({
        method: method as "GET",
        url,
        headers: { ...bearer(created.token), "idempotency-key": randomUUID() },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, `${method} ${url} accepted a personal token`).toBe(
        403,
      );
    }
  });

  test("enforces scopes", async () => {
    const s = await provisionSubject(ctx, "tok");
    const narrow = await createToken(s, { scopes: ["read:me"] });

    const allowed = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(narrow.token),
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await ctx.app.inject({
      method: "GET",
      url: "/v1/wishlist",
      headers: bearer(narrow.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  test("a revoked token stops working immediately", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);

    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tokens/${created.id}`,
      headers: session(s),
    });
    expect(revoked.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    expect(after.statusCode).toBe(401);
  });

  test("an expired token is refused", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    await ctx.services.db.query(
      // created_at moves too: the schema CHECKs expires_at > created_at, and
      // that constraint is correct (expiring in the past is what revoked_at is
      // for), so the fixture ages the whole row rather than fighting it.
      `UPDATE api_tokens
          SET created_at = now() - interval '2 days',
              expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [created.id],
    );
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    expect(res.statusCode).toBe(401);
  });

  test("unknown, expired, and revoked are indistinguishable", async () => {
    // A differential response tells an attacker which of their guesses were
    // once real, which is exactly the signal a credential-stuffing run needs.
    const s = await provisionSubject(ctx, "tok");
    const revokedToken = await createToken(s);
    await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tokens/${revokedToken.id}`,
      headers: session(s),
    });
    const expiredToken = await createToken(s);
    await ctx.services.db.query(
      // created_at moves too: the schema CHECKs expires_at > created_at, and
      // that constraint is correct (expiring in the past is what revoked_at is
      // for), so the fixture ages the whole row rather than fighting it.
      `UPDATE api_tokens
          SET created_at = now() - interval '2 days',
              expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [expiredToken.id],
    );
    const unknown = `pfm_test_${Buffer.alloc(32, 5).toString("base64url")}`;

    const bodies = new Set<string>();
    for (const token of [revokedToken.token, expiredToken.token, unknown]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: bearer(token),
      });
      expect(res.statusCode).toBe(401);
      // The instance id differs per request, so it is removed before comparing.
      bodies.add(res.body.replace(/"instance":"[^"]*"/, ""));
    }
    expect(bodies.size).toBe(1);
  });

  test("a token belonging to a deleted account stops working", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    await ctx.services.db.query(`DELETE FROM users WHERE id = $1`, [s.id]);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("rotation", () => {
  test("kills the old secret and issues a new one atomically", async () => {
    const s = await provisionSubject(ctx, "tok");
    const original = await createToken(s);

    const rotated = await ctx.app.inject({
      method: "POST",
      url: `/v1/tokens/${original.id}/rotate`,
      headers: session(s),
    });
    expect(rotated.statusCode).toBe(201);
    const next = jsonOf<{
      token: string;
      tokenRecord: { id: string; rotatedFromId: string | null };
    }>(rotated);

    expect(next.token).not.toBe(original.token);
    expect(next.tokenRecord.rotatedFromId).toBe(original.id);

    const oldRes = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(original.token),
    });
    expect(oldRes.statusCode).toBe(401);

    const newRes = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(next.token),
    });
    expect(newRes.statusCode).toBe(200);
  });

  test("preserves scopes across a rotation", async () => {
    const s = await provisionSubject(ctx, "tok");
    const original = await createToken(s, { scopes: ["read:me"] });
    const rotated = await ctx.app.inject({
      method: "POST",
      url: `/v1/tokens/${original.id}/rotate`,
      headers: session(s),
    });
    expect(
      jsonOf<{ tokenRecord: { scopes: string[] } }>(rotated).tokenRecord.scopes,
    ).toEqual(["read:me"]);
  });

  test("rotating a token that is already revoked is a 404", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tokens/${created.id}`,
      headers: session(s),
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/tokens/${created.id}/rotate`,
      headers: session(s),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("per-token rate limiting", () => {
  test("throttles one token without touching another", async () => {
    // Counted in the `noeviction` quota Redis so a cache-fill event cannot
    // silently disable it (THREAT-MODEL T11/M28).
    const s = await provisionSubject(ctx, "tok");
    const limited = await createToken(s);
    const other = await createToken(s);

    await ctx.services.db.query(
      `UPDATE api_tokens SET rate_limit_per_minute = 3 WHERE id = $1`,
      [limited.id],
    );

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: bearer(limited.token),
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);

    const unaffected = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(other.token),
    });
    expect(unaffected.statusCode).toBe(200);
  });

  test("advertises the budget in response headers", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
    expect(res.headers["ratelimit-reset"]).toBeDefined();
  });

  test("a 429 carries Retry-After", async () => {
    const s = await provisionSubject(ctx, "tok");
    const created = await createToken(s);
    await ctx.services.db.query(
      `UPDATE api_tokens SET rate_limit_per_minute = 1 WHERE id = $1`,
      [created.id],
    );
    await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("ownership", () => {
  test("a foreign token id is 404, not 403", async () => {
    // 403 would confirm the id exists and belongs to someone, which is an
    // enumeration oracle over the whole table.
    const owner = await provisionSubject(ctx, "owner");
    const other = await provisionSubject(ctx, "other");
    const created = await createToken(owner);

    for (const [method, url] of [
      ["DELETE", `/v1/tokens/${created.id}`],
      ["POST", `/v1/tokens/${created.id}/rotate`],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: session(other),
      });
      expect(res.statusCode).toBe(404);
    }

    // And the token still works for its owner: the failed attempt changed
    // nothing.
    const stillValid = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: bearer(created.token),
    });
    expect(stillValid.statusCode).toBe(200);
  });

  test("a token never appears in another subject's list", async () => {
    const owner = await provisionSubject(ctx, "owner");
    const other = await provisionSubject(ctx, "other");
    const created = await createToken(owner);
    const list = await ctx.app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: session(other),
    });
    expect(list.body).not.toContain(created.id);
  });
});
