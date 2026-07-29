/**
 * Session authentication and the connect flow.
 *
 * THREAT-MODEL T21 (token forgery) and T22 (connection grafting) are both rated
 * Critical, and both are only closed if the negative cases hold. A happy-path
 * test of a JWT verifier proves nothing: every real-world failure in this
 * category is a case the verifier accepted that it should not have.
 */

import { randomUUID } from "node:crypto";

import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  buildTestApp,
  FIXTURE_SESSION_KEY,
  type TestApp,
} from "../helpers/app.js";
import { provisionSubject } from "../helpers/subjects.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const me = (token: string | null) =>
  ctx.app.inject({
    method: "GET",
    url: "/v1/me",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

describe("JWT verification (T21 / M18)", () => {
  test("accepts a correctly signed token for a known subject", async () => {
    const s = await provisionSubject(ctx, "auth");
    const res = await me(s.token);
    expect(res.statusCode).toBe(200);
  });

  test("rejects a token signed by a key outside the JWKS", async () => {
    const s = await provisionSubject(ctx, "auth");
    const forged = await ctx.idp.mintWithForeignKey(s.workosUserId);
    expect((await me(forged)).statusCode).toBe(401);
  });

  test("rejects alg:none", async () => {
    // The classic. jose refuses it structurally, and the explicit algorithm
    // allowlist refuses it again, but the assertion is what proves both.
    const s = await provisionSubject(ctx, "auth");
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: s.workosUserId,
        iss: ctx.idp.issuer,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    expect((await me(`${header}.${payload}.`)).statusCode).toBe(401);
  });

  test("rejects an HMAC-signed token, so a public key cannot become a secret", async () => {
    // The algorithm-confusion attack: sign with HS256 using the RSA public key
    // as the shared secret. Defeated by the RS256-only allowlist.
    const s = await provisionSubject(ctx, "auth");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(s.workosUserId)
      .setIssuer(ctx.idp.issuer)
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("public-key-as-secret"));
    expect((await me(forged)).statusCode).toBe(401);
  });

  test("rejects a token from a different issuer", async () => {
    // The issuer embeds the WorkOS client id, which is what makes a token
    // minted for a different WorkOS application fail here.
    const s = await provisionSubject(ctx, "auth");
    const wrongIssuer = await ctx.idp.mint(s.workosUserId, {
      issuer: "https://api.workos.com/user_management/client_someone_else",
    });
    expect((await me(wrongIssuer)).statusCode).toBe(401);
  });

  test("rejects a token whose audience names another application", async () => {
    const s = await provisionSubject(ctx, "auth");
    const wrongAudience = await ctx.idp.mint(s.workosUserId, {
      audience: "client_someone_else",
    });
    expect((await me(wrongAudience)).statusCode).toBe(401);
  });

  test("rejects an expired token", async () => {
    const s = await provisionSubject(ctx, "auth");
    const expired = await ctx.idp.mint(s.workosUserId, {
      expiresInSeconds: -3600,
    });
    expect((await me(expired)).statusCode).toBe(401);
  });

  test("rejects a token for a subject we have no active record of", async () => {
    // A structurally valid token for an unknown or deleted subject. Creating a
    // row here would resurrect a deleted account, so the answer is 401.
    const orphan = await ctx.idp.mint(`user_never_seen_${randomUUID()}`);
    expect((await me(orphan)).statusCode).toBe(401);
  });

  test("rejects a missing or malformed Authorization header", async () => {
    expect((await me(null)).statusCode).toBe(401);
    for (const header of ["", "Bearer", "Bearer ", "Basic abc", "token abc"]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: header },
      });
      expect(res.statusCode, `${header} was accepted`).toBe(401);
    }
  });

  test("every rejection returns the same body", async () => {
    const s = await provisionSubject(ctx, "auth");
    const bodies = new Set<string>();
    for (const token of [
      await ctx.idp.mintWithForeignKey(s.workosUserId),
      await ctx.idp.mint(s.workosUserId, { expiresInSeconds: -3600 }),
      await ctx.idp.mint(s.workosUserId, { audience: "client_other" }),
      await ctx.idp.mint(`user_unknown_${randomUUID()}`),
    ]) {
      const res = await me(token);
      bodies.add(res.body.replace(/"instance":"[^"]*"/, ""));
    }
    expect(bodies.size).toBe(1);
  });

  test("a token minted before the local key rotated is not accepted", async () => {
    // Sanity check on the JWKS wiring: keys really are fetched from the
    // configured endpoint rather than trusted from the token header.
    const { privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const s = await provisionSubject(ctx, "auth");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setSubject(s.workosUserId)
      .setIssuer(ctx.idp.issuer)
      .setExpirationTime("10m")
      .sign(privateKey);
    expect((await me(forged)).statusCode).toBe(401);
  });
});

describe("session revocation", () => {
  test("signing out invalidates the access token immediately", async () => {
    // Local revocation matters because the access token the client already
    // holds must stop working now, not at its natural expiry.
    const s = await provisionSubject(ctx, "auth");
    expect((await me(s.token)).statusCode).toBe(200);

    const logout = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toMatchObject({ revoked: true });

    expect((await me(s.token)).statusCode).toBe(401);
  });

  test("revoking one session does not affect another", async () => {
    const s = await provisionSubject(ctx, "auth");
    const second = await ctx.idp.mint(s.workosUserId, {
      sessionId: `session_other_${randomUUID().slice(0, 8)}`,
    });

    await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${s.token}` },
    });

    expect((await me(s.token)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
  });

  test("revocation is recorded in the quota store, not the evictable cache", async () => {
    // Eviction policy is per instance. On the LRU cache a revocation entry is
    // evictable, so a cache-fill event would silently un-revoke every session.
    const s = await provisionSubject(ctx, "auth");
    await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(
      await ctx.services.quotaRedis.exists(`revoked:sid:${s.sessionId}`),
    ).toBe(1);
    expect(
      await ctx.services.cacheRedis.exists(`revoked:sid:${s.sessionId}`),
    ).toBe(0);
  });
});

describe("the connect flow (T22 / M20)", () => {
  const start = (token: string, service = "lastfm") =>
    ctx.app.inject({
      method: "POST",
      url: `/v1/connections/${service}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

  const stateOf = (body: string): string =>
    new URL(
      (JSON.parse(body) as { authorizeUrl: string }).authorizeUrl,
    ).searchParams.get("state") ?? "";

  const callback = (token: string, state: string, service = "lastfm") =>
    ctx.app.inject({
      method: "GET",
      url: `/v1/connections/${service}/callback?state=${encodeURIComponent(state)}&token=abc`,
      headers: { authorization: `Bearer ${token}` },
    });

  test("a state is single-use", async () => {
    const s = await provisionSubject(ctx, "connect");
    const state = stateOf((await start(s.token)).body);

    expect((await callback(s.token, state)).statusCode).toBe(200);
    // A replay loses the race rather than being checked and then deleted.
    expect((await callback(s.token, state)).statusCode).toBe(400);
  });

  test("a state minted for one subject cannot be completed by another", async () => {
    // Connection grafting, both directions. Last.fm session keys never expire,
    // so a successful graft would be a permanent read channel into the
    // victim's listening activity.
    const victim = await provisionSubject(ctx, "victim");
    const attacker = await provisionSubject(ctx, "attacker");
    const state = stateOf((await start(victim.token)).body);

    expect((await callback(attacker.token, state)).statusCode).toBe(400);

    // And the victim's state was NOT consumed by the failed attempt, so an
    // attacker cannot burn an in-flight connect either.
    expect((await callback(victim.token, state)).statusCode).toBe(200);
  });

  test("an expired state is refused", async () => {
    const s = await provisionSubject(ctx, "connect");
    const state = stateOf((await start(s.token)).body);
    await ctx.services.db.query(
      `UPDATE connect_states SET created_at = now() - interval '1 hour',
                                 expires_at = now() - interval '1 second'
        WHERE user_id = $1`,
      [s.id],
    );
    expect((await callback(s.token, state)).statusCode).toBe(400);
  });

  test("unknown, expired, foreign, and replayed states are indistinguishable", async () => {
    const s = await provisionSubject(ctx, "connect");
    const other = await provisionSubject(ctx, "other");
    const state = stateOf((await start(s.token)).body);
    const foreign = stateOf((await start(other.token)).body);

    // Consume the subject's own state so it becomes a genuine replay.
    expect((await callback(s.token, state)).statusCode).toBe(200);

    const bodies = new Set<string>();
    for (const value of [foreign, "totally-unknown-state-value", state]) {
      const res = await callback(s.token, value);
      expect(res.statusCode).toBe(400);
      bodies.add(res.body.replace(/"instance":"[^"]*"/, ""));
    }
    expect(bodies.size).toBe(1);
  });

  test("the state is stored only as a digest", async () => {
    const s = await provisionSubject(ctx, "connect");
    const state = stateOf((await start(s.token)).body);
    const { rows } = await ctx.services.db.query<{ state_hash: string }>(
      `SELECT state_hash FROM connect_states WHERE user_id = $1`,
      [s.id],
    );
    expect(rows[0]?.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.state_hash).not.toBe(state);
  });

  test("starting a second flow replaces the first rather than accumulating", async () => {
    const s = await provisionSubject(ctx, "connect");
    const first = stateOf((await start(s.token)).body);
    const second = stateOf((await start(s.token)).body);
    expect(first).not.toBe(second);

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM connect_states WHERE user_id = $1`,
      [s.id],
    );
    expect(rows[0]?.n).toBe("1");
    expect((await callback(s.token, first)).statusCode).toBe(400);
    expect((await callback(s.token, second)).statusCode).toBe(200);
  });

  test("the stored credential is ciphertext and never returned", async () => {
    const s = await provisionSubject(ctx, "connect");
    const state = stateOf((await start(s.token)).body);
    const done = await callback(s.token, state);
    expect(done.statusCode).toBe(200);

    // The mock provider issues a 32-hex value shaped like a Last.fm session
    // key, so this assertion is live rather than theoretical.
    expect(done.body).not.toContain(FIXTURE_SESSION_KEY);

    const { rows } = await ctx.services.db.query<{ ct: Buffer }>(
      `SELECT access_token_ct AS ct FROM user_connections WHERE user_id = $1`,
      [s.id],
    );
    const ciphertext = rows[0]?.ct;
    expect(ciphertext).toBeDefined();
    expect(ciphertext?.toString("utf8")).not.toContain(FIXTURE_SESSION_KEY);
    // nonce(12) + tag(16) at minimum.
    expect((ciphertext?.length ?? 0) > 28).toBe(true);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/v1/connections",
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(list.body).not.toContain(FIXTURE_SESSION_KEY);
    expect(list.body).not.toContain("kekId");
    expect(list.body).not.toContain("wrappedDek");
  });
});
