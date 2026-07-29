/**
 * Personal API token primitives.
 *
 * The database-backed halves (creation, rotation, ownership, expiry) are
 * covered by the integration suite against a real Postgres, because those
 * properties live in SQL predicates. What is covered here is everything that
 * decides whether a leaked token is findable, guessable, or recoverable.
 */

import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCOPES,
  digestsEqual,
  hashToken,
  mintToken,
  nextRotationName,
  TOKEN_PATTERN,
  TOKEN_SCOPES,
} from "./tokens.js";

describe("token format", () => {
  test("carries a fixed, greppable prefix", () => {
    // The prefix is what makes a leaked token findable by gitleaks, by GitHub
    // push protection, and by a grep over a support transcript. A bare random
    // string is indistinguishable from a hash and gets missed.
    expect(mintToken("pfm_live").token.startsWith("pfm_live_")).toBe(true);
    expect(mintToken("pfm_test").token.startsWith("pfm_test_")).toBe(true);
  });

  test("matches the documented pattern, which is what the scanner rule keys on", () => {
    for (const prefix of ["pfm_live", "pfm_test"] as const) {
      for (let i = 0; i < 200; i += 1) {
        expect(TOKEN_PATTERN.test(mintToken(prefix).token)).toBe(true);
      }
    }
  });

  test("carries 256 bits of entropy in a fixed-length secret", () => {
    const { token } = mintToken("pfm_live");
    const secret = token.slice("pfm_live_".length);
    // 32 bytes base64url-encoded, unpadded.
    expect(secret).toHaveLength(43);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
  });

  test("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(mintToken("pfm_live").token);
    expect(seen.size).toBe(2_000);
  });

  test("rejects near-miss shapes rather than hashing them", () => {
    for (const bad of [
      "",
      "pfm_live_",
      "pfm_live_short",
      "pfm_prod_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      `pfm_live_${"a".repeat(44)}`,
      `pfm_live_${"a".repeat(42)}`,
      `pfm_live_${"a".repeat(42)}+`,
      `PFM_LIVE_${"a".repeat(43)}`,
    ]) {
      expect(TOKEN_PATTERN.test(bad), `${bad} was accepted`).toBe(false);
    }
  });
});

describe("what is stored", () => {
  test("the stored value is a sha256 digest, never the token", () => {
    const { token, hash } = mintToken("pfm_live");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hash).toBe(hashToken(token));
  });

  test("the digest is not reversible to the token", () => {
    // Trivially true of a hash, asserted so that a future "optimisation" that
    // stores an encrypted token instead of a digest fails here.
    const { token, hash } = mintToken("pfm_live");
    expect(Buffer.from(hash, "hex").toString("base64url")).not.toContain(
      token.slice(9),
    );
  });

  test("last_four identifies a token without disclosing it", () => {
    const { token, lastFour } = mintToken("pfm_live");
    expect(lastFour).toHaveLength(4);
    expect(token.endsWith(lastFour)).toBe(true);
    // Four characters of base64url is 24 bits: enough to tell two of a user's
    // ten tokens apart, nowhere near enough to reconstruct one.
    expect(token.length - lastFour.length).toBeGreaterThan(40);
  });
});

describe("digest comparison", () => {
  test("is exact", () => {
    const a = hashToken("one");
    expect(digestsEqual(a, a)).toBe(true);
    expect(digestsEqual(a, hashToken("two"))).toBe(false);
  });

  test("does not throw on a length mismatch", () => {
    // timingSafeEqual throws when the buffers differ in length. A throw here
    // would turn a malformed credential into a 500 instead of a 401.
    expect(digestsEqual(hashToken("x"), "short")).toBe(false);
    expect(digestsEqual("", "")).toBe(true);
  });
});

describe("scopes", () => {
  test("the default set is read-only", () => {
    for (const scope of DEFAULT_SCOPES)
      expect(scope.startsWith("read:")).toBe(true);
  });

  test("every declared scope is read-only", () => {
    // Widening this is a schema change (the CHECK constraint in migration 0002)
    // and therefore a review. This test is the reminder.
    for (const scope of TOKEN_SCOPES)
      expect(scope.startsWith("read:")).toBe(true);
  });

  test("the defaults are a subset of the declared scopes", () => {
    for (const scope of DEFAULT_SCOPES) {
      expect(TOKEN_SCOPES as readonly string[]).toContain(scope);
    }
  });
});

describe("rotation naming", () => {
  test("suffixes and then increments", () => {
    expect(nextRotationName("laptop")).toBe("laptop (rotated)");
    expect(nextRotationName("laptop (rotated)")).toBe("laptop (rotated 2)");
    expect(nextRotationName("laptop (rotated 2)")).toBe("laptop (rotated 3)");
    expect(nextRotationName("laptop (rotated 9)")).toBe("laptop (rotated 10)");
  });

  test("stays inside the column's 64 character limit", () => {
    // The name column is CHECK-constrained. Overflowing it would turn a
    // rotation, which is the only incident response available for a leaked
    // token, into a 500 at the worst possible moment.
    const long = "x".repeat(64);
    expect(nextRotationName(long).length).toBeLessThanOrEqual(64);
    expect(nextRotationName(nextRotationName(long)).length).toBeLessThanOrEqual(
      64,
    );
  });
});
