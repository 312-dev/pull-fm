/**
 * The EEA / UK / Switzerland registration refusal, against a real application.
 *
 * src/lib/registration-geo.test.ts proves the DECISION is right across the
 * whole country list and every peer and header shape. This file proves the
 * decision is actually WIRED to the routes that form an account, that it runs
 * early enough to matter, and that the things it must NOT touch still work.
 *
 * Two assertions here carry more weight than the rest:
 *
 *   THE FORGED HEADER. `curl -H 'CF-IPCountry: US'` from a peer that is not the
 *   origin ingress must not get through. If that fails, nothing else in this
 *   file means anything, because the entire block is one header away from being
 *   optional.
 *
 *   THE ORPHAN IDENTITY. POST /v1/auth/start CREATES A WORKOS USER for whatever
 *   address it is handed - that is documented on the route and reproduced by the
 *   provider stand-in. A refusal that ran a moment too late would leave a
 *   personal-data record, at a processor, for a person we had just refused to
 *   serve. Asserting the country block is not enough; the directory has to be
 *   asserted empty afterwards.
 *
 * TWO APPLICATIONS ARE BUILT, and the difference between them is the posture,
 * not a test switch. `enforcing` runs DEPLOY_ENV=staging, which is what a real
 * deployment behind Cloudflare and the origin nginx runs. `local` runs the
 * harness default, which is what a laptop runs. Asserting both is the only way
 * to show that the fail-closed half does not break development and the
 * fail-open half is not a bypass.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { RESTRICTED_COUNTRIES } from "../../src/lib/registration-geo.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";
import { provisionSubject } from "../helpers/subjects.js";

/** Behind Cloudflare: the country header is required and failures close. */
let enforcing: TestApp;
/** A developer's laptop: no edge in front, so an absent header is normal. */
let local: TestApp;

beforeAll(async () => {
  [enforcing, local] = await Promise.all([
    // DEPLOY_ENV is the switch. There is no dedicated geo-block variable to set
    // wrong, which is the point of deriving the posture from the deployment.
    buildTestApp({ env: { DEPLOY_ENV: "staging" } }),
    buildTestApp(),
  ]);
}, 120_000);

afterAll(async () => {
  await Promise.all([enforcing.close(), local.close()]);
});

/** A fresh address per call: both send budgets are keyed on the address. */
function freshAddress(label = "geo"): string {
  return `${label}.${randomUUID().slice(0, 12)}@example.test`;
}

/** A distinct forwarded client address per call, so no per-IP budget bleeds. */
function freshForwarded(): string {
  const octet = () => String(Math.floor(Math.random() * 254) + 1);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface StartOptions {
  readonly country?: string;
  /** The TCP peer. Defaults to the origin ingress, as a proxied request is. */
  readonly peer?: string;
}

function start(ctx: TestApp, email: string, opts: StartOptions = {}) {
  const headers: Record<string, string> = {
    "x-forwarded-for": freshForwarded(),
  };
  if (opts.country !== undefined) headers["cf-ipcountry"] = opts.country;
  return ctx.app.inject({
    method: "POST",
    url: "/v1/auth/start",
    remoteAddress: opts.peer ?? "172.18.0.1",
    headers,
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

describe("the refusal, on the route that forms the account", () => {
  test("refuses a representative EEA country", async () => {
    // Ireland: an EU member state, so the case a naive list gets right.
    const res = await start(enforcing, freshAddress(), { country: "IE" });
    expect(res.statusCode).toBe(451);
  });

  test("refuses an EEA country that is not an EU member state", async () => {
    // Norway. The case a list built from an EU membership table misses, and the
    // GDPR reaches it through the EEA Agreement all the same.
    expect(
      (await start(enforcing, freshAddress(), { country: "NO" })).statusCode,
    ).toBe(451);
  });

  test("refuses GB, which no EU or EEA list contains", async () => {
    expect(
      (await start(enforcing, freshAddress(), { country: "GB" })).statusCode,
    ).toBe(451);
  });

  test("refuses CH, which is in neither the EU nor the EEA", async () => {
    expect(
      (await start(enforcing, freshAddress(), { country: "CH" })).statusCode,
    ).toBe(451);
  });

  test("allows the United States", async () => {
    const res = await start(enforcing, freshAddress(), { country: "US" });
    expect(res.statusCode).toBe(202);
  });

  test("every listed country is refused by the live route", async () => {
    // Derived from the constant the route enforces, so the two cannot drift.
    // Run against the routed application rather than the resolver, because the
    // failure this catches is a hook attached to the wrong route.
    const results = await Promise.all(
      [...RESTRICTED_COUNTRIES].map(async (country) => ({
        country,
        status: (await start(enforcing, freshAddress(), { country }))
          .statusCode,
      })),
    );
    for (const { country, status } of results) {
      expect(status, `${country} was not refused`).toBe(451);
    }
  });
});

describe("the refusal leaves no record of the person it refused", () => {
  test("no WorkOS directory record is created for a refused address", async () => {
    // THE ORPHAN-IDENTITY ASSERTION. `magic_auth/send` auto-creates a user for
    // an unknown address, so a block placed after the provider call would
    // create a personal-data record for somebody it then refused to serve. The
    // hook is onRequest, so the provider is never reached at all.
    const email = freshAddress("orphan");
    expect((await start(enforcing, email, { country: "DE" })).statusCode).toBe(
      451,
    );
    expect(enforcing.workos.directory().map((u) => u.email)).not.toContain(
      email,
    );
    expect(enforcing.workos.codeFor(email)).toBeNull();
  });

  test("an allowed address does reach the provider, so the check above is real", async () => {
    // The control assertion. Without it, the previous test would pass equally
    // well if the stand-in never created anything for anybody.
    const email = freshAddress("allowed");
    expect((await start(enforcing, email, { country: "US" })).statusCode).toBe(
      202,
    );
    expect(enforcing.workos.directory().map((u) => u.email)).toContain(email);
  });
});

describe("the response shape", () => {
  test("is RFC 9457 problem+json and says nothing about the mechanism", async () => {
    const res = await start(enforcing, freshAddress(), { country: "FR" });
    expect(res.headers["content-type"]).toContain("application/problem+json");

    const problem = jsonOf<Problem>(res);
    expect(problem.status).toBe(451);
    expect(problem.type).toBe("https://pull.fm/problems/region-unavailable");
    expect(problem.title).toBe("Unavailable For Legal Reasons");
    expect(problem.instance).toBe(res.headers["x-request-id"]);

    const body = res.body;
    // Honest and non-hostile: it says the service is not offered here.
    expect(problem.detail).toMatch(/not offered in your region/i);
    // And it leaks nothing about HOW that was determined. No country, no
    // header name, no mention of an address or a provider, so the refusal
    // cannot be used to probe the control.
    for (const leak of [
      "FR",
      "cf-ipcountry",
      "Cloudflare",
      "IP",
      "GDPR",
      "EEA",
      "header",
    ]) {
      expect(body, `refusal leaked ${leak}`).not.toContain(leak);
    }
  });

  test("every refusal branch returns the identical body", async () => {
    // A restricted country, an undetermined one and an unverified peer must be
    // indistinguishable to the caller, or the difference between them becomes
    // the oracle.
    const bodies = await Promise.all([
      start(enforcing, freshAddress(), { country: "DE" }),
      start(enforcing, freshAddress(), { country: "T1" }),
      start(enforcing, freshAddress()),
      start(enforcing, freshAddress(), { country: "US", peer: "203.0.113.9" }),
    ]);
    const details = bodies.map((r) => {
      const { instance: _instance, ...rest } = jsonOf<Problem>(r);
      return JSON.stringify(rest);
    });
    expect(bodies.map((r) => r.statusCode)).toEqual([451, 451, 451, 451]);
    expect(new Set(details).size).toBe(1);
  });
});

describe("what the header is worth, and to whom", () => {
  test("A FORGED HEADER FROM A NON-CLOUDFLARE PEER DOES NOT BYPASS THE BLOCK", async () => {
    // The test that matters most. A public TCP source address means the request
    // did not traverse the nginx that proves the peer is a Cloudflare edge
    // node, so `CF-IPCountry: US` is never read, never compared, and buys
    // nothing. The peer address is a property of the connection; no header can
    // change it.
    const res = await start(enforcing, freshAddress(), {
      country: "US",
      peer: "203.0.113.9",
    });
    expect(res.statusCode).toBe(451);
  });

  test("a forged X-Forwarded-For does not launder the peer either", async () => {
    // `trustProxy` is on, so `request.ip` is whatever the caller writes here.
    // The check reads the socket instead, which is exactly why this fails.
    const res = await enforcing.app.inject({
      method: "POST",
      url: "/v1/auth/start",
      remoteAddress: "203.0.113.9",
      headers: { "cf-ipcountry": "US", "x-forwarded-for": "127.0.0.1" },
      payload: { email: freshAddress() },
    });
    expect(res.statusCode).toBe(451);
  });

  test("the header absent on an enforcing deployment fails closed", async () => {
    // Behind Cloudflare the header is always present. Its absence means the
    // control is broken or circumvented, and neither is a reason to serve.
    expect((await start(enforcing, freshAddress())).statusCode).toBe(451);
  });

  test("XX and T1 fail closed, so Tor is not the way around the list", async () => {
    expect(
      (await start(enforcing, freshAddress(), { country: "XX" })).statusCode,
    ).toBe(451);
    expect(
      (await start(enforcing, freshAddress(), { country: "T1" })).statusCode,
    ).toBe(451);
  });

  test("the header absent on a local deployment is allowed", async () => {
    // The other half of the argument. If this failed, `pnpm test` and every
    // laptop would refuse every sign-in, and the control would get switched
    // off rather than fixed.
    expect((await start(local, freshAddress())).statusCode).toBe(202);
  });

  test("a local deployment still honours a header, but only restrictively", async () => {
    // A supplied header off the enforcing path can make the answer stricter and
    // never looser, which is what makes honouring it safe.
    expect(
      (await start(local, freshAddress(), { country: "DE" })).statusCode,
    ).toBe(451);
    expect(
      (
        await start(local, freshAddress(), {
          country: "US",
          peer: "203.0.113.9",
        })
      ).statusCode,
    ).toBe(202);
  });
});

describe("step two is blocked as well, and the rest of auth is not", () => {
  /** Completes a real sign-in from an allowed country. */
  async function signIn(email: string): Promise<{ refreshToken: string }> {
    expect((await start(enforcing, email, { country: "US" })).statusCode).toBe(
      202,
    );
    const code = enforcing.workos.codeFor(email);
    expect(code).not.toBeNull();

    const res = await enforcing.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      remoteAddress: "172.18.0.1",
      headers: { "cf-ipcountry": "US", "x-forwarded-for": freshForwarded() },
      payload: { email, code, transport: "bearer" },
    });
    expect(res.statusCode).toBe(200);
    return jsonOf<{ refreshToken: string }>(res);
  }

  test("POST /auth/verify refuses a restricted region", async () => {
    // `establish()` writes the local users row, so a block that stopped at
    // /auth/start would still let a code obtained elsewhere finish the job.
    const email = freshAddress("verify");
    expect((await start(enforcing, email, { country: "US" })).statusCode).toBe(
      202,
    );
    const code = enforcing.workos.codeFor(email);

    const res = await enforcing.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      remoteAddress: "172.18.0.1",
      headers: { "cf-ipcountry": "DE", "x-forwarded-for": freshForwarded() },
      payload: { email, code, transport: "bearer" },
    });
    expect(res.statusCode).toBe(451);
  });

  test("GET /auth/callback refuses a restricted region", async () => {
    const res = await enforcing.app.inject({
      method: "GET",
      url: "/v1/auth/callback?code=whatever",
      remoteAddress: "172.18.0.1",
      headers: { "cf-ipcountry": "GB", "x-forwarded-for": freshForwarded() },
    });
    expect(res.statusCode).toBe(451);
  });

  test("an existing account is not locked out: refresh still works", async () => {
    // NOBODY IS LOCKED OUT BY THIS CHANGE. The refusal is about forming a new
    // relationship, so an account that already exists keeps its session even
    // when the holder is travelling in a listed country. Refusing here would be
    // a lockout dressed up as a legal position.
    const { refreshToken } = await signIn(freshAddress("existing"));

    const res = await enforcing.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      remoteAddress: "172.18.0.1",
      headers: { "cf-ipcountry": "DE", "x-forwarded-for": freshForwarded() },
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);
  });

  test("logout is never refused, because trapping a session open is worse", async () => {
    // The subject comes from `provisionSubject` rather than from a sign-in
    // through the provider stand-in, and that is not a shortcut. The stand-in
    // numbers its users deterministically (`user_autocreated_1`), so a session
    // signed out here lands in the revocation deny list under a session id that
    // the NEXT run of this file reproduces exactly - and that list lives in the
    // shared quota Redis with an hour's TTL. Signing out through the stub makes
    // the suite pass once and then fail for an hour. `provisionSubject` mints a
    // session id containing a UUID, so the revocation is unique to the run.
    const subject = await provisionSubject(enforcing, "georegion-logout");

    const res = await enforcing.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      remoteAddress: "172.18.0.1",
      headers: {
        "cf-ipcountry": "DE",
        "x-forwarded-for": freshForwarded(),
        authorization: `Bearer ${subject.token}`,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test("the rest of the API is untouched: this is not a traffic block", async () => {
    // The obligation attaches to holding a person's data, and the account is
    // where that relationship forms. A catalogue read is not one, and refusing
    // every request would be a product decision nobody made.
    const res = await enforcing.app.inject({
      method: "GET",
      url: "/v1/config",
      remoteAddress: "172.18.0.1",
      headers: { "cf-ipcountry": "DE" },
    });
    expect(res.statusCode).toBe(200);
  });
});
