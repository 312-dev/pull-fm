/**
 * Purpose-bound signing keys, derived rather than configured.
 *
 * Three things in this service need an HMAC key that is not the credential KEK:
 * pagination cursors, export download links, and connect-flow state. None of
 * them protects an asset on the order of the vault, and all three are
 * short-lived: a cursor is valid for one page view, an export link for ten
 * minutes, a connect state for ten minutes.
 *
 * Rather than add three more secrets to escrow, each is derived from the active
 * KEK with HKDF-SHA256 under a distinct `info` label. Two properties make this
 * safe rather than the usual "reused the key for two jobs" mistake:
 *
 *   1. HKDF is one-way. Possessing a derived cursor key does not reveal the
 *      KEK, so a bug that leaks the cursor key does not touch asset A1.
 *   2. The `info` label domain-separates the outputs. A signature produced for
 *      an export link is not a valid signature for a cursor, so the two
 *      contexts cannot be crossed even by a caller that confuses them.
 *
 * The cost is that rotating the KEK invalidates in-flight cursors, export
 * links, and connect states. All three are re-obtainable by repeating a cheap
 * request, so the operational impact of a rotation is a few retries, not a
 * failed rotation. That is the trade this makes deliberately: fewer secrets to
 * lose, in exchange for a rotation being briefly visible to clients.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** Distinct HKDF `info` labels. Adding a purpose means adding a label here. */
export const KEY_PURPOSES = {
  cursor: "pullfm/v1/cursor",
  exportLink: "pullfm/v1/export-link",
  connectState: "pullfm/v1/connect-state",
} as const;

export type KeyPurpose = keyof typeof KEY_PURPOSES;

/**
 * Derives the per-purpose keys once, at startup.
 *
 * Derivation is cheap but not free, and doing it per request would put an
 * unnecessary KDF on the hot path of every paginated read.
 */
export class SigningKeys {
  readonly #keys: ReadonlyMap<KeyPurpose, Buffer>;

  constructor(rootKey: Buffer) {
    if (rootKey.length < 32) {
      throw new Error(
        "signing key derivation requires at least 32 bytes of input keying material",
      );
    }
    const keys = new Map<KeyPurpose, Buffer>();
    for (const [purpose, info] of Object.entries(KEY_PURPOSES)) {
      keys.set(
        purpose as KeyPurpose,
        Buffer.from(
          // Empty salt is correct here: the input keying material is already a
          // uniformly random 256-bit key, which is exactly the case RFC 5869
          // section 3.1 says a salt is optional for.
          hkdfSync(
            "sha256",
            rootKey,
            Buffer.alloc(0),
            Buffer.from(info, "utf8"),
            32,
          ),
        ),
      );
    }
    this.#keys = keys;
  }

  #key(purpose: KeyPurpose): Buffer {
    const key = this.#keys.get(purpose);
    /* c8 ignore next 3 -- unreachable: KEY_PURPOSES is closed and populated in the constructor */
    if (key === undefined) {
      throw new Error(`unknown signing purpose "${purpose}"`);
    }
    return key;
  }

  /** Base64url HMAC-SHA256 tag over `message` for the given purpose. */
  sign(purpose: KeyPurpose, message: string): string {
    return createHmac("sha256", this.#key(purpose))
      .update(message, "utf8")
      .digest("base64url");
  }

  /**
   * Constant-time verification.
   *
   * `===` on a MAC leaks the position of the first differing byte through
   * timing, which over enough samples is a forgery oracle.
   */
  verify(purpose: KeyPurpose, message: string, tag: string): boolean {
    const expected = Buffer.from(this.sign(purpose, message), "utf8");
    const actual = Buffer.from(tag, "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}
