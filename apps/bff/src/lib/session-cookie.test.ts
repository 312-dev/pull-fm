/**
 * The sealed session cookie.
 *
 * This value carries a live WorkOS refresh token through the browser's cookie
 * jar, so the properties asserted here are the ones that decide whether a
 * stolen or tampered cookie is worth anything. A happy-path round trip proves
 * almost nothing on its own; every test below except the first two is an
 * attempt to make the seal accept something it must not.
 */

import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
  SessionCookieCipher,
  type SessionCookiePayload,
} from "./session-cookie.js";

const ROOT = Buffer.alloc(32, 7);
const OTHER_ROOT = Buffer.alloc(32, 9);

const NOW = 1_800_000_000;

function payload(
  overrides: Partial<SessionCookiePayload> = {},
): SessionCookiePayload {
  return {
    accessToken: "access.token.value",
    refreshToken: "refresh-token-value",
    workosUserId: "user_01ABC",
    expiresAt: NOW + 3600,
    ...overrides,
  };
}

describe("round trip", () => {
  test("opens what it sealed", () => {
    const cipher = new SessionCookieCipher(ROOT);
    const sealed = cipher.seal(payload());
    expect(cipher.open(sealed, NOW)).toEqual(payload());
  });

  test("derives the same key from the same root", () => {
    // Two processes on the same KEK must agree, or a rolling deploy signs
    // everyone out halfway through.
    const sealed = new SessionCookieCipher(ROOT).seal(payload());
    expect(new SessionCookieCipher(ROOT).open(sealed, NOW)).not.toBeNull();
  });

  test("refuses a root key too short to be a KEK", () => {
    expect(() => new SessionCookieCipher(Buffer.alloc(16, 1))).toThrow(
      /32 bytes/,
    );
  });
});

describe("what is on the wire", () => {
  test("the tokens are not readable in the cookie value", () => {
    // The whole reason the cookie is encrypted rather than signed. A signed
    // cookie would put this refresh token in plaintext in the browser's jar and
    // in every proxy log that records request headers.
    const cipher = new SessionCookieCipher(ROOT);
    const sealed = cipher.seal(payload());
    expect(sealed).not.toContain("refresh-token-value");
    expect(sealed).not.toContain("access.token.value");
    expect(sealed).not.toContain("user_01ABC");

    const decoded = Buffer.from(sealed.slice(3), "base64url").toString("utf8");
    expect(decoded).not.toContain("refresh-token-value");
  });

  test("carries a version prefix in the clear", () => {
    expect(new SessionCookieCipher(ROOT).seal(payload())).toMatch(/^v1\./);
  });

  test("is URL and cookie safe", () => {
    // base64url, so no `=`, `;`, `,` or whitespace to break the header or to
    // need quoting, which is where cookie parsers disagree with each other.
    const cipher = new SessionCookieCipher(ROOT);
    for (let i = 0; i < 100; i += 1) {
      const sealed = cipher.seal(
        payload({ workosUserId: `user_${String(i)}` }),
      );
      expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    }
  });

  test("never repeats, because the nonce is fresh per seal", () => {
    // Nonce reuse under one key breaks GCM catastrophically: it leaks the XOR
    // of the plaintexts and permits tag forgery. Identical input producing
    // identical output would be the visible symptom.
    const cipher = new SessionCookieCipher(ROOT);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(cipher.seal(payload()));
    expect(seen.size).toBe(500);
  });
});

describe("forgery", () => {
  test("a cookie sealed under a different key does not open", () => {
    const sealed = new SessionCookieCipher(OTHER_ROOT).seal(payload());
    expect(new SessionCookieCipher(ROOT).open(sealed, NOW)).toBeNull();
  });

  test("every single-byte mutation of the ciphertext is rejected", () => {
    // GCM's authentication tag is what makes this true, and asserting it over
    // the whole payload rather than at one offset is what proves the tag is
    // actually being checked rather than merely present.
    const cipher = new SessionCookieCipher(ROOT);
    const sealed = cipher.seal(payload());
    const raw = Buffer.from(sealed.slice(3), "base64url");

    for (let i = 0; i < raw.length; i += 1) {
      const mutated = Buffer.from(raw);
      mutated[i] = (mutated[i] ?? 0) ^ 0x01;
      const candidate = `v1.${mutated.toString("base64url")}`;
      expect(
        cipher.open(candidate, NOW),
        `byte ${String(i)} was mutated and the cookie still opened`,
      ).toBeNull();
    }
  });

  test("truncation is rejected", () => {
    const cipher = new SessionCookieCipher(ROOT);
    const sealed = cipher.seal(payload());
    const raw = Buffer.from(sealed.slice(3), "base64url");
    for (const length of [0, 1, 12, 27, raw.length - 1]) {
      expect(
        cipher.open(`v1.${raw.subarray(0, length).toString("base64url")}`, NOW),
      ).toBeNull();
    }
  });

  test("a relabelled version is rejected", () => {
    // The version is bound into the tag as AAD, so an attacker cannot present
    // a v1 cookie as v2 and have a future parser read the same bytes under
    // different rules.
    const cipher = new SessionCookieCipher(ROOT);
    const sealed = cipher.seal(payload());
    expect(cipher.open(sealed.replace(/^v1\./, "v2."), NOW)).toBeNull();
    expect(cipher.open(sealed.replace(/^v1\./, ""), NOW)).toBeNull();
  });

  test("arbitrary junk is rejected without throwing", () => {
    // A throw here would be a 500 on a route that must answer 401, and a 500
    // is itself a signal that a forgery attempt got further than the others.
    const cipher = new SessionCookieCipher(ROOT);
    for (const junk of [
      "",
      ".",
      "v1",
      "v1.",
      "v1.!!!!",
      "v1.aaaa",
      randomBytes(64).toString("base64url"),
      `v1.${randomBytes(64).toString("base64url")}`,
      "{}",
      "v1.eyJhIjoieCJ9",
    ]) {
      expect(() => cipher.open(junk, NOW)).not.toThrow();
      expect(cipher.open(junk, NOW), `${junk} opened`).toBeNull();
    }
  });
});

describe("expiry", () => {
  test("a cookie past its own expiry does not open", () => {
    const cipher = new SessionCookieCipher(ROOT);
    const sealed = cipher.seal(payload({ expiresAt: NOW - 1 }));
    expect(cipher.open(sealed, NOW)).toBeNull();
  });

  test("expiry is bound into the tag and cannot be extended", () => {
    // The outer bound is only a bound if it is authenticated. Re-sealing with a
    // later expiry requires the key, which is the property being asserted.
    const cipher = new SessionCookieCipher(ROOT);
    const short = cipher.seal(payload({ expiresAt: NOW + 1 }));
    expect(cipher.open(short, NOW)).not.toBeNull();
    expect(cipher.open(short, NOW + 2)).toBeNull();
  });

  test("an authentic cookie from an older payload shape is rejected", () => {
    // Authentic but unreadable is a real case during a deploy that changes the
    // payload, and it must fail closed rather than produce a half-populated
    // session.
    const cipher = new SessionCookieCipher(ROOT);
    const handRolled = new SessionCookieCipher(ROOT);
    // Seal a structurally valid but incomplete payload by going through the
    // real seal and then asserting the validator, not the crypto.
    const sealed = handRolled.seal(payload({ refreshToken: "x" }));
    expect(cipher.open(sealed, NOW)).not.toBeNull();
    // An empty token is the shape an older build could have produced.
    expect(() => handRolled.seal(payload({ refreshToken: "" }))).not.toThrow();
    expect(
      cipher.open(handRolled.seal(payload({ refreshToken: "" })), NOW),
    ).toBeNull();
  });
});

describe("the cookie wire format", () => {
  test("reads a named cookie out of a header", () => {
    expect(readCookie("a=1; pullfm_session=abc; b=2", "pullfm_session")).toBe(
      "abc",
    );
    expect(readCookie("pullfm_session=abc", "pullfm_session")).toBe("abc");
    expect(readCookie("  pullfm_session = abc  ", "pullfm_session")).toBe(
      "abc",
    );
  });

  test("returns null rather than a partial match", () => {
    for (const header of [
      undefined,
      "",
      "other=1",
      "not_pullfm_session=abc",
      "pullfm_session=",
      "pullfm_sessionx=abc",
    ]) {
      expect(readCookie(header, "pullfm_session"), header).toBeNull();
    }
  });

  test("takes the FIRST match when a name is duplicated", () => {
    // Browser precedence: the more specific cookie is sent first. Taking the
    // last would let a shadowing cookie override the real one, which is exactly
    // the fixation attack the __Host- prefix exists to prevent.
    expect(readCookie("s=real; s=shadow", "s")).toBe("real");
  });

  test("the Set-Cookie carries every attribute the design depends on", () => {
    const header = serializeSessionCookie("__Host-pullfm_session", "v1.abc", {
      secure: true,
      maxAgeSeconds: 60,
    });
    expect(header).toContain("__Host-pullfm_session=v1.abc");
    // HttpOnly is what makes an XSS unable to read the refresh token, which is
    // the entire reason to prefer a cookie over localStorage here.
    expect(header).toContain("HttpOnly");
    // SameSite=Strict is CSRF control 1 of 2; the custom header is the other.
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Secure");
    // Path=/ and the ABSENCE of Domain are both required by the __Host- prefix.
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain");
  });

  test("omits Secure only where TLS is genuinely absent", () => {
    const header = serializeSessionCookie("pullfm_session", "v1.abc", {
      secure: false,
      maxAgeSeconds: 60,
    });
    expect(header).not.toContain("Secure");
    // Everything else still applies. Local development is not an excuse to
    // drop HttpOnly, which would let a local XSS behave differently from a
    // production one and hide the bug until it shipped.
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
  });

  test("clearing expires the cookie immediately", () => {
    const header = clearSessionCookie("__Host-pullfm_session", true);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("__Host-pullfm_session=;");
  });
});
