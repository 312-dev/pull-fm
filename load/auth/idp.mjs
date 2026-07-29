/**
 * A local identity provider, for load testing only.
 *
 * WHY THIS IS NOT A BACKDOOR
 * --------------------------
 * Auth is magic-link only (docs/PLAN.md, `apps/bff/src/routes/v1/auth.ts`), so
 * there is no scripted login. A load run needs thousands of distinct subjects
 * and cannot obtain a single one by email.
 *
 * `apps/bff/src/config.ts` already anticipates exactly this and calls it "the
 * JWKS seam": `WORKOS_JWKS_URL` and `WORKOS_API_BASE_URL` are honoured OUTSIDE
 * production so that a suite can mint tokens against a key set it controls
 * while the authorization code under test runs completely unmodified. The same
 * seam is what `security/BOLA-TESTING.md` section 3 selects for CI.
 *
 * Three controls close it in production, none of which this file can influence:
 * both values are DERIVED from `WORKOS_CLIENT_ID` when `DEPLOY_ENV=production`
 * so an override is ignored rather than honoured; a boot assertion refuses to
 * start if the effective host is not `api.workos.com`; and a unit test asserts
 * the assertion. So this process is useless against a production BFF by
 * construction, which is the property that makes shipping it acceptable in a
 * public repository.
 *
 * WHAT IT PROVIDES
 * ----------------
 *   GET  /jwks.json      the public key set, what the BFF verifies against
 *   POST /mint           { workosUserId, sessionId?, ttlSeconds? } -> { token }
 *   GET  /__idp/health
 *
 * The signing key is generated fresh at startup and never written to disk.
 * There is no static key material in this repository to leak, and a restart
 * invalidates every token it ever issued.
 *
 * The issuer is assembled to match what `plugins/auth.ts` computes:
 *   `${WORKOS_API_BASE_URL}/user_management/${WORKOS_CLIENT_ID}`
 * so `IDP_URL` must be the same value the BFF was given as its API base.
 */

import http from "node:http";

import { load } from "../lib/node-deps.mjs";

const { exportJWK, generateKeyPair, SignJWT } = await load("jose");

const PORT = Number(process.env["IDP_PORT"] ?? 8789);
const HOST = process.env["IDP_HOST"] ?? "127.0.0.1";
const CLIENT_ID =
  process.env["WORKOS_CLIENT_ID"] ?? "client_01KYMZ05X60BJKZKY5RTA5YP8B";
const PUBLIC_URL = (process.env["IDP_URL"] ?? `http://${HOST}:${PORT}`).replace(
  /\/$/,
  "",
);

const ISSUER = `${PUBLIC_URL}/user_management/${CLIENT_ID}`;
const KID = "pullfm-load-1";

const { publicKey, privateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: KID,
  alg: "RS256",
  use: "sig",
};

/** Mints one access token shaped like the WorkOS one `fromSession` expects. */
export async function mint({ workosUserId, sessionId, ttlSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    // `sid` is optional in the verifier, but including it means the load run
    // exercises the revocation lookup, which is one of the paths that fails
    // CLOSED when the quota Redis is unavailable. Omitting it would skip the
    // very behaviour the fail-closed scenario is trying to observe.
    ...(sessionId === undefined ? {} : { sid: sessionId }),
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(workosUserId)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds);
  return jwt.sign(privateKey);
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://idp.local");

  if (url.pathname === "/jwks.json") {
    return json(res, 200, { keys: [jwk] });
  }
  if (url.pathname === "/__idp/health") {
    return json(res, 200, { ok: true, issuer: ISSUER, kid: KID });
  }
  if (url.pathname === "/mint" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 8192) req.destroy();
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { error: "invalid_json" });
      }
      if (typeof parsed.workosUserId !== "string" || !parsed.workosUserId) {
        return json(res, 400, { error: "workosUserId required" });
      }
      mint(parsed).then(
        (token) => json(res, 200, { token, issuer: ISSUER }),
        (err) => json(res, 500, { error: String(err) }),
      );
    });
    return undefined;
  }
  return json(res, 404, { error: "not_found" });
});

// Only listen when run directly; `seed-subjects.mjs` imports `mint` instead of
// paying for a network hop per token.
if (process.argv[1] && process.argv[1].endsWith("idp.mjs")) {
  server.listen(PORT, HOST, () => {
    console.error(
      `[idp] load-test identity provider on http://${HOST}:${PORT}\n` +
        `[idp] issuer  ${ISSUER}\n` +
        `[idp] point the BFF at it with:\n` +
        `[idp]   WORKOS_API_BASE_URL=${PUBLIC_URL} WORKOS_JWKS_URL=${PUBLIC_URL}/jwks.json`,
    );
  });
}

export { ISSUER, jwk, server };
