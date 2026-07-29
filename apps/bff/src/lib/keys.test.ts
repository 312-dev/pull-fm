/**
 * Derived signing keys.
 *
 * Two properties are load-bearing and both are asserted here rather than
 * assumed: derivation is one-way (so a leaked cursor key does not reach the
 * KEK), and the purposes are domain-separated (so a tag minted for one context
 * is not valid in another).
 */

import { describe, expect, test } from "vitest";

import { KEY_PURPOSES, SigningKeys } from "./keys.js";

const ROOT = Buffer.alloc(32, 42);

describe("SigningKeys", () => {
  test("refuses keying material that is too short", () => {
    expect(() => new SigningKeys(Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  test("is deterministic for the same root key", () => {
    const a = new SigningKeys(ROOT);
    const b = new SigningKeys(ROOT);
    expect(a.sign("cursor", "message")).toBe(b.sign("cursor", "message"));
  });

  test("a different root key produces a different tag", () => {
    const other = new SigningKeys(Buffer.alloc(32, 43));
    expect(new SigningKeys(ROOT).sign("cursor", "m")).not.toBe(
      other.sign("cursor", "m"),
    );
  });

  test("purposes are domain-separated", () => {
    // Without distinct HKDF info labels, a signature over an export ticket
    // would also verify as a cursor, and the two contexts could be crossed by a
    // caller that confused them.
    const keys = new SigningKeys(ROOT);
    const purposes = Object.keys(KEY_PURPOSES) as (keyof typeof KEY_PURPOSES)[];
    const tags = purposes.map((p) => keys.sign(p, "identical message"));
    expect(new Set(tags).size).toBe(purposes.length);

    for (const from of purposes) {
      for (const to of purposes) {
        if (from === to) continue;
        expect(
          keys.verify(
            to,
            "identical message",
            keys.sign(from, "identical message"),
          ),
          `a ${from} tag verified as a ${to} tag`,
        ).toBe(false);
      }
    }
  });

  test("verify accepts its own tag and rejects a tampered one", () => {
    const keys = new SigningKeys(ROOT);
    const tag = keys.sign("cursor", "hello");
    expect(keys.verify("cursor", "hello", tag)).toBe(true);
    expect(keys.verify("cursor", "hello!", tag)).toBe(false);
    expect(keys.verify("cursor", "hello", `${tag}x`)).toBe(false);
    expect(keys.verify("cursor", "hello", "")).toBe(false);
  });

  test("a tag never contains the root key material", () => {
    const keys = new SigningKeys(ROOT);
    const tag = keys.sign("cursor", "m");
    expect(tag).not.toContain(ROOT.toString("base64url"));
    expect(Buffer.from(tag, "base64url").equals(ROOT)).toBe(false);
  });
});
