import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring preview URLs, modeled on Deezer's Akamai token
 * (`?hdnea=exp=<epoch>~acl=<path>~hmac=<hex>`).
 *
 * WHY THE MOCK BOTHERS TO SIGN
 * ----------------------------
 * docs/UPSTREAM-TERMS.md L3: Deezer preview URLs are signed and time limited,
 * so a cached one 403s. PLAN.md section 1a turns that into a hard design rule
 * ("Deezer preview URLs ... are never stored at all").
 *
 * A mock that returns a static preview URL cannot catch a violation of that
 * rule: a BFF that wrongly caches the URL looks perfectly healthy under load
 * and only breaks in production, minutes after the cache warms. By issuing a
 * URL that genuinely stops verifying after previewTtlSeconds, and by counting
 * every expired hit, the load run turns a latent correctness bug into a
 * countable metric.
 *
 * The signing key protects nothing and is not a secret. It exists so that
 * "expired" and "forged" are distinguishable from "valid".
 */
export function signPreviewUrl({ key, path, ttlSeconds, now = Date.now() }) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const acl = path;
  const hmac = hmacHex(key, `exp=${exp}~acl=${acl}`);
  return `hdnea=exp=${exp}~acl=${acl}~hmac=${hmac}`;
}

/**
 * @returns {{valid:boolean, reason:'ok'|'missing'|'malformed'|'expired'|'bad-signature', ageSeconds?:number}}
 */
export function verifyPreviewUrl({ key, path, token, now = Date.now() }) {
  if (!token) return { valid: false, reason: "missing" };
  const parts = Object.fromEntries(
    token.split("~").map((kv) => {
      const i = kv.indexOf("=");
      return i === -1 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const exp = Number(parts.exp);
  if (!Number.isFinite(exp) || !parts.hmac || !parts.acl) {
    return { valid: false, reason: "malformed" };
  }
  const expected = hmacHex(key, `exp=${exp}~acl=${parts.acl}`);
  if (!constantTimeEqual(expected, parts.hmac)) {
    return { valid: false, reason: "bad-signature" };
  }
  // acl mismatch is a forged or swapped URL, which is a different bug from an
  // expired one and is worth reporting separately.
  if (parts.acl !== path) return { valid: false, reason: "bad-signature" };
  const nowSec = Math.floor(now / 1000);
  if (nowSec > exp) {
    return { valid: false, reason: "expired", ageSeconds: nowSec - exp };
  }
  return { valid: true, reason: "ok" };
}

function hmacHex(key, input) {
  return createHmac("sha256", key).update(input).digest("hex").slice(0, 40);
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
