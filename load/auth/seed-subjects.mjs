/**
 * Provisions the synthetic population a load run authenticates as, and writes
 * it to a file k6 reads.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Auth is magic-link only. There is no password grant, no client-credentials
 * flow, and no scripted login. `POST /v1/auth/start` sends an email and is
 * itself rate limited to 10 per IP per hour, so it is not a provisioning path
 * for a thousand subjects even in principle.
 *
 * TWO CREDENTIALS, BECAUSE THE API GENUINELY HAS TWO
 * --------------------------------------------------
 * Personal API tokens are the sane credential for a load runner and the brief
 * asked for them, but they do not reach the whole surface. `requireAuth` admits
 * tokens on `/v1/me`, `/v1/connections`, `GET /v1/wishlist`, `/v1/feed`,
 * `/v1/recommendations`, `/v1/stations` and `/v1/stations/:id/tracks`, and
 * refuses them with 403 everywhere else. `/v1/search`, every `/v1/artists`,
 * `/v1/tracks` and `/v1/albums` lookup, the preview route, and every wishlist
 * write are session-only.
 *
 * Those refused routes are precisely the cache-backed ones: the crosswalk
 * reads, the preview resolution, the search path. A token-only load suite
 * therefore cannot measure the cache gate at all. So each subject gets both:
 *
 *   session   a JWT from load/auth/idp.mjs through the documented JWKS seam
 *   token     a REAL personal API token, minted through POST /v1/tokens using
 *             that session, exactly as a human operator would
 *
 * The token is created through the public API rather than inserted into
 * `api_tokens` directly. That is deliberate: a token row written by hand would
 * skip hashing, scope defaulting and the per-user cap, and the load suite would
 * then be exercising a credential shape that the application never issues.
 *
 * NOTHING HERE IS EVER COMMITTED.
 * -------------------------------
 * The output file holds live credentials for whatever it was pointed at. It is
 * written to `load/.subjects.json` by default, which `.gitignore` already
 * covers via `.env`-adjacent rules plus the explicit entry added for it, and
 * the file is written with mode 0600. `--print` is deliberately absent: a
 * terminal is a log.
 *
 * Usage:
 *   node load/auth/seed-subjects.mjs --count 200
 *   node load/auth/seed-subjects.mjs --count 200 --rate-limit 600
 *   node load/auth/seed-subjects.mjs --clean
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { load } from "../lib/node-deps.mjs";

const { default: pg } = await load("pg");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const COUNT = Number(flag("count", 200));
const BASE_URL = flag(
  "base-url",
  process.env["BASE_URL"] ?? "http://127.0.0.1:3000",
).replace(/\/$/, "");
const OUT = resolve(
  flag("out", process.env["SUBJECTS_FILE"] ?? "load/.subjects.json"),
);
const DATABASE_URL =
  process.env["DATABASE_URL_DIRECT"] ??
  process.env["DATABASE_URL"] ??
  "postgres://pullfm:pullfm_local_dev_not_a_secret@localhost:5432/pullfm";

/**
 * Every synthetic subject is prefixed so `--clean` can find them and so a human
 * looking at the users table can tell load fixtures from real accounts at a
 * glance. It is also what makes this refuse to touch anything it did not make.
 */
const PREFIX = "loadtest_";
const EMAIL_DOMAIN = "loadtest.invalid";

/**
 * Per-token budget requested for the fixtures.
 *
 * The default is 60 requests per minute (`API_TOKEN_DEFAULT_RATE_LIMIT`), which
 * is one request per second per token. That is a correct product default and a
 * hard ceiling on token-driven load: reaching even 50 req/s through tokens
 * needs 50 tokens held at their limit, with every request landing at exactly
 * the wrong moment counted as a 429. The schema maximum is 600.
 *
 * Raising it for fixtures is a load-test configuration, not a code change, and
 * it is recorded in the output file so the run record says which budget the
 * numbers were produced under.
 */
const RATE_LIMIT = Number(flag("rate-limit", 600));

const IDP_URL = flag(
  "idp-url",
  process.env["IDP_URL"] ?? "http://127.0.0.1:8789",
).replace(/\/$/, "");

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });

/**
 * Tokens come from the RUNNING identity provider, never from an in-process
 * import of it.
 *
 * `idp.mjs` generates its signing key at module load, so importing `mint` here
 * would sign with a key that is not the one behind the `/jwks.json` the BFF
 * fetched. Every token would verify perfectly against a key set nobody serves
 * and the BFF would answer 401 with the uniform "credential is not valid",
 * which is exactly as unhelpful as it is supposed to be. Going over HTTP means
 * there is one key, and it is the published one.
 */
async function mint(body) {
  const res = await fetch(`${IDP_URL}/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `identity provider at ${IDP_URL} refused to mint (${res.status}). ` +
        `Start it with: node load/auth/idp.mjs`,
    );
  }
  return (await res.json()).token;
}

async function clean() {
  const { rowCount } = await pool.query(
    `DELETE FROM users WHERE workos_user_id LIKE $1`,
    [`${PREFIX}%`],
  );
  console.error(
    `removed ${rowCount} load-test subject(s) (api_tokens cascade)`,
  );
}

async function seed() {
  const started = Date.now();
  const subjects = [];

  // Users are inserted directly. This is the one place the suite bypasses the
  // API, and it does so because the API has no route that creates a user
  // without an email round trip. The row is exactly what the magic-link
  // callback would have written.
  const values = [];
  const params = [];
  for (let i = 0; i < COUNT; i++) {
    const wid = `${PREFIX}${String(i).padStart(6, "0")}`;
    params.push(wid, `${wid}@${EMAIL_DOMAIN}`, `Load Subject ${i}`);
    values.push(
      `($${params.length - 2}, $${params.length - 1}, $${params.length})`,
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO users (workos_user_id, email, display_name, auth_method, email_verified_at)
       SELECT v.wid, v.email, v.name, 'magic_auth', now()
         FROM (VALUES ${values.join(", ")}) AS v(wid, email, name)
     ON CONFLICT (workos_user_id) DO UPDATE
       SET deleted_at = NULL, email_verified_at = now()
     RETURNING id, workos_user_id`,
    params,
  );
  console.error(`seeded ${rows.length} user(s)`);

  let tokensMinted = 0;
  let tokenFailures = 0;
  let connected = 0;
  let connectFailures = 0;

  for (const row of rows) {
    const sessionId = randomUUID();
    const session = await mint({
      workosUserId: row.workos_user_id,
      sessionId,
      // Longer than any scenario, including the four hour soak, so a run never
      // reports a cliff of 401s that is really the fixtures expiring.
      ttlSeconds: 6 * 3600,
    });

    const subject = {
      id: row.id,
      workosUserId: row.workos_user_id,
      sessionId,
      session,
      token: null,
    };

    // Mint the personal API token through the real route. A failure here is
    // reported rather than fatal: the session half of the fixture is still
    // usable, and a suite that refuses to produce anything because the token
    // endpoint is unhappy is less useful than one that says so.
    try {
      const res = await fetch(`${BASE_URL}/v1/tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: `load-${Date.now().toString(36)}`,
          scopes: ["read:me", "read:wishlist", "read:recommendations"],
          expiresInDays: 1,
        }),
      });
      if (res.ok) {
        const body = await res.json();
        subject.token = body.token;
        subject.tokenId = body.tokenRecord?.id ?? null;
        tokensMinted++;
      } else {
        tokenFailures++;
        if (tokenFailures <= 3) {
          console.error(
            `  token mint failed for ${row.workos_user_id}: ${res.status} ${await res.text()}`,
          );
        }
      }
    } catch (err) {
      tokenFailures++;
      if (tokenFailures <= 3)
        console.error(`  token mint error: ${err.message}`);
    }

    // Connect ListenBrainz, through the real route.
    //
    // WITHOUT THIS THE FEED IS EMPTY FOR EVERY SUBJECT, and that is not a
    // subtle degradation: `/v1/feed`, `/v1/recommendations` and `/v1/stations`
    // are assembled from a user's ListenBrainz data, so an unconnected subject
    // gets `{"sections":[],"degraded":true,"unavailableProviders":["listenbrainz"]}`.
    // A run against unconnected subjects measures the empty-state path at
    // 16 ms and reports excellent latency for a system doing no work. The first
    // steady run made exactly that mistake: 94.9% of feeds came back degraded
    // and the p95 looked wonderful.
    //
    // The token is validated against the provider, which the egress guard
    // rewrites to the mock, so this costs no real upstream quota.
    try {
      const res = await fetch(`${BASE_URL}/v1/connections/listenbrainz`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session}`,
          "content-type": "application/json",
          "idempotency-key": `seed-conn-${row.workos_user_id}`,
        },
        body: JSON.stringify({ token: `lb-load-${row.workos_user_id}` }),
      });
      subject.listenbrainz = res.ok;
      if (res.ok) connected++;
      else if (connectFailures++ < 3) {
        console.error(
          `  listenbrainz connect failed for ${row.workos_user_id}: ${res.status} ${await res.text()}`,
        );
      }
    } catch (err) {
      subject.listenbrainz = false;
      if (connectFailures++ < 3)
        console.error(`  connect error: ${err.message}`);
    }

    subjects.push(subject);
  }

  // The per-token budget is raised in one statement after minting, because the
  // create route has no field for it. Recorded in the manifest so a run cannot
  // quietly claim numbers produced under a budget it does not disclose.
  let rateLimitApplied = 60;
  if (RATE_LIMIT !== 60 && tokensMinted > 0) {
    const { rowCount } = await pool.query(
      `UPDATE api_tokens SET rate_limit_per_minute = $1
         WHERE user_id IN (SELECT id FROM users WHERE workos_user_id LIKE $2)`,
      [RATE_LIMIT, `${PREFIX}%`],
    );
    rateLimitApplied = RATE_LIMIT;
    console.error(
      `raised rate_limit_per_minute to ${RATE_LIMIT} on ${rowCount} token(s)`,
    );
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    count: subjects.length,
    tokensMinted,
    tokenFailures,
    tokenRateLimitPerMinute: rateLimitApplied,
    listenbrainzConnected: connected,
    listenbrainzFailures: connectFailures,
    note:
      "Live credentials. Never commit. Regenerate rather than share; the IdP " +
      "signing key is in memory only, so a restart invalidates every session here.",
    subjects,
  };

  writeFileSync(OUT, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.error(
    `wrote ${subjects.length} subject(s) to ${OUT} ` +
      `(${tokensMinted} with an API token, ${connected} with a ListenBrainz connection) ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (tokenFailures > 0) {
    console.error(
      "  Some tokens could not be minted. The token-authenticated part of the\n" +
        "  mix will be skipped for those subjects; the run record records it.",
    );
  }
}

try {
  if (has("clean")) await clean();
  else await seed();
} finally {
  await pool.end();
}
