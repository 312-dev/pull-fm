/**
 * WorkOS webhook signature verification (THREAT-MODEL T20 / M19).
 *
 * This is the highest-severity unit test in the repository. The route it
 * covers is unauthenticated by definition, published in the public API
 * surface, and handles `user.deleted`, which cascades through the credential
 * vault via ON DELETE CASCADE. If verification is wrong, the endpoint is an
 * unauthenticated mass-deletion service.
 *
 * A happy-path test proves nothing here. Every test below is a forgery attempt.
 */

import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  parseSignatureHeader,
  REPLAY_WINDOW_MS,
  verifySignature,
} from "./webhooks.js";

const SECRET = "whsec_unit_test_secret";
const NOW = 1_800_000_000_000;

function sign(
  body: Buffer | string,
  timestampMs: number,
  secret = SECRET,
): string {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const mac = createHmac("sha256", secret)
    .update(`${String(timestampMs)}.`, "utf8")
    .update(buf)
    .digest("hex");
  return `t=${String(timestampMs)}, v1=${mac}`;
}

describe("signature header parsing", () => {
  test("parses the documented WorkOS shape", () => {
    expect(parseSignatureHeader("t=1700000000000, v1=abcdef")).toEqual({
      timestampMs: 1_700_000_000_000,
      signature: "abcdef",
    });
  });

  test("upconverts a timestamp expressed in seconds", () => {
    // A provider changing units must not present as "every webhook is a
    // replay" at 3am. The window check supplies the security property either
    // way, so leniency here is free.
    expect(parseSignatureHeader("t=1700000000, v1=ab")?.timestampMs).toBe(
      1_700_000_000_000,
    );
  });

  test("rejects a non-hex signature", () => {
    expect(parseSignatureHeader("t=1700000000000, v1=zzzz")).toBeNull();
  });

  test("rejects a header missing either component", () => {
    expect(parseSignatureHeader("t=1700000000000")).toBeNull();
    expect(parseSignatureHeader("v1=abcdef")).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
  });

  test("rejects a non-numeric or negative timestamp", () => {
    expect(parseSignatureHeader("t=nope, v1=ab")).toBeNull();
    expect(parseSignatureHeader("t=-1, v1=ab")).toBeNull();
  });
});

describe("verification", () => {
  const body = Buffer.from(
    '{"id":"event_01","event":"user.deleted","data":{"id":"user_01"}}',
    "utf8",
  );

  test("accepts a correctly signed, current delivery", () => {
    expect(verifySignature(body, sign(body, NOW), SECRET, NOW)).toEqual({
      ok: true,
    });
  });

  test("rejects a missing header", () => {
    expect(verifySignature(body, undefined, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a signature computed with a different secret", () => {
    const forged = sign(body, NOW, "whsec_attacker_guess");
    expect(verifySignature(body, forged, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a signature over a DIFFERENT body", () => {
    const other = Buffer.from('{"event":"user.deleted","data":{"id":"x"}}');
    expect(verifySignature(body, sign(other, NOW), SECRET, NOW).ok).toBe(false);
  });

  test("rejects a body whose timestamp was swapped", () => {
    // The timestamp is inside the signed message, so it cannot be edited by an
    // attacker without invalidating the MAC. This proves that binding holds.
    const header = sign(body, NOW).replace(
      `t=${String(NOW)}`,
      `t=${String(NOW + 1000)}`,
    );
    expect(verifySignature(body, header, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a replay outside the five minute window", () => {
    const stale = NOW - REPLAY_WINDOW_MS - 1;
    const result = verifySignature(body, sign(body, stale), SECRET, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("replay window");
  });

  test("accepts a delivery at the edge of the window, in both directions", () => {
    const past = NOW - (REPLAY_WINDOW_MS - 1000);
    const future = NOW + (REPLAY_WINDOW_MS - 1000);
    expect(verifySignature(body, sign(body, past), SECRET, NOW).ok).toBe(true);
    // Future timestamps are accepted within the window because a small clock
    // skew between us and the provider is normal and must not drop deliveries.
    expect(verifySignature(body, sign(body, future), SECRET, NOW).ok).toBe(
      true,
    );
  });

  test("verifies over the RAW bytes, not a re-serialised object", () => {
    // The failure this defends against: `JSON.parse` then `JSON.stringify`
    // reorders keys and normalises escapes, so a signature computed over the
    // round-tripped body verifies almost always. Almost always is the worst
    // possible outcome, because it passes in testing and fails in production on
    // the one payload whose formatting differs.
    const raw = Buffer.from('{"b":1,"a":2,"c":1.0}', "utf8");
    const header = sign(raw, NOW);
    expect(verifySignature(raw, header, SECRET, NOW).ok).toBe(true);

    const roundTripped = Buffer.from(
      JSON.stringify(JSON.parse(raw.toString("utf8"))),
      "utf8",
    );
    expect(roundTripped.equals(raw)).toBe(false);
    expect(verifySignature(roundTripped, header, SECRET, NOW).ok).toBe(false);
  });

  test("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch if it is called naively; the
    // wrapper must compare lengths first. A throw here would be a 500 on a
    // route that must answer 401.
    expect(
      verifySignature(body, `t=${String(NOW)}, v1=ab`, SECRET, NOW).ok,
    ).toBe(false);
  });

  test("an empty body still has to be signed", () => {
    const empty = Buffer.alloc(0);
    expect(verifySignature(empty, sign(empty, NOW), SECRET, NOW).ok).toBe(true);
    expect(verifySignature(empty, sign(body, NOW), SECRET, NOW).ok).toBe(false);
  });
});
