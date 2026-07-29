/**
 * Phase 8 adversarial verification.
 *
 * The BOLA suite next door proves that every user-scoped route refuses a
 * foreign subject. This file is the other half of the audit: it attacks the
 * claims that are asserted in prose and would be most expensive to have wrong.
 * Each block names the claim it is trying to falsify, because a security test
 * whose intent is not written down decays into a test of whatever the code
 * happens to do.
 *
 * The claims under attack, and where they are made:
 *
 *   1. lib/session-cookie.ts: "the cookie's own authentication tag proves only
 *      that we minted it, and the JWT inside still has to verify against
 *      WorkOS's published keys". A cookie we authentically sealed is the
 *      strongest thing an attacker could hope to obtain from a partial
 *      compromise, so the test seals one BY HAND, around a token the JWKS
 *      cannot verify, and requires a 401.
 *
 *   2. plugins/auth.ts: the per-token rate limiter "fails CLOSED. That is the
 *      whole reason the quota instance exists." Tested by making the quota
 *      store reject, not by taking it away, because a store that answers PING
 *      and refuses writes is the failure that actually happens.
 *
 *   3. services/connections.ts + packages/crypto: the KEK is required to read a
 *      stored credential, and AAD binds the ciphertext to (user, provider,
 *      column). Tested by holding the ciphertext and NOT the key, and by moving
 *      an authentic ciphertext between rows.
 *
 *   4. plugins/auth.ts: a personal API token is read-only and cannot mint
 *      another token. Tested because if it were false, a leaked read-only token
 *      would be a persistence mechanism rather than a bounded disclosure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { provisionSubject, type Subject } from "../helpers/subjects.js";
import { SessionCookieCipher } from "../../src/lib/session-cookie.js";
import { SESSION_TRANSPORT_HEADER } from "../../src/plugins/auth.js";
import { EnvelopeCipher, CryptoError } from "@pull-fm/crypto";

let ctx: TestApp;
let alice: Subject;
let mallory: Subject;

beforeAll(async () => {
  ctx = await buildTestApp();
  alice = await provisionSubject(ctx, "alice");
  mallory = await provisionSubject(ctx, "mallory");
});

afterAll(async () => {
  await ctx.close();
});

/**
 * The cookie name and cipher the server itself is using.
 *
 * Read off the config rather than hard-coded, so a rename cannot make these
 * tests silently stop exercising the cookie transport and start exercising the
 * "no cookie at all" path, which would pass for the wrong reason.
 */
function cookieCipher(): { name: string; cipher: SessionCookieCipher } {
  // `sessionCookieName` is DERIVED (config.ts sessionCookieNameFor), not a
  // configured key. Reading a name that does not exist would silently send the
  // cookie under the literal header `undefined=`, the server would see no
  // cookie at all, and every assertion below would pass by answering 401 for
  // the wrong reason. That mistake was made once while writing this file.
  const name = ctx.cfg.sessionCookieName;
  return { name, cipher: new SessionCookieCipher(activeKekBytes()) };
}

/** The active KEK as raw bytes. Config stores it base64, not as a Buffer. */
function activeKekBytes(): Buffer {
  const b64 = ctx.cfg.CREDENTIAL_KEKS.get(ctx.cfg.CREDENTIAL_ACTIVE_KEK_ID);
  if (b64 === undefined) throw new Error("no active KEK in test config");
  return Buffer.from(b64, "base64");
}

describe("an authentically sealed cookie is not a credential", () => {
  it("is rejected when the token inside it was signed by a key outside the JWKS", async () => {
    const { name, cipher } = cookieCipher();
    // Signed by a key the published JWKS does not contain. This is the shape of
    // a forged WorkOS token (THREAT-MODEL T21) wrapped in a cookie we really
    // did seal, which is the combination that would defeat a design where the
    // seal was treated as proof of identity.
    const forged = await ctx.idp.mintWithForeignKey(alice.workosUserId);
    const sealed = cipher.seal({
      accessToken: forged,
      refreshToken: "refresh_not_a_real_token",
      workosUserId: alice.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${name}=${sealed}`,
        [SESSION_TRANSPORT_HEADER]: "1",
      },
    });

    expect(res.statusCode).toBe(401);
    // And the body must not say WHICH check failed, or the cookie becomes an
    // oracle for how close a forgery got.
    expect(res.body).not.toContain("signature");
    expect(res.body).not.toContain("jwks");
  });

  it("is rejected when the token inside it has expired, even though the cookie has not", async () => {
    const { name, cipher } = cookieCipher();
    const expired = await ctx.idp.mint(alice.workosUserId, {
      sessionId: alice.sessionId,
      expiresInSeconds: -600,
    });
    const sealed = cipher.seal({
      accessToken: expired,
      refreshToken: "refresh_not_a_real_token",
      workosUserId: alice.workosUserId,
      // Deliberately far in the future: the cookie's own outer bound must not
      // be able to extend the life of the token it carries.
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${name}=${sealed}`,
        [SESSION_TRANSPORT_HEADER]: "1",
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it("is rejected when the sealed workosUserId disagrees with the token subject", async () => {
    const { name, cipher } = cookieCipher();
    // Mallory's real, verifiable token, relabelled inside the cookie as Alice.
    // The cookie's `u` field is documented as "cross-checked against the token,
    // never trusted alone", so the request must resolve to Mallory or to
    // nobody, and under no circumstances to Alice.
    const sealed = cipher.seal({
      accessToken: mallory.token,
      refreshToken: "refresh_not_a_real_token",
      workosUserId: alice.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${name}=${sealed}`,
        [SESSION_TRANSPORT_HEADER]: "1",
      },
    });

    if (res.statusCode === 200) {
      const body = res.json<{ id?: string; email?: string }>();
      expect(body.id).not.toBe(alice.id);
      expect(body.email).not.toBe(alice.email);
      expect(body.id).toBe(mallory.id);
    } else {
      expect(res.statusCode).toBe(401);
    }
  });

  it("is rejected without the CSRF transport header, and the header's value is irrelevant", async () => {
    const { name, cipher } = cookieCipher();
    const sealed = cipher.seal({
      accessToken: alice.token,
      refreshToken: "refresh_not_a_real_token",
      workosUserId: alice.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const without = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${name}=${sealed}` },
    });
    expect(without.statusCode).toBe(403);

    // An empty-string header is still "present". The control is that a
    // cross-site request cannot cause the header to be sent at all, so treating
    // the value as a secret would be a different and weaker control.
    const withEmpty = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${name}=${sealed}`,
        [SESSION_TRANSPORT_HEADER]: "",
      },
    });
    expect(withEmpty.statusCode).toBe(200);
  });

  it("cannot be produced under a different KEK", async () => {
    const { name } = cookieCipher();
    // An attacker who knows the format exactly but not the key.
    const foreign = new SessionCookieCipher(Buffer.alloc(32, 0xab));
    const sealed = foreign.seal({
      accessToken: alice.token,
      refreshToken: "refresh_not_a_real_token",
      workosUserId: alice.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${name}=${sealed}`,
        [SESSION_TRANSPORT_HEADER]: "1",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("the KEK is required to read a stored credential", () => {
  /**
   * The threat is an attacker who has the database and not the key: a leaked
   * backup, a replica, a dump, or - since the Neon migration - anyone holding
   * the connection string, because the database now answers from the public
   * internet (PULLFM-RISK-007).
   */
  it("a holder of the ciphertext without the KEK cannot recover the plaintext", () => {
    const realKek = activeKekBytes();

    const cipher = new EnvelopeCipher(
      new Map([[ctx.cfg.CREDENTIAL_ACTIVE_KEK_ID, realKek]]),
      ctx.cfg.CREDENTIAL_ACTIVE_KEK_ID,
    );
    const aad = {
      userId: alice.id,
      provider: "listenbrainz" as const,
      field: "access_token",
    };
    const sealed = cipher.seal("lb_token_that_must_not_leak", aad);

    // Sanity: the real key opens it. Without this the negative cases below
    // could pass because the fixture was broken rather than because the
    // cryptography held.
    expect(cipher.open(sealed, aad)).toBe("lb_token_that_must_not_leak");

    // Same KEK ID, different bytes. This is the attacker who has read the
    // schema, knows the algorithm, and is guessing the key.
    const wrongKey = new EnvelopeCipher(
      new Map([[ctx.cfg.CREDENTIAL_ACTIVE_KEK_ID, Buffer.alloc(32, 0x5a)]]),
      ctx.cfg.CREDENTIAL_ACTIVE_KEK_ID,
    );
    expect(() => wrongKey.open(sealed, aad)).toThrow(CryptoError);

    // No KEK at all under that id. Must be a loud failure, never a silent
    // fallback to some other key in the set.
    const otherKek = new EnvelopeCipher(
      new Map([["kek:unrelated", Buffer.alloc(32, 0x77)]]),
      "kek:unrelated",
    );
    expect(() => otherKek.open(sealed, aad)).toThrow(CryptoError);
  });

  it("an authentic ciphertext moved to another user's row fails to authenticate", () => {
    const realKek = activeKekBytes();
    const cipher = new EnvelopeCipher(
      new Map([[ctx.cfg.CREDENTIAL_ACTIVE_KEK_ID, realKek]]),
      ctx.cfg.CREDENTIAL_ACTIVE_KEK_ID,
    );

    const sealed = cipher.seal("mallorys_own_token", {
      userId: mallory.id,
      provider: "listenbrainz",
      field: "access_token",
    });

    // THREAT-MODEL T08: an attacker with write access to Postgres but not the
    // KEK moves Mallory's ciphertext onto Alice's row so the BFF decrypts it
    // inside Alice's session. The AAD is what turns that into a tag failure.
    expect(() =>
      cipher.open(sealed, {
        userId: alice.id,
        provider: "listenbrainz",
        field: "access_token",
      }),
    ).toThrow(CryptoError);

    // The same row, the wrong column.
    expect(() =>
      cipher.open(sealed, {
        userId: mallory.id,
        provider: "listenbrainz",
        field: "refresh_token",
      }),
    ).toThrow(CryptoError);

    // The same user, a different provider.
    expect(() =>
      cipher.open(sealed, {
        userId: mallory.id,
        provider: "lastfm",
        field: "access_token",
      }),
    ).toThrow(CryptoError);
  });
});

describe("the quota store fails closed rather than open", () => {
  /**
   * The realistic outage is not "Redis is gone". It is "Redis answers PING and
   * refuses the write", which is what `noeviction` produces at `maxmemory` and
   * what a failing-over managed instance produces during the switch. A limiter
   * that treats that as "allowed" is not a limiter, and the failure is silent.
   */
  it("a personal API token is refused, not admitted, when the counter cannot be written", async () => {
    const refusing = await buildTestApp();
    try {
      const subject = await provisionSubject(refusing, "quota");
      const created = await refusing.app.inject({
        method: "POST",
        url: "/v1/tokens",
        headers: {
          authorization: `Bearer ${subject.token}`,
          "idempotency-key": randomUUID(),
        },
        payload: { name: "audit probe", scopes: ["read:me"] },
      });
      expect(created.statusCode).toBe(201);
      const token = created.json<{ token: string }>().token;

      // Baseline: the token works while the counter can be written.
      const before = await refusing.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(before.statusCode).toBe(200);

      // Now make the quota store refuse writes the way a full `noeviction`
      // instance does, while leaving reads working, so the process still looks
      // healthy from every angle except the one that matters.
      const quota = refusing.services.quotaRedis as unknown as {
        eval: (...args: unknown[]) => Promise<unknown>;
      };
      const realEval = quota.eval.bind(quota);
      quota.eval = () =>
        Promise.reject(
          new Error("OOM command not allowed when used memory > 'maxmemory'."),
        );

      try {
        const during = await refusing.app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer ${token}` },
        });
        // 503 is the fail-closed answer. A 200 here would mean the per-token
        // budget silently stopped existing.
        expect(during.statusCode).not.toBe(200);
        expect(during.statusCode).toBe(503);
      } finally {
        quota.eval = realEval;
      }

      // And it recovers rather than latching.
      const after = await refusing.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.statusCode).toBe(200);
    } finally {
      await refusing.close();
    }
  });

  it("a signed-out session stays signed out when the revocation store cannot be read", async () => {
    const refusing = await buildTestApp();
    try {
      const subject = await provisionSubject(refusing, "revoke");
      const quota = refusing.services.quotaRedis as unknown as {
        exists: (...args: unknown[]) => Promise<unknown>;
      };
      const realExists = quota.exists.bind(quota);
      quota.exists = () => Promise.reject(new Error("connection is closed"));

      try {
        const res = await refusing.app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer ${subject.token}` },
        });
        // A revocation list we cannot read must be assumed to say "revoked".
        // Answering 200 would honour a session the user believes they ended.
        expect(res.statusCode).not.toBe(200);
      } finally {
        quota.exists = realExists;
      }
    } finally {
      await refusing.close();
    }
  });
});

describe("a personal API token cannot escalate itself", () => {
  it("cannot mint another token, which would make a leak permanent", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${alice.token}`,
        "idempotency-key": randomUUID(),
      },
      payload: { name: "audit escalation probe", scopes: ["read:me"] },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json<{ token: string }>().token;

    const minted = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": randomUUID(),
      },
      payload: { name: "second token", scopes: ["read:me"] },
    });
    // If this ever returns 201, revoking the leaked token stops being a
    // remedy: the attacker already holds one the user has never seen.
    expect(minted.statusCode).not.toBe(201);
    expect([401, 403]).toContain(minted.statusCode);
  });

  it("cannot be smuggled in through the cookie transport", async () => {
    const { name, cipher } = cookieCipher();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${alice.token}`,
        "idempotency-key": randomUUID(),
      },
      payload: { name: "audit cookie probe", scopes: ["read:me"] },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json<{ token: string }>().token;

    // A read-only credential placed inside the transport that carries the
    // CSRF surface. Nothing in the application seals one, so this is a
    // structural assertion: it must not become possible by accident.
    const sealed = cipher.seal({
      accessToken: token,
      refreshToken: "refresh_not_a_real_token",
      workosUserId: alice.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${name}=${sealed}`,
        [SESSION_TRANSPORT_HEADER]: "1",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
