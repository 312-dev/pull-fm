/**
 * Cacheability of every response, asserted rather than assumed.
 *
 * WHY THIS FILE EXISTS
 *
 * The first ZAP baseline ever executed against staging (2026-07-29) raised rule
 * 10015, "Re-examine Cache-control Directives", on GET /v1/me, GET
 * /v1/connections, GET /v1/config, /healthz and /readyz. Every one answered 200
 * with no `Cache-Control` header at all.
 *
 * That was not news to the repository. `security/zap/rules/alert-filters.yaml`
 * had already written the finding down as a true positive: "every authenticated
 * response is per-user data and must be `Cache-Control: no-store`. A shared
 * cache holding a /v1/feed or /v1/me body is a cross-subject disclosure." And
 * `security/zap/rules/baseline-rules.tsv` grades 10015 as FAIL. The intent was
 * recorded in two places and implemented in one: `routes/v1/product.ts` has a
 * local `personalised()` helper, so the catalogue routes were covered and the
 * account, token, connection and wishlist routes were not.
 *
 * THE EXPLOITATION, because "missing header" undersells it. THREAT-MODEL T12.
 * A response with no `Cache-Control` is heuristically cacheable by any
 * intermediary between the origin and the user: a corporate forward proxy, a
 * carrier transcoder, an ISP cache, a shared browser profile. GET /v1/me
 * carries an email address and GET /v1/connections describes which third-party
 * accounts a person has linked. Two users behind the same proxy is all it takes
 * for one of them to be served the other's body, and no control we own is in
 * the request path when it happens.
 *
 * The fix is a default in `server.ts`, not another per-route call, because a
 * per-handler opt-in is the kind of control a new route silently misses. These
 * tests are the proof that the default is on and that it is a DEFAULT rather
 * than an override: a route that has deliberately chosen a cacheable policy
 * must keep it.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { provisionSubject, type Subject } from "../helpers/subjects.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const auth = (s: Subject) => ({ authorization: `Bearer ${s.token}` });

/**
 * Routes whose bodies are scoped to one subject, or whose freshness is the
 * whole point. Listed explicitly rather than derived, because the value of this
 * test is that somebody wrote down what must not be cached.
 */
const MUST_NOT_BE_CACHED = [
  "/v1/me",
  "/v1/connections",
  "/v1/wishlist",
  "/v1/tokens",
] as const;

describe("Cache-Control", () => {
  test.each(MUST_NOT_BE_CACHED)(
    "%s is not storable by a shared cache",
    async (url) => {
      const s = await provisionSubject(ctx, "cc");
      const res = await ctx.app.inject({
        method: "GET",
        url,
        headers: auth(s),
      });
      expect(res.statusCode).toBe(200);

      const header = res.headers["cache-control"];
      expect(header, `${url} sent no Cache-Control at all`).toBeDefined();
      expect(String(header)).toContain("no-store");
      // `private` as well, so an intermediary that predates `no-store` still
      // refuses to hold it. The response may cross Cloudflare and an arbitrary
      // corporate proxy before it reaches a phone.
      expect(String(header)).toContain("private");
    },
  );

  test("unauthenticated platform responses are also uncacheable", async () => {
    for (const url of ["/healthz", "/readyz", "/v1/config"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(
        String(res.headers["cache-control"]),
        `${url} sent no Cache-Control`,
      ).toContain("no-store");
    }
  });

  test("a 404 problem response is uncacheable too", async () => {
    // A cached 404 for a resource that later exists is a correctness bug, and a
    // cached problem body carries a request id belonging to somebody else.
    const res = await ctx.app.inject({ method: "GET", url: "/no-such-route" });
    expect(res.statusCode).toBe(404);
    expect(String(res.headers["cache-control"])).toContain("no-store");
  });

  test("a 401 is uncacheable, so a denial is never replayed as an answer", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["cache-control"])).toContain("no-store");
  });

  /**
   * The other direction, and the reason this is a default rather than a blanket
   * rewrite. Catalogue reads are shared, immutable-ish, and expensive to
   * produce under a 1 req/s upstream ceiling, so they set their own policy and
   * must keep it. A hook that clobbered these would quietly convert a cache hit
   * into upstream egress, which is the failure this project can least afford.
   */
  test("a route that chose its own policy keeps it", async () => {
    const s = await provisionSubject(ctx, "cc-pub");
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/search?q=nonexistent-artist-for-cache-header-test",
      headers: auth(s),
    });
    expect(res.statusCode).toBe(200);
    const header = String(res.headers["cache-control"]);
    expect(header).toContain("max-age");
    expect(header).not.toContain("no-store");
  });
});
