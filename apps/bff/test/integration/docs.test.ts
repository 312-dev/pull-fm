/**
 * The API reference browser is self-hosted, and this test is what keeps it that
 * way.
 *
 * The failure mode being defended against is specific: a future version of the
 * reference plugin defaults back to a CDN, the page keeps working in
 * development because a browser can reach the CDN, and it renders blank in
 * production because the Content-Security-Policy forbids external hosts. A
 * grep for external URLs in the served HTML catches that on the commit that
 * introduces it.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";

import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import { buildServices, closeServices } from "../../src/wiring.js";
import type { Services } from "../../src/routes/deps.js";
import { testDatabaseUrl } from "../helpers/database.js";

let app: FastifyInstance;
let services: Services;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: "test",
    DEPLOY_ENV: "local",
    LOG_LEVEL: "silent",
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379",
    REDIS_QUOTA_URL: process.env["REDIS_QUOTA_URL"] ?? "redis://127.0.0.1:6380",
    CREDENTIAL_KEKS: `kek:docs=${Buffer.alloc(32, 1).toString("base64")}`,
    CREDENTIAL_ACTIVE_KEK_ID: "kek:docs",
    WORKOS_CLIENT_ID: "client_docs",
    WORKOS_API_KEY: "sk_test_docs_only",
    MUSICBRAINZ_USER_AGENT: "PullFM/0.1.0 (docs@pull.fm)",
  });
  services = buildServices(cfg, {
    error: () => undefined,
    warn: () => undefined,
  });
  app = await buildServer(cfg, { services, enableDocsBrowser: true });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await closeServices(services);
});

describe("the reference browser", () => {
  test("renders and references no external host", async () => {
    const page = await app.inject({ method: "GET", url: "/docs/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");

    const external = [...page.body.matchAll(/https?:\/\/[^"'\s)]+/g)].map(
      (m) => m[0],
    );
    expect(
      external,
      `the reference page loads from an external host: ${external.join(", ")}`,
    ).toEqual([]);
  });

  test("serves its own JavaScript bundle from this origin", async () => {
    const js = await app.inject({ method: "GET", url: "/docs/js/scalar.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    // A stub would be a few hundred bytes; the real bundle is megabytes.
    expect(js.body.length).toBeGreaterThan(500_000);
  });

  test("carries a CSP scoped to the documentation prefix", async () => {
    const page = await app.inject({ method: "GET", url: "/docs/" });
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No external origin is permitted even by the relaxed policy.
    expect(csp).not.toMatch(/https?:\/\//);

    // And the relaxation does not escape its prefix: the API keeps default-src
    // 'none' with no script-src at all.
    const api = await app.inject({ method: "GET", url: "/v1/config" });
    const apiCsp = String(api.headers["content-security-policy"]);
    expect(apiCsp).toContain("default-src 'none'");
    expect(apiCsp).not.toContain("unsafe-inline");
  });

  test("serves the document itself", async () => {
    for (const url of ["/openapi.json", "/docs/openapi.json"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} did not serve the document`).toBe(200);
      expect(res.body).toContain('"openapi"');
      expect(res.body).toContain("x-pullfm-authz");
    }
  });
});
