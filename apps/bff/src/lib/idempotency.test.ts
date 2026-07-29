/**
 * Idempotency-Key handling (THREAT-MODEL T14 / M13).
 *
 * The cross-subject replay case runs against a real database in the BOLA
 * suite, because the property that defends against it is the composite primary
 * key. These tests cover the request fingerprint, which is what distinguishes
 * "the same request, retried" from "a different request reusing a key".
 */

import { randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import { ApiError } from "./errors.js";
import { fingerprint, requireIdempotencyKey } from "./idempotency.js";

describe("key validation", () => {
  test("requires the header", () => {
    for (const value of [undefined, "", null, 42]) {
      expect(() => requireIdempotencyKey(value)).toThrow(ApiError);
    }
  });

  test("accepts a UUID, which is what clients will send", () => {
    const value = randomUUID();
    expect(requireIdempotencyKey(value)).toBe(value);
  });

  test("rejects shapes that invite accidental collisions", () => {
    expect(() => requireIdempotencyKey("short")).toThrow(/8 to 255/);
    expect(() => requireIdempotencyKey("x".repeat(256))).toThrow(/8 to 255/);
    expect(() => requireIdempotencyKey("has spaces here")).toThrow(/8 to 255/);
  });
});

describe("request fingerprint", () => {
  test("is stable across property order", () => {
    // Two semantically identical bodies that differ only in key order must not
    // look like different requests, or a client that serialises differently on
    // retry gets a 409 for a retry that should have been idempotent.
    expect(fingerprint("POST", "/v1/wishlist", { a: 1, b: 2 })).toBe(
      fingerprint("POST", "/v1/wishlist", { b: 2, a: 1 }),
    );
  });

  test("is stable across nesting order and array contents order matters", () => {
    expect(fingerprint("POST", "/x", { outer: { a: 1, b: [1, 2] } })).toBe(
      fingerprint("POST", "/x", { outer: { b: [1, 2], a: 1 } }),
    );
    expect(fingerprint("POST", "/x", { a: [1, 2] })).not.toBe(
      fingerprint("POST", "/x", { a: [2, 1] }),
    );
  });

  test("changes when the body changes", () => {
    expect(fingerprint("POST", "/v1/wishlist", { a: 1 })).not.toBe(
      fingerprint("POST", "/v1/wishlist", { a: 2 }),
    );
  });

  test("changes when the route or method changes", () => {
    // Without this, one key reused across two different operations would return
    // the first operation's response for the second.
    expect(fingerprint("POST", "/v1/wishlist", {})).not.toBe(
      fingerprint("POST", "/v1/tokens", {}),
    );
    expect(fingerprint("POST", "/v1/wishlist", {})).not.toBe(
      fingerprint("DELETE", "/v1/wishlist", {}),
    );
  });

  test("treats an absent property and an undefined property alike", () => {
    expect(fingerprint("POST", "/x", { a: 1 })).toBe(
      fingerprint("POST", "/x", { a: 1, b: undefined }),
    );
  });

  test("distinguishes null from absent", () => {
    expect(fingerprint("POST", "/x", { a: 1 })).not.toBe(
      fingerprint("POST", "/x", { a: 1, b: null }),
    );
  });

  test("handles a missing body", () => {
    expect(fingerprint("POST", "/x", undefined)).toEqual(expect.any(String));
    expect(fingerprint("POST", "/x", undefined)).toBe(
      fingerprint("POST", "/x", undefined),
    );
  });
});
