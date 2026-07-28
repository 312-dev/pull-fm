/**
 * Envelope encryption for per-user third-party credentials.
 *
 * This is the highest-value asset in Pull.fm: a breach here exposes many users'
 * ListenBrainz tokens and Last.fm session keys. The design follows what
 * companies whose entire product is storing other people's OAuth tokens
 * actually do (Nango, Paragon): AES-256-GCM ciphertext in their own database,
 * with keys held separately. Notably, none of them use a secrets manager.
 *
 * Scheme
 * ------
 *   plaintext --AES-256-GCM(DEK)--> ciphertext   (stored in Postgres)
 *   DEK       --AES-256-GCM(KEK)--> wrapped_dek  (stored alongside)
 *   KEK                                          (never in the database)
 *
 * Why envelope rather than encrypting directly under the KEK:
 *   - KEK rotation re-wraps only the small DEKs. Token plaintext is never
 *     touched, so rotation is an online background job, not a migration.
 *   - A fresh DEK per row means one compromised DEK exposes exactly one
 *     connection, not the whole table.
 *
 * Two details that most implementations get wrong:
 *   - `kekId` is stored per row. Nango shipped without this and consequently
 *     cannot rotate its encryption key at all. It is a one-way mistake.
 *   - AAD binds user id, provider, and field name into the GCM tag, so moving
 *     ciphertext between rows or columns fails authentication instead of
 *     silently decrypting into the wrong user's context.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96-bit nonce, the GCM standard and required size
const TAG_BYTES = 16; // 128-bit authentication tag

/** Minimum length of a valid payload: nonce + tag, with zero-length plaintext. */
export const MIN_PAYLOAD_BYTES = NONCE_BYTES + TAG_BYTES;

/**
 * Context bound into the GCM tag as additional authenticated data.
 *
 * Not secret, but authenticated: an attacker with database write access cannot
 * move a ciphertext to another user's row without the tag check failing.
 */
export interface EncryptionContext {
  readonly userId: string;
  readonly provider: string;
  /** Column name, e.g. "access_token" or "refresh_token". */
  readonly field: string;
}

/** A sealed credential, exactly as persisted. */
export interface SealedCredential {
  readonly kekId: string;
  readonly wrappedDek: Buffer;
  readonly ciphertext: Buffer;
}

export class CryptoError extends Error {
  public override readonly name = "CryptoError";
}

/**
 * Serializes the AAD unambiguously.
 *
 * Length-prefixing prevents a splitting attack: without it, the contexts
 * ("ab", "c") and ("a", "bc") would produce identical AAD, letting a
 * ciphertext be replayed across a crafted user id / provider boundary.
 */
function buildAad(ctx: EncryptionContext): Buffer {
  const parts = [ctx.userId, ctx.provider, ctx.field];
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

/** Encrypts under `key`, returning `nonce || ciphertext || tag`. */
function sealWithKey(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  // A fresh random nonce per encryption is mandatory. Reusing a nonce under the
  // same key breaks GCM catastrophically: it leaks the XOR of the plaintexts
  // and allows tag forgery.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/** Reverses {@link sealWithKey}. Throws if the payload was tampered with. */
function openWithKey(key: Buffer, payload: Buffer, aad: Buffer): Buffer {
  if (payload.length < MIN_PAYLOAD_BYTES) {
    throw new CryptoError(
      `payload too short: ${String(payload.length)} bytes, minimum is ${String(MIN_PAYLOAD_BYTES)}`,
    );
  }
  const nonce = payload.subarray(0, NONCE_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Deliberately opaque. The caller must not learn whether the key, the tag,
    // or the AAD was wrong, and the underlying error can carry key material
    // into a log line.
    throw new CryptoError("decryption failed: authentication tag mismatch");
  }
}

/**
 * Holds the key encryption keys and performs seal/open.
 *
 * Multiple KEKs are held at once so rotation is non-breaking: new writes use
 * the active KEK while existing rows stay readable under the KEK that sealed
 * them, until a background job re-wraps them.
 */
export class EnvelopeCipher {
  readonly #keks: ReadonlyMap<string, Buffer>;
  readonly #activeKekId: string;

  /**
   * @param keks       All known KEKs by id. Each must be exactly 32 bytes.
   * @param activeKekId The KEK used for new writes. Must exist in `keks`.
   */
  constructor(keks: ReadonlyMap<string, Buffer>, activeKekId: string) {
    if (keks.size === 0) {
      throw new CryptoError("at least one KEK is required");
    }
    for (const [id, key] of keks) {
      if (key.length !== KEY_BYTES) {
        throw new CryptoError(
          `KEK "${id}" must be ${String(KEY_BYTES)} bytes, got ${String(key.length)}`,
        );
      }
    }
    if (!keks.has(activeKekId)) {
      throw new CryptoError(
        `active KEK "${activeKekId}" not present in key set`,
      );
    }
    this.#keks = keks;
    this.#activeKekId = activeKekId;
  }

  get activeKekId(): string {
    return this.#activeKekId;
  }

  #kek(id: string): Buffer {
    const key = this.#keks.get(id);
    if (key === undefined) {
      // Almost always means a row was sealed by a KEK that has since been
      // dropped from configuration, which is unrecoverable data loss. Loud.
      throw new CryptoError(`unknown KEK id "${id}"; cannot decrypt`);
    }
    return key;
  }

  /** Encrypts a credential under a fresh DEK wrapped by the active KEK. */
  seal(plaintext: string, ctx: EncryptionContext): SealedCredential {
    if (plaintext.length === 0) {
      throw new CryptoError("refusing to seal an empty credential");
    }
    const aad = buildAad(ctx);

    // A new DEK for every write. Google's KMS guidance is explicit on this:
    // never reuse a data key across records or users.
    const dek = randomBytes(KEY_BYTES);
    try {
      const ciphertext = sealWithKey(dek, Buffer.from(plaintext, "utf8"), aad);
      // The DEK is wrapped under the same AAD, so a wrapped DEK cannot be
      // transplanted to a different user or provider either.
      const wrappedDek = sealWithKey(this.#kek(this.#activeKekId), dek, aad);
      return { kekId: this.#activeKekId, wrappedDek, ciphertext };
    } finally {
      // Best-effort scrub. Node may have copied this buffer internally, so this
      // reduces the window rather than eliminating it.
      dek.fill(0);
    }
  }

  /** Decrypts a sealed credential. Throws on any tampering or context mismatch. */
  open(sealed: SealedCredential, ctx: EncryptionContext): string {
    const aad = buildAad(ctx);
    const dek = openWithKey(this.#kek(sealed.kekId), sealed.wrappedDek, aad);
    try {
      return openWithKey(dek, sealed.ciphertext, aad).toString("utf8");
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Re-wraps a DEK under the active KEK without touching token plaintext.
   *
   * This is what makes KEK rotation cheap: the background job reads rows whose
   * `kek_id` is stale, calls this, and writes back only `wrapped_dek` and
   * `kek_id`. Ciphertext columns are never read or rewritten.
   */
  rewrap(sealed: SealedCredential, ctx: EncryptionContext): SealedCredential {
    if (sealed.kekId === this.#activeKekId) {
      return sealed;
    }
    const aad = buildAad(ctx);
    const dek = openWithKey(this.#kek(sealed.kekId), sealed.wrappedDek, aad);
    try {
      return {
        kekId: this.#activeKekId,
        wrappedDek: sealWithKey(this.#kek(this.#activeKekId), dek, aad),
        ciphertext: sealed.ciphertext,
      };
    } finally {
      dek.fill(0);
    }
  }
}

/**
 * Parses a KEK from a base64 string, as supplied by the environment.
 *
 * Kept separate from the constructor so configuration errors surface at startup
 * with a clear message rather than on the first user connection attempt.
 */
export function parseKek(id: string, base64: string): [string, Buffer] {
  let key: Buffer;
  try {
    key = Buffer.from(base64, "base64");
  } catch {
    throw new CryptoError(`KEK "${id}" is not valid base64`);
  }
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `KEK "${id}" decoded to ${String(key.length)} bytes, expected ${String(KEY_BYTES)}`,
    );
  }
  return [id, key];
}

/** Generates a new 32-byte KEK, base64-encoded. For key provisioning only. */
export function generateKek(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * Constant-time comparison for secrets such as webhook signatures.
 *
 * Exposed here so callers never reach for `===` on a secret, which leaks
 * length and content through timing.
 */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
