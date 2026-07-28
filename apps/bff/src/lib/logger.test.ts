/**
 * Gate 3: proves no plaintext credential reaches a log sink.
 *
 * This runs the real server against a real pino instance writing to a capture
 * stream, then asserts on the emitted bytes. Asserting on the redaction config
 * would only prove the config says what it says; asserting on output proves the
 * pipeline actually behaves.
 */

import { describe, expect, it } from "vitest";
import { pino, type Logger } from "pino";
import { Writable } from "node:stream";

import { loggerOptions } from "./logger.js";

/** Collects everything written, so tests can assert on raw emitted bytes. */
function captureLogger(): { logger: Logger; output: () => string } {
  let buffer = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      buffer += String(chunk);
      cb();
    },
  });
  const logger = pino(
    {
      ...loggerOptions({
        level: "trace",
        isProduction: false,
        deployEnv: "test",
      }),
    },
    sink,
  );
  return { logger, output: () => buffer };
}

const SECRET = "lastfm_session_key_SHOULD_NEVER_APPEAR";

describe("credential redaction", () => {
  it("redacts per-user tokens at the top level", () => {
    const { logger, output } = captureLogger();
    logger.info({ accessToken: SECRET, sessionKey: SECRET }, "connected");
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain("[REDACTED]");
  });

  it("redacts tokens nested inside an object", () => {
    const { logger, output } = captureLogger();
    logger.info(
      { conn: { accessToken: SECRET, refreshToken: SECRET } },
      "refreshed",
    );
    expect(output()).not.toContain(SECRET);
  });

  it("redacts snake_case variants, which upstream APIs actually return", () => {
    const { logger, output } = captureLogger();
    logger.info(
      { resp: { access_token: SECRET, refresh_token: SECRET } },
      "upstream",
    );
    expect(output()).not.toContain(SECRET);
  });

  it("redacts envelope key material", () => {
    const { logger, output } = captureLogger();
    logger.info(
      { vault: { dek: SECRET, wrappedDek: SECRET, kek: SECRET } },
      "sealed",
    );
    expect(output()).not.toContain(SECRET);
  });

  it("redacts application secrets", () => {
    const { logger, output } = captureLogger();
    logger.info(
      { cfg: { apiKey: SECRET, apiSecret: SECRET, clientSecret: SECRET } },
      "cfg",
    );
    expect(output()).not.toContain(SECRET);
  });
});

describe("request serialization", () => {
  // The Authorization header is the single most common accidental credential
  // leak in a backend that talks to per-user upstreams.
  it("never logs the Authorization header", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: {
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer ${SECRET}`, cookie: `s=${SECRET}` },
        },
      },
      "incoming request",
    );
    expect(output()).not.toContain(SECRET);
    expect(output()).not.toContain("Bearer");
  });

  it("strips the query string, which can carry a token or a search term", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: {
          method: "GET",
          url: `/v1/search?q=private&token=${SECRET}`,
          headers: {},
        },
      },
      "incoming request",
    );
    expect(output()).not.toContain(SECRET);
    expect(output()).not.toContain("q=private");
    // The path itself is still logged, or the logs are useless for debugging.
    expect(output()).toContain("/v1/search");
  });

  it("keeps the fields needed to investigate abuse", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: {
          id: "req-1",
          method: "GET",
          url: "/v1/feed",
          ip: "203.0.113.9",
          headers: { "user-agent": "curl/8" },
        },
      },
      "incoming request",
    );
    const line = output();
    expect(line).toContain("203.0.113.9");
    expect(line).toContain("curl/8");
    expect(line).toContain("req-1");
  });
});

describe("error serialization", () => {
  it("does not leak credentials attached to an error by an HTTP client", () => {
    // Upstream clients routinely attach the full request, including headers, to
    // a thrown error. The default pino error serializer would emit all of it.
    const { logger, output } = captureLogger();
    const err = new Error("upstream request failed") as Error & {
      request?: unknown;
      config?: unknown;
    };
    err.request = { headers: { authorization: `Bearer ${SECRET}` } };
    err.config = { headers: { authorization: `Bearer ${SECRET}` } };

    logger.error({ err }, "upstream error");

    expect(output()).not.toContain(SECRET);
    // The useful part survives.
    expect(output()).toContain("upstream request failed");
  });

  it("retains the stack, which is safe and necessary", () => {
    const { logger, output } = captureLogger();
    logger.error({ err: new Error("boom") }, "failed");
    expect(output()).toContain("stack");
  });
});
