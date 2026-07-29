/**
 * Magic-link sign-in, end to end and under attack.
 *
 * This is the only interactive sign-in the application has, so it is the front
 * door of the whole system: everything the BOLA suite proves about object
 * authorization rests on the subject being who the session says. The suite is
 * therefore weighted heavily towards the negative cases, because every
 * real-world failure in this category is something the flow ACCEPTED that it
 * should not have.
 *
 * Nothing here contacts WorkOS. The provider is stood in for by an in-process
 * mock (test/helpers/app.ts) that reproduces the three behaviours the
 * assertions depend on: codes are single use, codes are bound to an address,
 * and an unknown address is refused. Our own client, our own rate limiting, our
 * own session sealing and the real JWKS verification all run unmodified, and
 * the access token the mock issues is signed by the local IdP so a sign-in
 * produces a session that the production verification path actually accepts.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";
import { provisionSubject } from "../helpers/subjects.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

/**
 * A fresh, registered address.
 *
 * Unique per call because both rate-limit budgets are keyed on the address and
 * a shared fixture would make one test's exhaustion another test's mystery
 * failure.
 */
function knownAddress(label = "user"): string {
  const email = `${label}.${randomUUID().slice(0, 12)}@example.test`;
  ctx.workos.register(email, `user_magic_${randomUUID().slice(0, 12)}`);
  return email;
}

function unknownAddress(label = "nobody"): string {
  return `${label}.${randomUUID().slice(0, 12)}@example.test`;
}

/** A distinct source address per test, so the per-IP budget never bleeds. */
function freshIp(): string {
  const octet = () => String(Math.floor(Math.random() * 254) + 1);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const start = (email: string, ip = freshIp()) =>
  ctx.app.inject({
    method: "POST",
    url: "/v1/auth/start",
    // trustProxy is on, so this is how a per-IP budget is exercised at all.
    headers: { "x-forwarded-for": ip },
    payload: { email },
  });

const verify = (
  email: string,
  code: string,
  transport?: "bearer" | "cookie",
  ip = freshIp(),
) =>
  ctx.app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    headers: { "x-forwarded-for": ip },
    payload:
      transport === undefined ? { email, code } : { email, code, transport },
  });

/** Strips the request id so two problem documents can be compared. */
const stable = (body: string): string => body.replace(/"instance":"[^"]*"/, "");

/** Reads the sealed cookie out of a Set-Cookie header. */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw)
    ? String(raw[0] ?? "")
    : typeof raw === "string"
      ? raw
      : "";
  return header.split(";")[0] ?? "";
}

/** Signs a subject in for real and returns the cookie the browser would hold. */
async function signInWithCookie(): Promise<{ email: string; cookie: string }> {
  const email = knownAddress("cookie");
  await start(email);
  const code = ctx.workos.codeFor(email);
  const res = await verify(email, code ?? "", "cookie");
  expect(res.statusCode).toBe(200);
  return { email, cookie: cookieFrom(res) };
}

// ---------------------------------------------------------------------------
describe("POST /v1/auth/start", () => {
  test("accepts a registered address", async () => {
    const email = knownAddress();
    const res = await start(email);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "sent" });
    expect(ctx.workos.codeFor(email)).not.toBeNull();
  });

  test("an unregistered address is indistinguishable from a registered one", async () => {
    // THREAT-MODEL T23. This is the assertion the whole route is shaped
    // around: a sign-in form that answers "no such account" is a user
    // enumeration endpoint, and on a consumer music app the membership list is
    // itself the personal data.
    const known = await start(knownAddress());
    const unknown = await start(unknownAddress());

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(stable(unknown.body)).toBe(stable(known.body));
  });

  test("a first request for an unknown address creates an unverified identity", async () => {
    // The surprising property, asserted so it is discoverable rather than
    // rediscovered. `magic_auth/send` AUTO-CREATES a WorkOS user for an address
    // it does not know and answers 200; it does not refuse. Confirmed against
    // the live API on 2026-07-29.
    //
    // The consequence is that this unauthenticated route can cause a
    // personal-data record to exist for a person who never consented, which is
    // a GDPR Article 6 problem rather than a tidiness one. Two controls bound
    // it: the send budgets below bound the RATE, and the directory reaper
    // bounds the DURATION. This test exists so that removing either one has a
    // visible reason attached.
    const email = unknownAddress();
    expect((await start(email)).statusCode).toBe(202);

    const record = ctx.workos
      .directory()
      .find((entry) => entry.email === email.toLowerCase());
    expect(record, "the send did not create a directory record").toBeDefined();
    expect(record?.verified).toBe(false);
  });

  test("a malformed address is refused before anything is spent", async () => {
    for (const email of ["", "not-an-address", "a@", "@b", "x".repeat(400)]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/start",
        payload: { email },
      });
      expect(res.statusCode, email).toBe(400);
    }
  });

  test("an unrecognised field cannot influence the request", async () => {
    // `additionalProperties: false` plus Fastify's AJV defaults means the field
    // is STRIPPED before the handler runs rather than rejected, and on this
    // route that is the right outcome: there is no subject yet, so there is
    // nothing a `user_id` could be assigned to. The stricter rule applies where
    // it matters, on authenticated routes, where requireAuth rejects `user_id`
    // outright rather than ignoring it (THREAT-MODEL M14) and the BOLA suite
    // asserts it. What is asserted here is that the extra field changed
    // nothing.
    const email = knownAddress("extra");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/start",
      headers: { "x-forwarded-for": freshIp() },
      payload: { email, user_id: randomUUID(), transport: "cookie" },
    });
    expect(res.statusCode).toBe(202);
    expect(ctx.workos.codeFor(email)).not.toBeNull();
  });

  test("the per-address budget stops a mailbox being flooded", async () => {
    // Many hosts, one victim. A per-IP limit cannot see this at all, which is
    // why both budgets exist.
    const email = knownAddress("flood");
    const limit = ctx.cfg.AUTH_MAGIC_AUTH_PER_EMAIL_MAX;

    for (let i = 0; i < limit; i += 1) {
      expect((await start(email, freshIp())).statusCode).toBe(202);
    }
    const over = await start(email, freshIp());
    expect(over.statusCode).toBe(429);
    expect(over.headers["content-type"]).toContain("application/problem+json");
  });

  test("the per-source budget stops one host enumerating many addresses", async () => {
    const ip = freshIp();
    const limit = ctx.cfg.AUTH_MAGIC_AUTH_PER_IP_MAX;

    for (let i = 0; i < limit; i += 1) {
      expect((await start(knownAddress("spray"), ip)).statusCode).toBe(202);
    }
    expect((await start(knownAddress("spray"), ip)).statusCode).toBe(429);
  });

  test("the source budget is consumed before the address budget", async () => {
    // Order matters: if the address budget went first, an attacker could burn a
    // victim's send allowance from a host that was already over its own limit,
    // locking the victim out for free.
    const ip = freshIp();
    for (let i = 0; i < ctx.cfg.AUTH_MAGIC_AUTH_PER_IP_MAX; i += 1) {
      await start(knownAddress("order"), ip);
    }

    const victim = knownAddress("victim");
    expect((await start(victim, ip)).statusCode).toBe(429);

    // The victim's own budget is untouched, so they can still sign in from
    // anywhere else.
    expect((await start(victim, freshIp())).statusCode).toBe(202);
  });

  test("counters live in the noeviction quota store, never the cache", async () => {
    // THREAT-MODEL T11. Eviction policy is per instance: on the LRU cache a
    // cache-fill event would silently delete these counters and this route
    // would become an open mail relay with no error and no alert.
    const ip = freshIp();
    await start(knownAddress("store"), ip);

    expect(
      await ctx.services.quotaRedis.exists(`quota:auth:start:ip:${ip}`),
    ).toBe(1);
    expect(
      await ctx.services.cacheRedis.exists(`quota:auth:start:ip:${ip}`),
    ).toBe(0);
  });

  test("the address never appears in a Redis key", async () => {
    // Keys turn up in SCAN output, MONITOR, slow logs and support screenshots.
    // An email address is personal data and the quota store has no retention
    // policy, so only a truncated digest goes in.
    const email = knownAddress("privacy");
    await start(email);

    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await ctx.services.quotaRedis.scan(
        cursor,
        "MATCH",
        "quota:auth:*",
        "COUNT",
        500,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key, `${key} contains an address`).not.toContain(email);
      expect(key).not.toContain("@");
    }
  });

  test("the address never reaches the audit log", async () => {
    // audit_log rows deliberately outlive the user (no foreign key, migration
    // 0002), so an address written here would be a record of a person that
    // survives their own erasure request.
    const email = knownAddress("audit");
    await start(email);

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'auth.magic_auth.requested' AND subject_ref = $1`,
      [email],
    );
    expect(rows[0]?.n).toBe("0");

    const recorded = await ctx.services.db.query<{ subject_ref: string }>(
      `SELECT subject_ref FROM audit_log
        WHERE action = 'auth.magic_auth.requested'
        ORDER BY created_at DESC LIMIT 5`,
    );
    for (const row of recorded.rows) {
      expect(row.subject_ref).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  test("an identity-provider outage is a 503, not a silent success", async () => {
    // An outage is a fact about us, not about the address, so reporting it
    // truthfully leaks nothing. Answering 202 while sending no mail would leave
    // a user waiting for a code that is never coming.
    const email = knownAddress("outage");
    ctx.workos.failNext("/user_management/magic_auth", 503);
    const res = await start(email);
    expect(res.statusCode).toBe(503);
    expect(ctx.workos.codeFor(email)).toBeNull();
  });

  test("the response is padded to the configured floor", async () => {
    // The body alone does not close the enumeration hole: an upstream that
    // answers a known address slowly and an unknown one instantly leaks the
    // same fact through the clock. Asserted against an application configured
    // with a real floor, because the shared harness sets it to zero so every
    // other suite is not slowed by a control that has its own test.
    const slow = await buildTestApp({ env: { AUTH_START_FLOOR_MS: "220" } });
    try {
      const email = `floor.${randomUUID().slice(0, 8)}@example.test`;
      slow.workos.register(email, `user_floor_${randomUUID().slice(0, 8)}`);

      const measure = async (address: string): Promise<number> => {
        const began = Date.now();
        const res = await slow.app.inject({
          method: "POST",
          url: "/v1/auth/start",
          headers: { "x-forwarded-for": freshIp() },
          payload: { email: address },
        });
        expect(res.statusCode).toBe(202);
        return Date.now() - began;
      };

      // Both paths clear the floor, which is the property. This is NOT a
      // constant-time claim: an upstream slower than the floor still varies,
      // and services/magic-auth.ts records that residual rather than hiding it.
      expect(await measure(email)).toBeGreaterThanOrEqual(200);
      expect(
        await measure(`ghost.${randomUUID().slice(0, 8)}@example.test`),
      ).toBeGreaterThanOrEqual(200);
    } finally {
      await slow.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe("POST /v1/auth/verify", () => {
  test("a correct code establishes a session", async () => {
    const email = knownAddress("verify");
    await start(email);
    const res = await verify(email, ctx.workos.codeFor(email) ?? "");

    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      accessToken: string;
      refreshToken: string;
      transport: string;
      user: { id: string; email: string };
    }>(res);
    expect(body.transport).toBe("bearer");
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.user.email).toBe(email);

    // The session it handed out is a real one, verified by the real path.
    const me = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  test("signing in records mailbox control and the sign-in method", async () => {
    const email = knownAddress("record");
    await start(email);
    const res = await verify(email, ctx.workos.codeFor(email) ?? "");
    const userId = jsonOf<{ user: { id: string } }>(res).user.id;

    const { rows } = await ctx.services.db.query<{
      auth_method: string;
      email_verified: boolean;
      authenticated: boolean;
    }>(
      `SELECT auth_method,
              (email_verified_at     IS NOT NULL) AS email_verified,
              (last_authenticated_at IS NOT NULL) AS authenticated
         FROM users WHERE id = $1`,
      [userId],
    );
    // Completing the exchange IS the proof of mailbox control; there is no
    // separate verification step that could be skipped.
    expect(rows[0]).toEqual({
      auth_method: "magic_auth",
      email_verified: true,
      authenticated: true,
    });
  });

  test("a wrong code is refused", async () => {
    const email = knownAddress("wrong");
    await start(email);
    expect((await verify(email, "code_000000")).statusCode).toBe(401);
  });

  test("an expired code is refused", async () => {
    const email = knownAddress("expired");
    await start(email);
    const code = ctx.workos.codeFor(email) ?? "";
    ctx.workos.expire(email);
    expect((await verify(email, code)).statusCode).toBe(401);
  });

  test("a code cannot be replayed", async () => {
    // Single use is the provider's guarantee, and asserting it here is what
    // stops a future change from adding a local cache that quietly restores
    // replayability.
    const email = knownAddress("replay");
    await start(email);
    const code = ctx.workos.codeFor(email) ?? "";

    expect((await verify(email, code)).statusCode).toBe(200);
    expect((await verify(email, code)).statusCode).toBe(401);
  });

  test("a code minted for one address cannot sign in another", async () => {
    // The cross-account version of the replay. Without the address being part
    // of the exchange, whoever received a code could sign in as anyone.
    const victim = knownAddress("victim");
    const attacker = knownAddress("attacker");
    await start(victim);
    const victimCode = ctx.workos.codeFor(victim) ?? "";

    const res = await verify(attacker, victimCode);
    expect(res.statusCode).toBe(401);

    // And the victim's code was not consumed by the failed attempt, so an
    // attacker cannot burn an in-flight sign-in either.
    expect((await verify(victim, victimCode)).statusCode).toBe(200);
  });

  test("wrong, expired, replayed, foreign, and unknown are one answer", async () => {
    // If any of these were distinguishable, /v1/auth/start's careful
    // non-disclosure would be undone one route later.
    const email = knownAddress("uniform");
    const other = knownAddress("other");
    await start(email);
    const code = ctx.workos.codeFor(email) ?? "";
    expect((await verify(email, code)).statusCode).toBe(200);

    await start(other);
    const otherCode = ctx.workos.codeFor(other) ?? "";

    const bodies = new Set<string>();
    for (const [address, value] of [
      [email, code], // replayed
      [email, "code_999999"], // wrong
      [email, otherCode], // minted for someone else
      [unknownAddress(), "code_123456"], // no account at all
    ] as const) {
      const res = await verify(address, value);
      expect(res.statusCode).toBe(401);
      bodies.add(stable(res.body));
    }
    expect(bodies.size).toBe(1);
  });

  test("guessing is budgeted per address", async () => {
    // A short code is guessable at volume. WorkOS applies its own limit;
    // relying on an upstream control we cannot inspect or test is not a
    // control, so there is a local one.
    const email = knownAddress("guess");
    await start(email);

    for (let i = 0; i < ctx.cfg.AUTH_MAGIC_AUTH_VERIFY_MAX; i += 1) {
      expect(
        (
          await verify(
            email,
            `code_${String(i).padStart(6, "9")}`,
            undefined,
            freshIp(),
          )
        ).statusCode,
      ).toBe(401);
    }
    // Rotating the source address buys nothing, because the budget is keyed on
    // the address being attacked.
    expect(
      (await verify(email, "code_111111", undefined, freshIp())).statusCode,
    ).toBe(429);

    // And the real code is now refused too, which is the correct outcome: the
    // account is under attack and the right answer is to make the attacker wait.
    expect(
      (
        await verify(
          email,
          ctx.workos.codeFor(email) ?? "",
          undefined,
          freshIp(),
        )
      ).statusCode,
    ).toBe(429);
  });

  test("a failed attempt is auditable without recording the address", async () => {
    const email = knownAddress("failaudit");
    await start(email);
    await verify(email, "code_000001");

    const { rows } = await ctx.services.db.query<{ subject_ref: string }>(
      `SELECT subject_ref FROM audit_log
        WHERE action = 'auth.magic_auth.failed'
        ORDER BY created_at DESC LIMIT 3`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.subject_ref).toMatch(/^[0-9a-f]{32}$/);
      expect(row.subject_ref).not.toContain("@");
    }
  });
});

// ---------------------------------------------------------------------------
describe("the cookie transport", () => {
  test("returns no credential in the body at all", async () => {
    // The entire reason a browser client would choose this: a refresh token
    // JavaScript can read is a permanent account takeover one XSS away.
    const email = knownAddress("nobody-body");
    await start(email);
    const res = await verify(email, ctx.workos.codeFor(email) ?? "", "cookie");

    expect(res.statusCode).toBe(200);
    const body = jsonOf<Record<string, unknown>>(res);
    expect(body["accessToken"]).toBeUndefined();
    expect(body["refreshToken"]).toBeUndefined();
    expect(body["transport"]).toBe("cookie");
    expect(res.body).not.toContain("refresh_");
  });

  test("the cookie carries every attribute the design depends on", async () => {
    const email = knownAddress("attrs");
    await start(email);
    const res = await verify(email, ctx.workos.codeFor(email) ?? "", "cookie");
    const header = String(res.headers["set-cookie"]);

    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain");
    // A sign-in response must never be stored by a proxy or a service worker.
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  test("the sealed value discloses nothing", async () => {
    const email = knownAddress("opaque");
    await start(email);
    const res = await verify(email, ctx.workos.codeFor(email) ?? "", "cookie");
    const cookie = cookieFrom(res);

    expect(cookie).toContain("v1.");
    expect(cookie).not.toContain(email);
    expect(cookie).not.toContain("refresh_");
    // A JWT is three base64url segments separated by dots; the access token
    // inside must not be legible in the cookie.
    expect(cookie.split(".").length).toBe(2);
  });

  test("authenticates a request when the CSRF header is present", async () => {
    const { cookie } = await signInWithCookie();
    const me = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie, "x-pullfm-session": "1" },
    });
    expect(me.statusCode).toBe(200);
  });

  test("a cookie without the CSRF header is refused", async () => {
    // Control 2 of 2. SameSite=Strict is control 1, and it is a browser
    // behaviour we neither own nor can test here. A cross-site form post cannot
    // set a custom header at all, and a cross-origin XHR that tries triggers a
    // preflight this API answers only for allowlisted origins.
    const { cookie } = await signInWithCookie();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("x-pullfm-session");
  });

  test("a tampered cookie is refused", async () => {
    const { cookie } = await signInWithCookie();
    const eq = cookie.indexOf("=");
    const name = cookie.slice(0, eq);
    const value = cookie.slice(eq + 1);
    const flipped = `${value.slice(0, -2)}${value.endsWith("aa") ? "bb" : "aa"}`;

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${name}=${flipped}`, "x-pullfm-session": "1" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("a cookie sealed under a foreign key is refused", async () => {
    // Session forgery. Someone who can guess the format but not the key, which
    // is the position every attacker is in.
    const { SessionCookieCipher } =
      await import("../../src/lib/session-cookie.js");
    const foreign = new SessionCookieCipher(Buffer.alloc(32, 0xab));
    const s = await provisionSubject(ctx, "forge");

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${ctx.cfg.sessionCookieName}=${foreign.seal({
          accessToken: s.token,
          refreshToken: "forged",
          workosUserId: s.workosUserId,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        })}`,
        "x-pullfm-session": "1",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test("an authentically sealed cookie holding an unverifiable token is refused", async () => {
    // The property that makes the cookie a transport rather than a credential:
    // sealing something proves only that WE sealed it. The token inside still
    // has to survive JWKS verification, so a bug that sealed the wrong value
    // cannot grant a session.
    const s = await provisionSubject(ctx, "sealed");
    const forgedToken = await ctx.idp.mintWithForeignKey(s.workosUserId);
    const cookie = ctx.services.sessionCookies.seal({
      accessToken: forgedToken,
      refreshToken: "irrelevant",
      workosUserId: s.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${ctx.cfg.sessionCookieName}=${cookie}`,
        "x-pullfm-session": "1",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test("an expired cookie is refused without opening the token inside", async () => {
    const s = await provisionSubject(ctx, "stale");
    const cookie = ctx.services.sessionCookies.seal({
      accessToken: s.token,
      refreshToken: "irrelevant",
      workosUserId: s.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${ctx.cfg.sessionCookieName}=${cookie}`,
        "x-pullfm-session": "1",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test("one subject's cookie never returns another subject's data", async () => {
    const victim = await provisionSubject(ctx, "cvictim");
    const attacker = await provisionSubject(ctx, "cattacker");

    const cookie = ctx.services.sessionCookies.seal({
      accessToken: attacker.token,
      refreshToken: "irrelevant",
      workosUserId: attacker.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${ctx.cfg.sessionCookieName}=${cookie}`,
        "x-pullfm-session": "1",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(victim.id);
    expect(res.body).not.toContain(victim.email);
  });

  test("a cookie cannot smuggle a personal API token into a session", async () => {
    // Structural assertion rather than an expected case. Nothing seals a `pfm_`
    // value, so this can only be reached by a future bug, and without the guard
    // that bug would silently grant a read-only credential the cookie
    // transport's authority.
    const s = await provisionSubject(ctx, "smuggle");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${s.token}`,
        "idempotency-key": randomUUID(),
      },
      payload: { name: `smuggle ${randomUUID().slice(0, 8)}` },
    });
    const secret = jsonOf<{ token: string }>(created).token;

    const cookie = ctx.services.sessionCookies.seal({
      accessToken: secret,
      refreshToken: "irrelevant",
      workosUserId: s.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${ctx.cfg.sessionCookieName}=${cookie}`,
        "x-pullfm-session": "1",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test("an Authorization header wins over a stale cookie", async () => {
    // A client with a fresh token and an old cookie must not have the cookie
    // silently rescue a request whose bearer token was rejected.
    const s = await provisionSubject(ctx, "both");
    const stale = ctx.services.sessionCookies.seal({
      accessToken: await ctx.idp.mintWithForeignKey(s.workosUserId),
      refreshToken: "irrelevant",
      workosUserId: s.workosUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const good = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        authorization: `Bearer ${s.token}`,
        cookie: `${ctx.cfg.sessionCookieName}=${stale}`,
        "x-pullfm-session": "1",
      },
    });
    expect(good.statusCode).toBe(200);

    const bad = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        authorization: "Bearer not-a-token",
        cookie: `${ctx.cfg.sessionCookieName}=${stale}`,
        "x-pullfm-session": "1",
      },
    });
    expect(bad.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("POST /v1/auth/refresh", () => {
  test("a bearer client refreshes with the token it holds", async () => {
    const email = knownAddress("refresh");
    await start(email);
    const signIn = await verify(email, ctx.workos.codeFor(email) ?? "");
    const { refreshToken } = jsonOf<{ refreshToken: string }>(signIn);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const refreshed = jsonOf<{ accessToken: string; transport: string }>(res);
    expect(refreshed.transport).toBe("bearer");

    const me = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${refreshed.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  test("a refresh token cannot be replayed", async () => {
    // Refresh tokens rotate. A replay must fail, or a token captured once is a
    // permanent session.
    const email = knownAddress("rotate");
    await start(email);
    const { refreshToken } = jsonOf<{ refreshToken: string }>(
      await verify(email, ctx.workos.codeFor(email) ?? ""),
    );

    const post = () =>
      ctx.app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refreshToken },
      });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(401);
  });

  test("a cookie client refreshes without ever holding its refresh token", async () => {
    const { cookie } = await signInWithCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie, "x-pullfm-session": "1" },
    });

    expect(res.statusCode).toBe(200);
    const body = jsonOf<Record<string, unknown>>(res);
    expect(body["transport"]).toBe("cookie");
    expect(body["refreshToken"]).toBeUndefined();
    expect(body["accessToken"]).toBeUndefined();

    // A new sealed cookie replaces the old one, and it works.
    const rotated = cookieFrom(res);
    expect(rotated).not.toBe(cookie);
    const me = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: rotated, "x-pullfm-session": "1" },
    });
    expect(me.statusCode).toBe(200);
  });

  test("a cookie refresh without the CSRF header is refused", async () => {
    // Without this, a cross-site POST could rotate a victim's session at will,
    // which invalidates the refresh token their real client holds. That is a
    // logout an attacker can trigger from any page the victim visits.
    const { cookie } = await signInWithCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  test("a request with neither a token nor a cookie is refused", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
    });
    expect(res.statusCode).toBe(401);
  });

  test("a forged cookie cannot mint a session", async () => {
    const { SessionCookieCipher } =
      await import("../../src/lib/session-cookie.js");
    const foreign = new SessionCookieCipher(Buffer.alloc(32, 0xcd));
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: {
        cookie: `${ctx.cfg.sessionCookieName}=${foreign.seal({
          accessToken: "x",
          refreshToken: "forged",
          workosUserId: "user_forged",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        })}`,
        "x-pullfm-session": "1",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("POST /v1/auth/logout", () => {
  test("a cookie session can sign itself out", async () => {
    const { cookie } = await signInWithCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie, "x-pullfm-session": "1" },
    });
    expect(res.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie, "x-pullfm-session": "1" },
    });
    expect(after.statusCode).toBe(401);
  });

  test("signing out clears the cookie", async () => {
    const { cookie } = await signInWithCookie();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie, "x-pullfm-session": "1" },
    });
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
  });

  test("a bearer sign-out clears the cookie too", async () => {
    // Costs one header. Leaving a stale cookie behind on a shared browser does
    // not cost one header.
    const s = await provisionSubject(ctx, "bearerout");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
  });
});

// ---------------------------------------------------------------------------
describe("PATCH /v1/me", () => {
  const patch = (token: string, body: unknown) =>
    ctx.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
      payload: body as object,
    });

  test("updates the profile at the provider and locally", async () => {
    const s = await provisionSubject(ctx, "profile");
    const res = await patch(s.token, {
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.id, displayName: "Ada Lovelace" });

    // Local row and identity provider agree, which is the point of writing
    // upstream first and mirroring second.
    const { rows } = await ctx.services.db.query<{ display_name: string }>(
      `SELECT display_name FROM users WHERE id = $1`,
      [s.id],
    );
    expect(rows[0]?.display_name).toBe("Ada Lovelace");
    expect((await ctx.services.workos.getUser(s.workosUserId))?.firstName).toBe(
      "Ada",
    );
  });

  test("an empty patch changes nothing and still succeeds", async () => {
    // Idempotent no-op, so a mobile client retrying on a flaky network cannot
    // turn a retry into an error.
    const s = await provisionSubject(ctx, "noop");
    const before = (await patch(s.token, { firstName: "Grace" })).json();
    const after = await patch(s.token, {});
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject(before as object);
  });

  test("a name can be cleared", async () => {
    const s = await provisionSubject(ctx, "clear");
    await patch(s.token, { firstName: "Temp", lastName: "Name" });
    const res = await patch(s.token, { firstName: null, lastName: null });
    expect(res.statusCode).toBe(200);
    expect(jsonOf<{ displayName: string | null }>(res).displayName).toBeNull();
  });

  test("whitespace is not a name", async () => {
    const s = await provisionSubject(ctx, "blank");
    const res = await patch(s.token, { firstName: "   ", lastName: "  " });
    expect(jsonOf<{ displayName: string | null }>(res).displayName).toBeNull();
  });

  test("a personal API token cannot rename the account it can read", async () => {
    // The credential asymmetry. A leaked read-only token must not be able to
    // disguise the compromise by renaming the account.
    const s = await provisionSubject(ctx, "ropatch");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${s.token}`,
        "idempotency-key": randomUUID(),
      },
      payload: { name: `ro ${randomUUID().slice(0, 8)}` },
    });
    const secret = jsonOf<{ token: string }>(created).token;

    const res = await patch(secret, { firstName: "Attacker" });
    expect(res.statusCode).toBe(403);
  });

  test("a client-supplied subject id is rejected, not ignored", async () => {
    const victim = await provisionSubject(ctx, "pvictim");
    const attacker = await provisionSubject(ctx, "pattacker");

    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: {
        authorization: `Bearer ${attacker.token}`,
        "x-user-id": victim.id,
      },
      payload: { firstName: "Injected" },
    });
    expect(res.statusCode).toBe(400);

    const { rows } = await ctx.services.db.query<{ display_name: string }>(
      `SELECT display_name FROM users WHERE id = $1`,
      [victim.id],
    );
    expect(rows[0]?.display_name).not.toBe("Injected");
  });

  test("a display name supplied directly is not honoured", async () => {
    // Mass assignment. `displayName` is DERIVED from the names the identity
    // provider accepted, never taken from the request, so a client cannot set a
    // name that WorkOS never saw and leave the two stores disagreeing about who
    // this account belongs to. `additionalProperties: false` strips the field
    // before the handler runs; this asserts the effect rather than the
    // mechanism.
    const s = await provisionSubject(ctx, "massassign");
    const res = await patch(s.token, {
      firstName: "Fine",
      displayName: "Not accepted here",
    });
    expect(res.statusCode).toBe(200);
    expect(jsonOf<{ displayName: string }>(res).displayName).toBe("Fine");
  });

  test("an identity-provider failure leaves the local row untouched", async () => {
    // Upstream first, local second. The other order would leave us displaying a
    // name the identity provider rejected, permanently.
    const s = await provisionSubject(ctx, "upfail");
    const before = await ctx.services.users.findActiveById(s.id);

    ctx.workos.failNext("/user_management/users/", 500);
    const res = await patch(s.token, { firstName: "Never" });
    expect(res.statusCode).toBe(503);

    const after = await ctx.services.users.findActiveById(s.id);
    expect(after?.displayName).toBe(before?.displayName);
  });
});

// ---------------------------------------------------------------------------
describe("what this API deliberately does not offer", () => {
  test("there is no password, social, or passkey route", () => {
    // The magic-link-only decision, asserted rather than trusted to a comment.
    // The reasoning is at the top of routes/v1/auth.ts and services/workos.ts:
    // a server-to-server exchange is what keeps every sign-in screen ours.
    const paths = ctx.routes.map((r) => r.url.toLowerCase());
    for (const forbidden of [
      "password",
      "signup",
      "register",
      "oauth",
      "passkey",
      "webauthn",
      "sso",
    ]) {
      expect(
        paths.filter((p) => p.includes(forbidden)),
        `a route mentioning "${forbidden}" appeared; read the decision in routes/v1/auth.ts before adding one`,
      ).toEqual([]);
    }
  });

  test("the schema refuses any sign-in method but magic auth", async () => {
    // Two independent controls, which is the right number for a decision this
    // easy to reverse by accident: the routes above, and this constraint.
    await expect(
      ctx.services.db.query(
        `INSERT INTO users (workos_user_id, auth_method) VALUES ($1, 'social')`,
        [`user_social_${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toThrow(/users_auth_method_chk/);
  });

  test("no password hash, session key, or MFA secret column exists", async () => {
    // The migration says this in prose; here it is as a fact about the live
    // schema, so a future column cannot quietly contradict it.
    const { rows } = await ctx.services.db.query<{ column_name: string }>(
      `SELECT table_name || '.' || column_name AS column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name ~ 'password|passwd|mfa|totp|otp_secret'
               OR column_name = 'session_token'
               OR column_name = 'refresh_token')`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([]);
  });
});
