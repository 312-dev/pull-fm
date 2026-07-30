/**
 * The closed-beta registration allowlist, against a real application.
 *
 * src/lib/registration-allowlist.test.ts proves the DECISION and the PARSE are
 * right across every address and entry shape. This file proves the decision is
 * actually WIRED to the routes that form an account, that it runs early enough to
 * matter, that its refusal cannot be used to learn who is on the list, and that
 * the things it must NOT touch still work.
 *
 * Three assertions here carry more weight than the rest:
 *
 *   THE ORPHAN IDENTITY, AND ITS PAIRED CONTROL. `POST /v1/auth/start` CREATES A
 *   WORKOS USER for whatever address it is handed and emails that address - it is
 *   documented on the route and the provider stand-in reproduces it. A refusal
 *   that ran a moment too late would leave a personal-data record at a processor
 *   for somebody we had just refused, and put an unexpected sign-in mail in a
 *   stranger's inbox. Asserting the 403 is not enough: the directory has to be
 *   asserted EMPTY, and the paired positive control has to prove an ADMITTED
 *   address does reach the provider. Without the second one the first passes
 *   equally well if the stand-in never created anything for anybody.
 *
 *   THE ENUMERATION ORACLE. Two refused addresses - one a near miss on an
 *   admitted address, one plainly unrelated - must produce BYTE-IDENTICAL
 *   responses. If they differ at all, the endpoint becomes a way to discover which
 *   addresses are admitted, one probe at a time, which is the same oracle
 *   `/auth/start` spends thirty lines refusing to be for account existence.
 *
 *   NOBODY IS LOCKED OUT. Refresh and sign-out are deliberately ungated. Refusing
 *   a refresh would lock out a session that was legitimately created, and refusing
 *   a logout would trap a live session open on a device its owner is leaving.
 *
 * THREE APPLICATIONS ARE BUILT, and the differences between them are
 * configuration rather than test switches:
 *
 *   `closed`  `AUTH_REGISTRATION_ALLOWLIST` set to a short list of admitted
 *             addresses. What staging runs during the beta. Its magic-auth budgets
 *             are raised, for the reason helpers/app.ts already raises
 *             `RATE_LIMIT_MAX`: this file sends many codes to the same admitted
 *             address, the per-address budget is 5 an hour by default, and a suite
 *             that throttled itself would report a 429 that looks exactly like the
 *             gate failing.
 *   `open`    no allowlist at all. The launch state, and every laptop.
 *   `tight`   the same allowlist with the SHIPPED budgets, built only so one
 *             assertion can prove a refusal does not spend them. It cannot be
 *             folded into `closed` precisely because `closed` raises them.
 *
 * THE ADMITTED ADDRESSES ARE UNIQUE PER RUN, and so is the one the `tight`
 * application uses. The send budgets are counted in the SHARED quota Redis on an
 * hour's window and keyed on a digest of the address, with no namespace per
 * application - so a hard-coded admitted address would carry this file's spend from
 * one run into the next AND from `closed` into `tight`, and fail for an hour. That
 * is the same trap the region suite avoids with `freshAddress`, and it applies to
 * the admitted addresses here as much as to the refused ones.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";
import { provisionSubject } from "../helpers/subjects.js";

const RUN = randomUUID().slice(0, 12);

/**
 * THREE admitted addresses, not one, and unique per run. Both parts matter.
 *
 * Unique per run for the reason in the header: the send budgets live in the shared
 * quota Redis on an hour's window.
 *
 * Three of them because a POSITIVE assertion is not repeatable against one
 * address. `users.email` is unique, the WorkOS stand-in keys its directory on the
 * address, and `establish()` upserts on the WorkOS user id - so two different
 * positive paths that both claim the same address end up asking the database to
 * attach one email to two identities, which is a 500 that has nothing to do with
 * the allowlist. Each positive path therefore gets its own address, and the
 * refusals share none of them.
 */
const ADMITTED = `insider.${RUN}@example.test`;
/** For the hosted-callback positive control only. */
const ADMITTED_CALLBACK = `insider-callback.${RUN}@example.test`;
/** For the send-budget assertion only, which runs on its own application. */
const ADMITTED_BUDGET = `insider-budget.${RUN}@example.test`;

/**
 * The list as the OPERATOR would have typed it, with the first entry in the wrong
 * case on purpose.
 *
 * The configured entry differing in case from every request this file sends is
 * what proves the folding happens on the way INTO the set as well as on the way in
 * from the wire. A list that folded only the request side would let an operator
 * produce an entry no request could ever match, which is the silent lockout
 * `parseRegistrationAllowlist` exists to prevent.
 */
const ALLOWLIST = [
  ADMITTED.toUpperCase(),
  ADMITTED_CALLBACK,
  ADMITTED_BUDGET,
].join(",");

/**
 * The budgets this file needs out of the way, and why they are not the control
 * being tested.
 *
 * services/magic-auth.ts owns them and has its own suite. Here they would only
 * throttle the admitted addresses, which every positive assertion has to send to,
 * and produce a 429 indistinguishable at a glance from the gate refusing.
 */
const RAISED_BUDGETS = {
  AUTH_MAGIC_AUTH_PER_IP_MAX: "100000",
  AUTH_MAGIC_AUTH_PER_EMAIL_MAX: "100000",
  AUTH_MAGIC_AUTH_VERIFY_MAX: "100000",
} as const;

/** Registration is gated to the list above. What staging runs during the beta. */
let closed: TestApp;
/** No allowlist at all. The launch state, and every laptop. */
let open: TestApp;
/** The same gate with the SHIPPED budgets, for the one assertion that needs them. */
let tight: TestApp;

beforeAll(async () => {
  [closed, open, tight] = await Promise.all([
    buildTestApp({
      env: { AUTH_REGISTRATION_ALLOWLIST: ALLOWLIST, ...RAISED_BUDGETS },
    }),
    buildTestApp(),
    buildTestApp({ env: { AUTH_REGISTRATION_ALLOWLIST: ALLOWLIST } }),
  ]);
}, 120_000);

afterAll(async () => {
  await Promise.all([closed.close(), open.close(), tight.close()]);
});

/** A fresh address per call: both send budgets are keyed on the address. */
function freshAddress(label = "outsider"): string {
  return `${label}.${randomUUID().slice(0, 12)}@example.test`;
}

/** A distinct forwarded client address per call, so no per-IP budget bleeds. */
function freshForwarded(): string {
  const octet = () => String(Math.floor(Math.random() * 254) + 1);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function start(ctx: TestApp, email: string) {
  return ctx.app.inject({
    method: "POST",
    url: "/v1/auth/start",
    headers: { "x-forwarded-for": freshForwarded() },
    payload: { email },
  });
}

interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
}

describe("the gate, on the route where an account comes into being", () => {
  test("admits the address on the list", async () => {
    expect((await start(closed, ADMITTED)).statusCode).toBe(202);
  });

  test("refuses an address that is not on the list", async () => {
    expect((await start(closed, freshAddress())).statusCode).toBe(403);
  });

  test("admits every case variant of the listed address", async () => {
    // The configured entry is upper-cased and none of these match it literally.
    // All of them are the same person in every mail system in service, and
    // refusing the owner because his keyboard capitalised a letter would be a
    // support ticket rather than a control.
    for (const variant of [
      ADMITTED,
      ADMITTED.toUpperCase(),
      ADMITTED.replace("insider", "Insider"),
      ADMITTED.replace("@example.test", "@Example.Test"),
    ]) {
      expect(
        (await start(closed, variant)).statusCode,
        `${JSON.stringify(variant)} was refused`,
      ).toBe(202);
    }
  });

  test("A PADDED ADDRESS NEVER REACHES THE GATE: THE VALIDATOR REJECTS IT FIRST", async () => {
    // MEASURED RATHER THAN ASSUMED, and it changes what the trim in
    // `normaliseAddress` is for. The body schema declares `format: email`, which
    // ajv applies before any `preHandler` runs, so a leading or trailing space is
    // a 400 from the validator and the allowlist is never consulted. That is the
    // right outcome and it is not the one the trim was written for.
    //
    // So be precise about where trimming IS load-bearing, because a reader who
    // saw only this test could reasonably delete it:
    //
    //   THE OPERATOR'S VALUE. `AUTH_REGISTRATION_ALLOWLIST=" a@b.com , c@d.com "`
    //   is exactly what a shell heredoc produces, and every entry there arrives
    //   padded. src/lib/registration-allowlist.test.ts covers it.
    //   THE CALLBACK PATH. That address comes from the identity provider's JSON
    //   rather than from a validated body, so nothing has normalised it.
    //
    // On this route the trim is belt and braces, and a 400 here is not a leak: a
    // malformed body is refused the same way for an admitted address and a refused
    // one, which the second half of this test asserts.
    const padded = await start(closed, `  ${ADMITTED}`);
    expect(padded.statusCode).toBe(400);

    // Identical treatment for a padded address that is NOT on the list, so the
    // validator is not an oracle either.
    const paddedOutsider = await start(closed, `  ${freshAddress("padded")}`);
    expect(paddedOutsider.statusCode).toBe(400);
  });

  test("an empty list admits anyone, so a laptop and launch day both work", async () => {
    // The other half of the argument. If this failed, the gate would be a thing
    // that has to be switched off to develop against, and a control that has to be
    // switched off gets switched off.
    // THE SAME ADDRESS through both applications, which is what makes this a
    // controlled comparison rather than two unrelated assertions: the only
    // difference between the two runs is one environment variable, so the refusal
    // on the left cannot be blamed on anything about the address.
    //
    // A fresh address rather than an admitted one, because the send budgets are
    // counted per address in the SHARED quota Redis: reusing an address this file
    // has already spent on `closed` would come back 429 here and look like the
    // open deployment refusing.
    const stranger = freshAddress("launch-day");
    expect((await start(closed, stranger)).statusCode).toBe(403);
    expect((await start(open, stranger)).statusCode).toBe(202);
  });
});

describe("the refusal leaves no trace of the person it refused", () => {
  test("NO WORKOS USER IS CREATED AND NO CODE IS SENT FOR A REFUSED ADDRESS", async () => {
    // THE ORPHAN-IDENTITY ASSERTION. `magic_auth/send` auto-creates a user for an
    // unknown address AND emails it, so a gate placed after the provider call
    // would create a personal-data record for somebody it then refused and mail a
    // stranger a sign-in code. The hook is `preHandler`, and every path to WorkOS
    // on this route is inside the handler, so the provider is never reached.
    const email = freshAddress("orphan");
    expect((await start(closed, email)).statusCode).toBe(403);
    expect(closed.workos.directory().map((u) => u.email)).not.toContain(email);
    expect(closed.workos.codeFor(email)).toBeNull();
  });

  test("an admitted address DOES reach the provider, so the check above is real", async () => {
    // THE PAIRED POSITIVE CONTROL. Without it the previous test would pass just as
    // well against a stand-in that never created anything for anybody, and the
    // whole assertion would be vacuous.
    expect((await start(closed, ADMITTED)).statusCode).toBe(202);
    expect(closed.workos.directory().map((u) => u.email)).toContain(ADMITTED);
    expect(closed.workos.codeFor(ADMITTED)).not.toBeNull();
  });

  test("a refusal does not spend the send budget", async () => {
    // Run against `tight`, which carries the SHIPPED budgets, because `closed`
    // raises them out of the way and could not observe this.
    //
    // The refusal is upstream of the budgets as well as of the provider, because
    // both live in `requestCode` and the gate is a `preHandler`. If it were not,
    // twelve refusals from one host would exceed the shipped per-IP send max of 10
    // and the last two would come back 429 instead of 403 - which is also the
    // reason this matters beyond tidiness: a stranger must not be able to exhaust
    // a real user's send allowance from a shared address by naming addresses that
    // were never going to be served.
    const forwarded = freshForwarded();
    for (let i = 0; i < 12; i += 1) {
      const res = await tight.app.inject({
        method: "POST",
        url: "/v1/auth/start",
        headers: { "x-forwarded-for": forwarded },
        payload: { email: freshAddress("budget") },
      });
      expect(res.statusCode, `refusal ${String(i)} was not a 403`).toBe(403);
    }

    // The paired control: the budget on that host really is intact, so the loop
    // above proved something. An admitted address from the same host still goes
    // through, which it could not if twelve charges had landed.
    expect(
      (
        await tight.app.inject({
          method: "POST",
          url: "/v1/auth/start",
          headers: { "x-forwarded-for": forwarded },
          payload: { email: ADMITTED_BUDGET },
        })
      ).statusCode,
    ).toBe(202);
  });
});

describe("the response shape, and the oracle it must not be", () => {
  test("is RFC 9457 problem+json and says nothing about the mechanism", async () => {
    const email = freshAddress("shape");
    const res = await start(closed, email);
    expect(res.headers["content-type"]).toContain("application/problem+json");

    const problem = jsonOf<Problem>(res);
    expect(problem.status).toBe(403);
    expect(problem.type).toBe("https://pull.fm/problems/registration-closed");
    expect(problem.title).toBe("Forbidden");
    expect(problem.instance).toBe(res.headers["x-request-id"]);

    // Honest and non-hostile: it says the service is in a closed beta and that
    // nothing happened. The person on the other end has done nothing wrong.
    expect(problem.detail).toMatch(/closed beta/i);
    expect(problem.detail).toMatch(/no account was created/i);

    // And it leaks nothing about the mechanism or about the address, so the
    // refusal cannot be used to probe the control.
    const body = res.body;
    for (const leak of [
      email,
      email.split("@")[0] ?? "",
      ADMITTED,
      "allow",
      "list",
      "invit",
      "@",
    ]) {
      expect(body, `refusal leaked ${leak}`).not.toContain(leak);
    }
  });

  test("A NEAR MISS AND AN UNRELATED ADDRESS GET BYTE-IDENTICAL RESPONSES", async () => {
    // THE ANTI-ORACLE ASSERTION. `other@example.test` shares the admitted
    // address's domain and `nobody@elsewhere.invalid` shares nothing with it. If
    // the two answers differed in status, in headers that describe the outcome, or
    // in one byte of the body, the endpoint would be a way to walk towards the
    // list: change a character, watch the response change, repeat.
    const near = await start(
      closed,
      `other.${randomUUID().slice(0, 8)}@example.test`,
    );
    const far = await start(
      closed,
      `nobody.${randomUUID().slice(0, 8)}@elsewhere.invalid`,
    );

    expect(near.statusCode).toBe(403);
    expect(far.statusCode).toBe(403);
    expect(near.headers["content-type"]).toBe(far.headers["content-type"]);

    // Compared as RAW BYTES rather than as parsed objects, because a difference in
    // key order or in whitespace is just as usable an oracle as a difference in
    // wording. `instance` is the request id, which is unique per request by
    // design and carries no information about the address, so it is the one field
    // replaced rather than compared.
    const canonical = (body: string) =>
      body.replace(/"instance":"[^"]*"/, '"instance":"<request-id>"');
    expect(canonical(near.body)).toBe(canonical(far.body));

    // And the same holds against a THIRD shape: an address whose local part is
    // exactly the admitted one at a different host. This is the probe an attacker
    // who half-knows the list would actually send.
    const sameLocalPart = await start(closed, "insider@elsewhere.invalid");
    expect(sameLocalPart.statusCode).toBe(403);
    expect(canonical(sameLocalPart.body)).toBe(canonical(far.body));
  });

  test("the refusal is not cacheable, so a shared cache cannot answer for us", async () => {
    // Everything in this API defaults to uncacheable (the onSend hook in
    // server.ts). Asserted here because a cached 403 on the sign-in route would
    // outlive the beta and refuse real users after the list was emptied.
    const res = await start(closed, freshAddress("cache"));
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });
});

describe("step two and the hosted callback are gated as well", () => {
  test("POST /auth/verify refuses an address that is not on the list", async () => {
    // `establish()` writes the local `users` row, so a gate that stopped at
    // /auth/start would refuse the code and then complete a registration for
    // anybody holding a code obtained elsewhere.
    //
    // The code here is a REAL, LIVE code, minted for the admitted address, and it
    // is presented alongside a DIFFERENT address. That shape is what makes the
    // assertion meaningful: the request would otherwise fail at the provider for
    // an unrelated reason, and a 401 would look like a pass.
    expect((await start(closed, ADMITTED)).statusCode).toBe(202);
    const code = closed.workos.codeFor(ADMITTED);
    expect(code).not.toBeNull();

    const res = await closed.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      headers: { "x-forwarded-for": freshForwarded() },
      payload: { email: freshAddress("verify"), code, transport: "bearer" },
    });
    // 403, not the 401 a bad code produces. The gate answered, not the provider.
    expect(res.statusCode).toBe(403);

    // AND THE EXCHANGE NEVER HAPPENED. A magic-auth code is single use at WorkOS,
    // so if the refusal had run after the provider call the code would have been
    // consumed. It is still live, which proves nothing reached the provider.
    expect(closed.workos.codeFor(ADMITTED)).toBe(code);
  });

  test("POST /auth/verify completes for the admitted address", async () => {
    // The paired control for the test above: the gate is not simply refusing
    // everything at step two.
    expect((await start(closed, ADMITTED)).statusCode).toBe(202);
    const code = closed.workos.codeFor(ADMITTED);

    const res = await closed.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      headers: { "x-forwarded-for": freshForwarded() },
      payload: { email: ADMITTED, code, transport: "bearer" },
    });
    expect(res.statusCode).toBe(200);
  });

  test("GET /auth/callback refuses an address the provider names", async () => {
    // The hosted flow sends only a `code`, so there is no address for a hook to
    // read and the gate is inside the handler, between the provider call and
    // `establish()`. Late by the standard the other two routes are held to, and
    // the earliest point that exists here. What it still buys: no local users row
    // and no session.
    const outsider = freshAddress("callback");
    closed.workos.register(
      outsider,
      `user_callback_${randomUUID().slice(0, 8)}`,
    );

    const res = await closed.app.inject({
      method: "GET",
      url: `/v1/auth/callback?code=valid_${encodeURIComponent(outsider)}`,
      headers: { "x-forwarded-for": freshForwarded() },
    });
    expect(res.statusCode).toBe(403);
    expect(jsonOf<Problem>(res).type).toBe(
      "https://pull.fm/problems/registration-closed",
    );

    // NO LOCAL ACCOUNT CAME OUT OF IT, which is the property this late gate can
    // still guarantee and the reason it is worth having at all. Asserted against
    // the table rather than through a route, because there is no route that would
    // answer the question without being an oracle itself.
    const { rows } = await closed.services.db.query<{ n: string }>(
      "select count(*)::text as n from users where email = $1",
      [outsider],
    );
    expect(rows[0]?.n).toBe("0");
  });

  test("GET /auth/callback completes for the admitted address", async () => {
    // Paired control again. Without it the refusal above would pass just as well
    // if the callback route were simply broken.
    closed.workos.register(
      ADMITTED_CALLBACK,
      `user_callback_${randomUUID().slice(0, 8)}`,
    );
    const res = await closed.app.inject({
      method: "GET",
      url: `/v1/auth/callback?code=valid_${encodeURIComponent(ADMITTED_CALLBACK)}`,
      headers: { "x-forwarded-for": freshForwarded() },
    });
    expect(res.statusCode).toBe(200);
  });

  test("every refused route returns the same body, so they are one refusal", async () => {
    // Three enforcement points, three different hook positions, ONE refusal. If
    // they diverged, which route refused you would itself be a signal.
    const canonical = (body: string) =>
      body.replace(/"instance":"[^"]*"/, '"instance":"<request-id>"');

    const viaStart = await start(closed, freshAddress("uniform-start"));

    expect((await start(closed, ADMITTED)).statusCode).toBe(202);
    const viaVerify = await closed.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      headers: { "x-forwarded-for": freshForwarded() },
      payload: {
        email: freshAddress("uniform-verify"),
        code: closed.workos.codeFor(ADMITTED),
        transport: "bearer",
      },
    });

    const outsider = freshAddress("uniform-callback");
    closed.workos.register(
      outsider,
      `user_uniform_${randomUUID().slice(0, 8)}`,
    );
    const viaCallback = await closed.app.inject({
      method: "GET",
      url: `/v1/auth/callback?code=valid_${encodeURIComponent(outsider)}`,
      headers: { "x-forwarded-for": freshForwarded() },
    });

    const bodies = [viaStart, viaVerify, viaCallback];
    expect(bodies.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    expect(new Set(bodies.map((r) => canonical(r.body))).size).toBe(1);
  });
});

describe("what is deliberately NOT gated", () => {
  test("refresh still works, and the route cannot even see an address", async () => {
    // NOBODY IS LOCKED OUT BY THIS CHANGE. A session that was legitimately created
    // keeps working; the gate is about FORMING a relationship, not about punishing
    // one that exists. It is also structural rather than a matter of trust: a
    // refresh request carries a token and no address at all, so there is nothing
    // for an address gate to read even if one were attached, which is why no hook
    // is attached to it.
    expect((await start(closed, ADMITTED)).statusCode).toBe(202);
    const verified = await closed.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      headers: { "x-forwarded-for": freshForwarded() },
      payload: {
        email: ADMITTED,
        code: closed.workos.codeFor(ADMITTED),
        transport: "bearer",
      },
    });
    expect(verified.statusCode).toBe(200);
    const { refreshToken } = jsonOf<{ refreshToken: string }>(verified);

    const res = await closed.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { "x-forwarded-for": freshForwarded() },
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);
  });

  test("logout is never refused for a session whose address is NOT on the list", async () => {
    // Refusing a revocation traps a live session open on a device its owner is
    // trying to leave, which is a security defect dressed up as a control. This
    // subject's address is a fresh `example.test` address and is emphatically not
    // the admitted one.
    //
    // The subject comes from `provisionSubject` rather than from a sign-in through
    // the stand-in, for the reason the region suite already records: the stand-in
    // numbers its users deterministically, so a session signed out here would land
    // in the revocation deny list under an id the NEXT run reproduces exactly, in
    // the shared quota Redis, with an hour's TTL. That makes the suite pass once
    // and fail for an hour.
    const subject = await provisionSubject(closed, "allowlist-logout");
    expect(subject.email).not.toBe(ADMITTED);

    const res = await closed.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: {
        "x-forwarded-for": freshForwarded(),
        authorization: `Bearer ${subject.token}`,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test("an existing account whose address is not on the list keeps the API", async () => {
    // The strong form of "nobody is locked out". The gate is on ACCOUNT FORMATION
    // and on nothing else, so a subject who is not on the list still reads their
    // own account. If this failed, the allowlist would have become a traffic block,
    // which is a different product decision that nobody made.
    const subject = await provisionSubject(closed, "allowlist-existing");
    const res = await closed.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${subject.token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("the rest of the API is untouched: this is not a traffic block", async () => {
    const res = await closed.app.inject({ method: "GET", url: "/v1/config" });
    expect(res.statusCode).toBe(200);
  });
});
