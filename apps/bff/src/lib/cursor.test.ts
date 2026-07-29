/**
 * Cursor integrity (THREAT-MODEL M15).
 *
 * The cursor is the first of two controls. The second, and the one that
 * actually holds if this one is bypassed, is the `user_id = $subject` predicate
 * in the SQL, which is covered by the BOLA suite. These tests cover the first:
 * a cursor is opaque, integrity-protected, and bound to both the subject it was
 * issued to and the route that issued it.
 */

import { describe, expect, test } from "vitest";

import { ApiError } from "./errors.js";
import { decodeCursor, encodeCursor, pageLimit } from "./cursor.js";
import { SigningKeys } from "./keys.js";

const keys = new SigningKeys(Buffer.alloc(32, 9));
const SUBJECT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const POSITION = {
  createdAt: "2026-07-28T12:00:00.000Z",
  id: "33333333-3333-3333-3333-333333333333",
};

const expectRejected = (fn: () => unknown): void => {
  try {
    fn();
    throw new Error("expected the cursor to be rejected");
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    // Uniform message. A caller must not learn whether the cursor was
    // malformed, signed for another subject, or signed for another route; a
    // differential response is a subject-existence oracle.
    expect((err as ApiError).message).toBe(
      "The cursor is not valid. Start from the first page.",
    );
  }
};

describe("cursors", () => {
  test("round-trips for the subject it was issued to", () => {
    const cursor = encodeCursor(keys, "wishlist", SUBJECT, POSITION);
    expect(decodeCursor(keys, "wishlist", SUBJECT, cursor)).toEqual(POSITION);
  });

  test("does not disclose the subject id to anyone who decodes it", () => {
    // The subject is covered by the MAC but is not carried in the payload.
    const cursor = encodeCursor(keys, "wishlist", SUBJECT, POSITION);
    const payload = Buffer.from(
      cursor.split(".")[0] ?? "",
      "base64url",
    ).toString("utf8");
    expect(payload).not.toContain(SUBJECT);
  });

  test("is rejected when replayed by another subject", () => {
    const cursor = encodeCursor(keys, "wishlist", SUBJECT, POSITION);
    expectRejected(() => decodeCursor(keys, "wishlist", OTHER, cursor));
  });

  test("is rejected when replayed on another route", () => {
    const cursor = encodeCursor(keys, "wishlist", SUBJECT, POSITION);
    expectRejected(() => decodeCursor(keys, "feed", SUBJECT, cursor));
  });

  test("is rejected when the payload is edited", () => {
    const cursor = encodeCursor(keys, "wishlist", SUBJECT, POSITION);
    const [, mac] = cursor.split(".");
    const forged = Buffer.from(
      JSON.stringify({ t: POSITION.createdAt, i: OTHER }),
      "utf8",
    ).toString("base64url");
    expectRejected(() =>
      decodeCursor(keys, "wishlist", SUBJECT, `${forged}.${mac ?? ""}`),
    );
  });

  test("is rejected when signed by a different key", () => {
    const foreign = new SigningKeys(Buffer.alloc(32, 10));
    const cursor = encodeCursor(foreign, "wishlist", SUBJECT, POSITION);
    expectRejected(() => decodeCursor(keys, "wishlist", SUBJECT, cursor));
  });

  test.each([
    ["empty", ""],
    ["no separator", "abcdef"],
    ["too many parts", "a.b.c"],
    ["empty payload", ".mac"],
    ["empty mac", "payload."],
    ["not base64", "!!!.???"],
  ])("is rejected when malformed: %s", (_name, value) => {
    expectRejected(() => decodeCursor(keys, "wishlist", SUBJECT, value));
  });

  test("is rejected when the signed payload is not a valid position", () => {
    // A signed cursor cannot normally be malformed, but validating anyway means
    // a future key-handling bug degrades to a 400 rather than a SQL type error.
    const payload = Buffer.from(
      JSON.stringify({ t: "nonsense", i: 5 }),
    ).toString("base64url");
    const mac = keys.sign("cursor", `wishlist|${SUBJECT}|${payload}`);
    expectRejected(() =>
      decodeCursor(keys, "wishlist", SUBJECT, `${payload}.${mac}`),
    );
  });
});

describe("pageLimit", () => {
  test("clamps an unbounded page size", () => {
    // An unbounded limit is a resource-consumption finding (API4), not just a
    // performance one: the caller chooses how much work the database does.
    expect(pageLimit(10_000)).toBe(100);
    expect(pageLimit(10_000, 50)).toBe(50);
  });

  test("falls back to a default for absent or nonsensical values", () => {
    expect(pageLimit(undefined)).toBe(25);
    expect(pageLimit(0)).toBe(25);
    expect(pageLimit(-5)).toBe(25);
    expect(pageLimit(1.5)).toBe(25);
  });

  test("honours a reasonable request", () => {
    expect(pageLimit(10)).toBe(10);
  });
});
