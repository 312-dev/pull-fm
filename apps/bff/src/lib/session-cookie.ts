/**
 * The sealed session cookie: wire format and seal.
 *
 * ---------------------------------------------------------------------------
 * WHY A COOKIE EXISTS AT ALL, GIVEN THAT THE API IS BEARER-FIRST
 *
 * A mobile client holds its own credential store and wants a bearer token. A
 * browser client does not have one: anything JavaScript can read, an XSS can
 * read, and a refresh token in `localStorage` is a permanent account takeover
 * one script injection away. So both transports exist and they carry the SAME
 * credential:
 *
 *   Bearer   the WorkOS access token, handed to the client, sent back in the
 *            Authorization header. Unchanged from before magic auth landed.
 *   Cookie   the same access token plus its refresh token, sealed with
 *            AES-256-GCM, in an HttpOnly cookie the client cannot read.
 *
 * The cookie is a TRANSPORT, not a second credential type. On the way in it is
 * opened and the access token inside it is handed to exactly the same JWKS
 * verification every bearer token goes through (plugins/auth.ts). Nothing is
 * trusted because it arrived in a cookie: the cookie's own authentication tag
 * proves only that we minted it, and the JWT inside still has to verify against
 * WorkOS's published keys, still has to name a subject we have an active record
 * of, and still has to survive the local revocation deny list.
 *
 * That property is the reason this file is small. A cookie format that carried
 * its own claims would be a second identity system to get wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ENCRYPTED RATHER THAN SIGNED
 *
 * A signed cookie is the usual choice and it is wrong here, because the payload
 * IS a credential. A signed-but-readable cookie puts a live WorkOS refresh
 * token in plaintext in the browser's cookie jar, in any proxy log that records
 * request headers, and in any crash report that captures them. Sealing it means
 * the bytes on the wire are useless to everything except this process.
 *
 * The construction follows packages/crypto/src/envelope.ts, deliberately, so
 * there is one set of rules in this codebase rather than two: AES-256-GCM, a
 * fresh 96-bit nonce per seal, a 128-bit tag, and a version label bound in as
 * additional authenticated data so a v1 cookie can never be reinterpreted under
 * a future v2 format.
 *
 * The key is DERIVED from the active KEK with HKDF under its own label, exactly
 * as lib/keys.ts derives the cursor and export-link keys, and for the same
 * reasons: HKDF is one-way so this key cannot lead back to the vault key, and
 * the label domain-separates it so a session cookie is not a valid cursor and
 * vice versa. The cost is that rotating the KEK signs everyone out, which is a
 * cheap and recoverable event (the client repeats sign-in) rather than a failed
 * rotation.
 *
 * NOTHING IN THIS FILE MAY BE LOGGED. The sealed value contains a refresh
 * token, which is why `open` returns null instead of throwing a descriptive
 * error: an error carrying "which part failed" is both an oracle and something
 * an error reporter will happily serialise next to the input that produced it.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Format version, carried in the clear AND bound into the tag.
 *
 * In the clear so an old cookie is rejected without a decryption attempt; bound
 * into the tag so an attacker cannot relabel a v1 cookie as v2 and have a
 * future parser read the same bytes under different rules.
 */
const VERSION = "v1";

/** HKDF label. Distinct from every label in lib/keys.ts, which is the point. */
const HKDF_INFO = "pullfm/v1/session-cookie";

/**
 * A cookie's decrypted contents.
 *
 * Deliberately minimal. Everything else about the caller (their Pull.fm user
 * id, their email, their scopes) is resolved from the database on every request
 * via the verified access token, so nothing here is authoritative and a stale
 * cookie cannot assert a stale fact.
 */
export interface SessionCookiePayload {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** The WorkOS subject. Cross-checked against the token, never trusted alone. */
  readonly workosUserId: string;
  /** Unix seconds. The outer bound, independent of the tokens' own expiry. */
  readonly expiresAt: number;
}

interface RawPayload {
  a?: unknown;
  r?: unknown;
  u?: unknown;
  e?: unknown;
}

export class SessionCookieCipher {
  readonly #key: Buffer;

  /**
   * @param rootKey The active KEK. At least 32 bytes; the same input keying
   *                material lib/keys.ts derives from.
   */
  constructor(rootKey: Buffer) {
    if (rootKey.length < KEY_BYTES) {
      throw new Error(
        "session cookie key derivation requires at least 32 bytes of input keying material",
      );
    }
    // Empty salt, as in lib/keys.ts: RFC 5869 section 3.1 makes the salt
    // optional when the input is already a uniformly random key.
    this.#key = Buffer.from(
      hkdfSync(
        "sha256",
        rootKey,
        Buffer.alloc(0),
        Buffer.from(HKDF_INFO, "utf8"),
        KEY_BYTES,
      ),
    );
  }

  /** Seals a payload into the cookie's value. */
  seal(payload: SessionCookiePayload): string {
    const plaintext = Buffer.from(
      JSON.stringify({
        a: payload.accessToken,
        r: payload.refreshToken,
        u: payload.workosUserId,
        e: payload.expiresAt,
      } satisfies RawPayload),
      "utf8",
    );

    // A fresh nonce per seal is mandatory. Reuse under one key breaks GCM
    // catastrophically: it leaks the XOR of the plaintexts and permits forgery.
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(VERSION, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
    return `${VERSION}.${sealed.toString("base64url")}`;
  }

  /**
   * Opens a cookie value, or returns null.
   *
   * Null for every failure without distinction: wrong version, malformed
   * base64, truncation, a tampered tag, a payload that is not the expected
   * shape, and expiry all produce the same answer. The caller turns that into
   * the same 401 an absent cookie produces, so the cookie cannot be used as an
   * oracle for whether a forgery attempt got closer.
   */
  open(
    value: string,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): SessionCookiePayload | null {
    const separator = value.indexOf(".");
    if (separator === -1) return null;
    if (value.slice(0, separator) !== VERSION) return null;

    let sealed: Buffer;
    try {
      sealed = Buffer.from(value.slice(separator + 1), "base64url");
    } catch {
      return null;
    }
    if (sealed.length < NONCE_BYTES + TAG_BYTES) return null;

    const nonce = sealed.subarray(0, NONCE_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);

    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(VERSION, "utf8"));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
    } catch {
      return null;
    }

    let raw: RawPayload;
    try {
      raw = JSON.parse(plaintext.toString("utf8")) as RawPayload;
    } catch {
      return null;
    }

    // The contents are authenticated, so this cannot be hostile input in the
    // usual sense. It is still validated, because a cookie sealed by an older
    // build of this application is authentic and may not match this shape.
    if (
      typeof raw.a !== "string" ||
      typeof raw.r !== "string" ||
      typeof raw.u !== "string" ||
      typeof raw.e !== "number" ||
      raw.a.length === 0 ||
      raw.r.length === 0 ||
      raw.u.length === 0
    ) {
      return null;
    }
    if (raw.e <= nowSeconds) return null;

    return {
      accessToken: raw.a,
      refreshToken: raw.r,
      workosUserId: raw.u,
      expiresAt: raw.e,
    };
  }
}

// ---------------------------------------------------------------------------
// Cookie wire format
//
// Hand-written rather than @fastify/cookie, for the reason services/workos.ts
// gives for not using the WorkOS SDK: this process holds the KEK, and every
// dependency added to it is a path in THREAT-MODEL AT-4. Parsing one header and
// formatting one Set-Cookie is roughly forty lines and needs no upstream.
// ---------------------------------------------------------------------------

/**
 * Reads one cookie out of a Cookie header.
 *
 * Returns the FIRST match, which is the browser's own precedence: a more
 * specific path or host wins and is sent first. Taking the last would let a
 * shadowing cookie override the real one, which is the attack the `__Host-`
 * prefix exists to prevent and which this must not undo.
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (header === undefined || header.length === 0) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length === 0 ? null : value;
  }
  return null;
}

export interface CookieAttributes {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

/**
 * Formats a Set-Cookie value.
 *
 * Every attribute here is load-bearing:
 *
 *   HttpOnly        JavaScript cannot read it, so an XSS cannot exfiltrate the
 *                   refresh token. This is the entire reason to prefer a cookie
 *                   over localStorage for a browser client.
 *   Secure          never sent over plain HTTP. Required by `__Host-`.
 *   SameSite=Strict the browser does not attach it to any cross-site request,
 *                   which is the primary CSRF control. The custom-header
 *                   requirement in plugins/auth.ts is the second, because
 *                   SameSite is a browser behaviour and browsers vary.
 *   Path=/          required by `__Host-`, and correct: the whole API is behind
 *                   this session.
 *
 * There is deliberately NO Domain attribute. Setting one would forfeit the
 * `__Host-` prefix and share the cookie with every sibling host.
 */
export function serializeSessionCookie(
  name: string,
  value: string,
  attrs: CookieAttributes,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${String(attrs.maxAgeSeconds)}`,
  ];
  if (attrs.secure) parts.push("Secure");
  return parts.join("; ");
}

/** The Set-Cookie that removes the session cookie. */
export function clearSessionCookie(name: string, secure: boolean): string {
  return serializeSessionCookie(name, "", { secure, maxAgeSeconds: 0 });
}
