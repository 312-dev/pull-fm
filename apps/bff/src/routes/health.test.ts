/**
 * Who may scrape `/metrics`.
 *
 * The origin's nginx serves `location /` to the edge, so this endpoint is
 * internet-facing by default. It stopped being harmless the moment it stopped
 * being a stub, and the control that replaced "it is only a stub" is asserted
 * here rather than described.
 *
 * The specific trap under test is the one that makes an IP allowlist useless
 * behind a proxy: `trustProxy` is on, so `req.ip` is the leftmost
 * `X-Forwarded-For` value and is attacker-controlled. The check must use the
 * TCP peer address, which an HTTP header cannot influence.
 */

import { describe, expect, test } from "vitest";

import { metricsAllowed } from "./health.js";

const TOKEN = "s3cret-scrape-token";

describe("metricsAllowed", () => {
  test("allows a loopback peer with no credential", () => {
    // This is how the node-local watchdog scrapes: no token to distribute, no
    // token to leak, and it stops working the moment the caller is not on the
    // node.
    expect(metricsAllowed("127.0.0.1", undefined, "")).toBe(true);
    expect(metricsAllowed("::1", undefined, "")).toBe(true);
    expect(metricsAllowed("::ffff:127.0.0.1", undefined, "")).toBe(true);
    expect(metricsAllowed("127.0.0.53", undefined, "")).toBe(true);
  });

  test("refuses a non-loopback peer with no token configured", () => {
    expect(metricsAllowed("203.0.113.9", undefined, "")).toBe(false);
    expect(metricsAllowed("10.20.1.10", undefined, "")).toBe(false);
  });

  test("refuses an undefined peer address", () => {
    expect(metricsAllowed(undefined, undefined, "")).toBe(false);
  });

  test("accepts the exact bearer token", () => {
    expect(metricsAllowed("203.0.113.9", `Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test("refuses a wrong, short, long or prefix-matching token", () => {
    expect(metricsAllowed("203.0.113.9", "Bearer nope", TOKEN)).toBe(false);
    expect(metricsAllowed("203.0.113.9", `Bearer ${TOKEN}x`, TOKEN)).toBe(
      false,
    );
    expect(
      metricsAllowed("203.0.113.9", `Bearer ${TOKEN.slice(0, -1)}`, TOKEN),
    ).toBe(false);
  });

  test("refuses a non-bearer scheme", () => {
    expect(metricsAllowed("203.0.113.9", `Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(metricsAllowed("203.0.113.9", TOKEN, TOKEN)).toBe(false);
  });

  test("an empty configured token never authorises anything", () => {
    // Otherwise a deployment that forgot to set METRICS_TOKEN would accept
    // `Authorization: Bearer ` from anyone.
    expect(metricsAllowed("203.0.113.9", "Bearer ", "")).toBe(false);
    expect(metricsAllowed("203.0.113.9", "Bearer", "")).toBe(false);
    expect(metricsAllowed("203.0.113.9", undefined, undefined)).toBe(false);
  });
});
