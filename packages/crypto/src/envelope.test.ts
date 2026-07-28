/**
 * Adversarial tests for the credential envelope.
 *
 * These are not coverage tests. Each one encodes an attack that must fail, and
 * together they are the security control that Gate 3 and Gate 8 rely on. A
 * passing "it encrypts and decrypts" test proves almost nothing on its own;
 * what matters is that tampering, context confusion, and key confusion all
 * fail closed.
 */

import { describe, expect, it } from "vitest";
import {
  CryptoError,
  EnvelopeCipher,
  type EncryptionContext,
  generateKek,
  parseKek,
  secretsEqual,
} from "./envelope.js";

const KEK_V1 = parseKek("kek:v1", generateKek());
const KEK_V2 = parseKek("kek:v2", generateKek());

function cipher(active = "kek:v1"): EnvelopeCipher {
  return new EnvelopeCipher(new Map([KEK_V1, KEK_V2]), active);
}

const ALICE: EncryptionContext = {
  userId: "11111111-1111-1111-1111-111111111111",
  provider: "lastfm",
  field: "access_token",
};
const BOB: EncryptionContext = {
  userId: "22222222-2222-2222-2222-222222222222",
  provider: "lastfm",
  field: "access_token",
};

const TOKEN = "lastfm_session_key_abc123def456";

describe("round trip", () => {
  it("recovers the original credential", () => {
    const c = cipher();
    expect(c.open(c.seal(TOKEN, ALICE), ALICE)).toBe(TOKEN);
  });

  it("handles unicode and long credentials", () => {
    const c = cipher();
    for (const value of ["tökén-ü-🎵", "x".repeat(4096), "a"]) {
      expect(c.open(c.seal(value, ALICE), ALICE)).toBe(value);
    }
  });

  it("never produces identical ciphertext for identical input", () => {
    // Fresh nonce and fresh DEK per write. Identical output would mean nonce
    // reuse, which breaks GCM catastrophically.
    const c = cipher();
    const a = c.seal(TOKEN, ALICE);
    const b = c.seal(TOKEN, ALICE);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it("does not leak the plaintext into the ciphertext", () => {
    const c = cipher();
    const sealed = c.seal(TOKEN, ALICE);
    expect(sealed.ciphertext.toString("utf8")).not.toContain("lastfm_session");
    expect(sealed.ciphertext.toString("hex")).not.toContain(
      Buffer.from(TOKEN, "utf8").toString("hex"),
    );
  });
});

describe("tamper detection", () => {
  it("rejects a flipped bit anywhere in the ciphertext", () => {
    const c = cipher();
    const sealed = c.seal(TOKEN, ALICE);
    for (let i = 0; i < sealed.ciphertext.length; i++) {
      const corrupted = Buffer.from(sealed.ciphertext);
      corrupted.writeUInt8(corrupted.readUInt8(i) ^ 0x01, i);
      expect(() => c.open({ ...sealed, ciphertext: corrupted }, ALICE)).toThrow(
        CryptoError,
      );
    }
  });

  it("rejects a tampered wrapped DEK", () => {
    const c = cipher();
    const sealed = c.seal(TOKEN, ALICE);
    const corrupted = Buffer.from(sealed.wrappedDek);
    corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0xff, 0);
    expect(() => c.open({ ...sealed, wrappedDek: corrupted }, ALICE)).toThrow(
      CryptoError,
    );
  });

  it("rejects a truncated payload", () => {
    const c = cipher();
    const sealed = c.seal(TOKEN, ALICE);
    expect(() =>
      c.open(
        { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 20) },
        ALICE,
      ),
    ).toThrow(CryptoError);
  });
});

describe("context binding (AAD)", () => {
  // This is the property that makes database write access insufficient to
  // steal a credential: ciphertext is cryptographically bound to its row.

  it("refuses to decrypt another user's credential", () => {
    const c = cipher();
    const alicesToken = c.seal(TOKEN, ALICE);
    // Simulates an attacker copying Alice's ciphertext into Bob's row.
    expect(() => c.open(alicesToken, BOB)).toThrow(CryptoError);
  });

  it("refuses to decrypt across providers", () => {
    const c = cipher();
    const sealed = c.seal(TOKEN, ALICE);
    expect(() =>
      c.open(sealed, { ...ALICE, provider: "listenbrainz" }),
    ).toThrow(CryptoError);
  });

  it("refuses to decrypt across columns", () => {
    const c = cipher();
    const sealed = c.seal(TOKEN, ALICE);
    expect(() => c.open(sealed, { ...ALICE, field: "refresh_token" })).toThrow(
      CryptoError,
    );
  });

  it("resists AAD splitting attacks", () => {
    // Without length-prefixed AAD, ("ab","c",f) and ("a","bc",f) would serialize
    // identically, letting a ciphertext be replayed across a crafted boundary.
    const c = cipher();
    const sealed = c.seal(TOKEN, { userId: "ab", provider: "c", field: "f" });
    expect(() =>
      c.open(sealed, { userId: "a", provider: "bc", field: "f" }),
    ).toThrow(CryptoError);
  });
});

describe("key rotation", () => {
  it("reads rows sealed under an older KEK", () => {
    // The core rotation property: after switching the active KEK, existing
    // rows must remain readable or rotation is an outage.
    const old = cipher("kek:v1");
    const sealed = old.seal(TOKEN, ALICE);
    const rotated = cipher("kek:v2");
    expect(rotated.open(sealed, ALICE)).toBe(TOKEN);
  });

  it("rewrap changes the KEK without touching ciphertext", () => {
    const old = cipher("kek:v1");
    const sealed = old.seal(TOKEN, ALICE);
    const rotated = cipher("kek:v2");

    const rewrapped = rotated.rewrap(sealed, ALICE);

    expect(rewrapped.kekId).toBe("kek:v2");
    // The expensive column is untouched, which is what makes rotation an
    // online background job rather than a full re-encryption.
    expect(rewrapped.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(rewrapped.wrappedDek.equals(sealed.wrappedDek)).toBe(false);
    expect(rotated.open(rewrapped, ALICE)).toBe(TOKEN);
  });

  it("rewrap is a no-op when already current", () => {
    const c = cipher("kek:v1");
    const sealed = c.seal(TOKEN, ALICE);
    expect(c.rewrap(sealed, ALICE)).toBe(sealed);
  });

  it("fails loudly when the sealing KEK is no longer configured", () => {
    // Dropping a KEK that still has rows is unrecoverable data loss, so it must
    // never fail silently or be mistaken for a tampering error.
    const sealed = cipher("kek:v1").seal(TOKEN, ALICE);
    const missing = new EnvelopeCipher(new Map([KEK_V2]), "kek:v2");
    expect(() => missing.open(sealed, ALICE)).toThrow(/unknown KEK/);
  });
});

describe("configuration validation", () => {
  it("rejects a KEK of the wrong length", () => {
    expect(() => parseKek("bad", Buffer.alloc(16).toString("base64"))).toThrow(
      /decoded to 16 bytes, expected 32/,
    );
  });

  it("rejects an empty key set", () => {
    expect(() => new EnvelopeCipher(new Map(), "kek:v1")).toThrow(CryptoError);
  });

  it("rejects an active KEK that is not present", () => {
    expect(() => new EnvelopeCipher(new Map([KEK_V1]), "kek:v9")).toThrow(
      /not present/,
    );
  });

  it("refuses to seal an empty credential", () => {
    // An empty token almost always means an upstream parse failure; storing it
    // would produce a connection that silently never works.
    expect(() => cipher().seal("", ALICE)).toThrow(CryptoError);
  });

  it("generates 32-byte keys", () => {
    expect(Buffer.from(generateKek(), "base64")).toHaveLength(32);
  });
});

describe("error messages", () => {
  it("never echoes the credential or key material", () => {
    const c = cipher();
    const sealed = c.seal(TOKEN, ALICE);
    try {
      c.open(sealed, BOB);
      expect.unreachable("should have thrown");
    } catch (err) {
      const text = String(err) + JSON.stringify((err as Error).message);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(KEK_V1[1].toString("base64"));
    }
  });
});

describe("secretsEqual", () => {
  it("compares correctly", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
  });
});
