/**
 * Builds a real application for the integration and security suites.
 *
 * The identity provider is the only substituted component, and it is
 * substituted at the JWKS URL, which is a configuration value the application
 * already reads. security/BOLA-TESTING.md section 3 argues this at length; the
 * short version is that token verification, subject extraction, and every
 * ownership predicate then run exactly as they do in production, and the only
 * thing replaced is the party that signs the token. An identity provider is not
 * what an authorization suite is testing.
 *
 * That seam is a total authentication bypass if it is ever reachable in
 * production, so it is closed by three controls. Two are in `loadConfig`
 * (production derives the URL and refuses to boot on a non-WorkOS host); the
 * third is `config.test.ts`, which asserts the assertion, so deleting it fails
 * CI.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { loadConfig, type Config } from "../../src/config.js";
import { buildServer } from "../../src/server.js";
import { buildServices, closeServices } from "../../src/wiring.js";
import type { Services } from "../../src/routes/deps.js";
import type {
  ProviderAdapter,
  ProviderCredential,
  ProviderRegistry,
} from "../../src/services/connections.js";
import { fakeUpstreams, type FakeUpstreams } from "./upstreams.js";
import { testDatabaseUrl } from "./database.js";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

/**
 * A deterministic stand-in for a Last.fm session key: 32 hex characters, which
 * is the shape the BOLA suite's value-shape pattern looks for.
 */
export const FIXTURE_SESSION_KEY = Buffer.from(
  "pullfm-bola-fixture-not-a-credential",
  "utf8",
)
  .toString("hex")
  .slice(0, 32);

const KEY_ID = "test-key-1";
const CLIENT_ID = "client_test_pullfm";

export interface LocalIdp {
  readonly jwksUrl: string;
  readonly issuer: string;
  /** Mints an access token for a WorkOS subject id. */
  mint(
    workosUserId: string,
    opts?: {
      sessionId?: string;
      issuedAtOffsetSeconds?: number;
      expiresInSeconds?: number;
      audience?: string;
      issuer?: string;
    },
  ): Promise<string>;
  /** Signs with a key that is NOT in the published JWKS. */
  mintWithForeignKey(workosUserId: string): Promise<string>;
  close(): Promise<void>;
}

/** Serves a JWKS over loopback and mints tokens against it. */
export async function startLocalIdp(): Promise<LocalIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const foreign = await generateKeyPair("RS256", { extractable: true });

  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: KEY_ID,
    alg: "RS256",
    use: "sig",
  };
  const body = JSON.stringify({ keys: [jwk] });

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/jwks")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${String(port)}`;
  const issuer = `${base}/user_management/${CLIENT_ID}`;

  const sign = async (
    key: SigningKey,
    kid: string | undefined,
    workosUserId: string,
    opts: {
      sessionId?: string;
      issuedAtOffsetSeconds?: number;
      expiresInSeconds?: number;
      audience?: string;
      issuer?: string;
    } = {},
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const iat = now + (opts.issuedAtOffsetSeconds ?? 0);
    let builder = new SignJWT({
      sid: opts.sessionId ?? `session_${workosUserId}`,
    })
      .setProtectedHeader(
        kid === undefined ? { alg: "RS256" } : { alg: "RS256", kid },
      )
      .setSubject(workosUserId)
      .setIssuer(opts.issuer ?? issuer)
      .setIssuedAt(iat)
      .setExpirationTime(now + (opts.expiresInSeconds ?? 900));
    if (opts.audience !== undefined)
      builder = builder.setAudience(opts.audience);
    return builder.sign(key);
  };

  return {
    jwksUrl: `${base}/jwks`,
    issuer,
    mint: (workosUserId, opts) => sign(privateKey, KEY_ID, workosUserId, opts),
    mintWithForeignKey: (workosUserId) =>
      sign(foreign.privateKey, KEY_ID, workosUserId),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A provider adapter that contacts nothing, for the connection fixtures. */
export function mockProviderRegistry(): ProviderRegistry {
  const credential = (account: string): ProviderCredential => ({
    providerAccountId: account,
    // Shaped like a real Last.fm session key (32 hex characters), so the
    // credential-shape assertions in the BOLA suite would actually catch it if
    // a route ever leaked one. Derived rather than written as a hex literal so
    // the secret scanners see the word "fixture" instead of a credential.
    accessToken: FIXTURE_SESSION_KEY,
    scopes: ["read"],
  });

  const adapter = (name: string): ProviderAdapter => ({
    authorizeUrl: (state, callbackUrl) =>
      `https://provider.invalid/authorize?state=${encodeURIComponent(state)}&cb=${encodeURIComponent(callbackUrl)}`,
    completeCallback: (query) =>
      Promise.resolve(credential(`${name}_${query["account"] ?? "acct"}`)),
    verifyDirect: (raw) =>
      Promise.resolve(credential(`${name}_${raw.slice(0, 8)}`)),
  });

  return { lastfm: adapter("lastfm"), listenbrainz: adapter("listenbrainz") };
}

export interface RoutedOperation {
  readonly method: string;
  readonly url: string;
  readonly hidden: boolean;
}

export interface TestApp {
  readonly app: FastifyInstance;
  /**
   * Every music provider, faked. Exposed so a suite can assert what was NOT
   * called: a warm cache must produce zero upstream calls, and no request path
   * may reach MusicBrainz or iTunes at all.
   */
  readonly upstreams: FakeUpstreams;
  /** Every route the ROUTER holds, as seen by Fastify rather than by the spec. */
  readonly routes: RoutedOperation[];
  readonly services: Services;
  readonly cfg: Config;
  readonly idp: LocalIdp;
  /** The WorkOS stand-in. Register addresses and read the codes it "sent". */
  readonly workos: WorkOsStub;
  readonly webhookSecret: string;
  close(): Promise<void>;
}

export const TEST_WEBHOOK_SECRET = "whsec_test_not_a_real_secret_value";

export interface TestAppOptions {
  readonly maintenanceMode?: boolean;
  readonly env?: Record<string, string>;
  /**
   * Overrides for the scheduled jobs' knobs.
   *
   * Separate from `env` because it is a separate mechanism: `env` feeds
   * `loadConfig`, and the job windows are deliberately not in that schema (see
   * src/lib/job-env.ts). This reaches `buildServices`, so a suite can assert
   * that an operator's override lands on the instance the entrypoint runs.
   */
  readonly jobEnv?: NodeJS.ProcessEnv;
}

export async function buildTestApp(
  opts: TestAppOptions = {},
): Promise<TestApp> {
  const idp = await startLocalIdp();

  const cfg = loadConfig({
    NODE_ENV: "test",
    DEPLOY_ENV: "local",
    LOG_LEVEL: "silent",
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379",
    REDIS_QUOTA_URL: process.env["REDIS_QUOTA_URL"] ?? "redis://127.0.0.1:6380",
    CREDENTIAL_KEKS: `kek:test=${Buffer.alloc(32, 11).toString("base64")}`,
    CREDENTIAL_ACTIVE_KEK_ID: "kek:test",
    WORKOS_CLIENT_ID: CLIENT_ID,
    WORKOS_API_KEY: "sk_test_fixture_harness",
    WORKOS_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    WORKOS_JWKS_URL: idp.jwksUrl,
    WORKOS_API_BASE_URL: idp.jwksUrl.replace(/\/jwks$/, ""),
    MUSICBRAINZ_USER_AGENT: "PullFM/0.1.0 (test@pull.fm)",
    // Both halves of the discovery blend are exercised: without a Last.fm key
    // the enrichment branch is never entered and half the merge logic in
    // packages/discovery is dead code as far as the integration suites are
    // concerned. Neither value reaches a real provider; see upstreams.ts.
    LASTFM_API_KEY: "lastfm-fixture-key-not-a-credential",
    LASTFM_SHARED_SECRET: "lastfm-fixture-secret-not-a-credential",
    // Events are enabled so the compliance assertions (session-only, logo
    // attribution, coverage) run against a live route rather than a 501.
    SEATGEEK_CLIENT_ID: "seatgeek-fixture-client-id-not-a-secret",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    // The global per-IP floor is not what these suites test, and every request
    // in them arrives from 127.0.0.1. Left at its default the suite would
    // eventually throttle itself, which would look like an authorization
    // failure. The limiter has its own dedicated test.
    RATE_LIMIT_MAX: "100000",
    // The anti-enumeration timing floor is a real control with its own test,
    // which builds an application that sets it. Leaving it on by default would
    // add a quarter of a second to every sign-in in every other suite for no
    // assertion, which is how a suite becomes slow enough that people stop
    // running it.
    AUTH_START_FLOOR_MS: "0",
    MAINTENANCE_MODE: opts.maintenanceMode === true ? "true" : "false",
    ...opts.env,
  });

  const upstreams = fakeUpstreams();
  const workos = workOsStub({
    mintAccessToken: (workosUserId, sessionId) =>
      idp.mint(workosUserId, { sessionId }),
  });

  const services = buildServices(
    cfg,
    { error: () => undefined, warn: () => undefined },
    {
      providers: mockProviderRegistry(),
      // Every WorkOS REST call is answered locally by the stand-in above. The
      // signature-verified webhook path and the JWT path are the
      // security-relevant parts and both run for real.
      fetchImpl: workos.fetch,
      // The music providers are answered locally too, and this one is not a
      // convenience: MusicBrainz blocks IPs and Apple has no appeals process,
      // so a suite that reached them could cost the project its API access.
      upstreamFetch: upstreams.fetch,
      // An EMPTY environment by default, not `process.env`: a suite must assert
      // the shipped defaults, and a stray WARM_* or AUDIT_* variable in a
      // developer's shell would otherwise silently retune a retention window
      // mid-run and turn a real failure into a green test.
      jobEnv: opts.jobEnv ?? {},
    },
  );

  const routes: RoutedOperation[] = [];
  const app = await buildServer(cfg, {
    services,
    enableDocsBrowser: false,
    onRouteRegistered: ({ method, url, hidden }) => {
      for (const m of Array.isArray(method) ? method : [method]) {
        routes.push({ method: m, url, hidden });
      }
    },
  });
  await app.ready();

  return {
    app,
    routes,
    services,
    upstreams,
    cfg,
    idp,
    workos,
    webhookSecret: TEST_WEBHOOK_SECRET,
    async close() {
      await app.close();
      await closeServices(services);
      await idp.close();
    },
  };
}

/**
 * A WorkOS stand-in, in-process.
 *
 * There are no WorkOS credentials in this repository and there never will be,
 * so every suite runs against this. It is deliberately a MOCK OF THE PROVIDER
 * rather than a mock of our client: our client's request construction, status
 * handling, response narrowing, and uniform-failure behaviour all run for real
 * against it, which is where the bugs would be.
 *
 * The properties it reproduces are the ones the tests are actually about:
 *
 *   - A Magic Auth code is single-use. A second exchange of the same code
 *     fails, which is what makes the replay test meaningful rather than a
 *     tautology.
 *   - A code is bound to the address it was minted for.
 *   - A send for an UNKNOWN address AUTO-CREATES an unverified user and answers
 *     200, which is what the live API does (confirmed 2026-07-29). The stub
 *     must reproduce this or every directory-reaper test is vacuous, and the
 *     anti-enumeration assertions would be passing against a behaviour the real
 *     provider does not have.
 *   - Completing a magic-auth exchange flips `email_verified` to true, which is
 *     the state the reaper keys on.
 *   - Refresh tokens rotate, so a replayed refresh token fails.
 */
export interface WorkOsStub {
  readonly fetch: typeof fetch;
  /**
   * Seeds a directory record directly.
   *
   * `verified` and `createdAt` exist so the reaper suite can construct the four
   * cases that matter without waiting a day or faking a clock: verified,
   * unverified and recent, unverified and stale, and a stale record that has a
   * local row.
   */
  register(
    email: string,
    workosUserId: string,
    opts?: { verified?: boolean; createdAt?: Date },
  ): void;
  /** The current directory, for asserting what a sweep did and did not remove. */
  directory(): { id: string; email: string; verified: boolean }[];
  /** The code most recently emailed to an address, as WorkOS would have sent it. */
  codeFor(email: string): string | null;
  /** Expires a live code without consuming it. */
  expire(email: string): void;
  /** Fails the next call to a path containing this fragment, with this status. */
  failNext(fragment: string, status: number): void;
}

interface MagicCode {
  code: string;
  email: string;
  expired: boolean;
}

export interface WorkOsStubOptions {
  /**
   * Mints the access token the stub hands back.
   *
   * Wired to the local IdP so a sign-in through this stub produces a token that
   * the real JWKS verification in plugins/auth.ts accepts. That is what makes
   * the magic-auth suite end to end: the code is requested, exchanged, sealed
   * into a cookie, sent back, opened, and verified, with only the party that
   * signs the token substituted.
   */
  readonly mintAccessToken: (
    workosUserId: string,
    sessionId: string,
  ) => Promise<string>;
}

export function workOsStub(opts: WorkOsStubOptions): WorkOsStub {
  const users = new Map<
    string,
    {
      id: string;
      first: string | null;
      last: string | null;
      /** WorkOS `email_verified`. Auto-created records start false. */
      verified: boolean;
      createdAt: Date;
    }
  >();
  const codes = new Map<string, MagicCode>();
  const refreshTokens = new Map<string, string>();
  const failures: { fragment: string; status: number }[] = [];
  let counter = 0;

  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const issue = async (
    workosUserId: string,
  ): Promise<Record<string, unknown>> => {
    counter += 1;
    const refresh = `refresh_${workosUserId}_${String(counter)}`;
    refreshTokens.set(refresh, workosUserId);
    const entry = [...users.entries()].find(([, u]) => u.id === workosUserId);
    return {
      user: {
        id: workosUserId,
        email: entry?.[0] ?? null,
        first_name: entry?.[1].first ?? null,
        last_name: entry?.[1].last ?? null,
        email_verified: entry?.[1].verified ?? false,
        created_at: entry?.[1].createdAt.toISOString() ?? null,
      },
      access_token: await opts.mintAccessToken(
        workosUserId,
        `session_${workosUserId}_${String(counter)}`,
      ),
      refresh_token: refresh,
    };
  };

  const stub: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const injected = failures.findIndex((f) => url.includes(f.fragment));
    if (injected !== -1) {
      const [failure] = failures.splice(injected, 1);
      return json({ error: "injected" }, failure?.status ?? 500);
    }

    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const body = (bodyText === undefined ? {} : JSON.parse(bodyText)) as Record<
      string,
      unknown
    >;
    /** Reads a field the real API would have sent as a string. */
    const field = (name: string): string => {
      const value = body[name];
      return typeof value === "string" ? value : "";
    };

    if (url.endsWith("/user_management/magic_auth/send")) {
      const email = field("email").toLowerCase();
      counter += 1;

      // The real API AUTO-CREATES a user for an unknown address and answers
      // 200. Confirmed against the live staging environment on 2026-07-29. The
      // stub reproduces it because it is the behaviour the directory reaper
      // exists to compensate for: a stub that refused unknown addresses would
      // make every reaper test vacuous.
      if (!users.has(email)) {
        users.set(email, {
          id: `user_autocreated_${String(counter)}`,
          first: null,
          last: null,
          verified: false,
          createdAt: new Date(),
        });
      }

      codes.set(email, {
        code: `code_${String(counter).padStart(6, "0")}`,
        email,
        expired: false,
      });
      return json({ id: `magic_auth_${String(counter)}` }, 200);
    }

    if (url.endsWith("/user_management/authenticate")) {
      const grant = field("grant_type");

      if (grant === "urn:workos:oauth:grant-type:magic-auth:code") {
        const email = field("email").toLowerCase();
        const supplied = field("code");
        const live = codes.get(email);
        const user = users.get(email);
        if (
          live === undefined ||
          user === undefined ||
          live.expired ||
          live.code !== supplied
        ) {
          return json({ code: "invalid_grant" }, 400);
        }
        // Single use. This is what the replay assertion actually exercises.
        codes.delete(email);
        // Completing the exchange is what proves mailbox control, and it is
        // what makes the record invisible to the reaper from here on.
        user.verified = true;
        return json(await issue(user.id), 200);
      }

      if (grant === "refresh_token") {
        const supplied = field("refresh_token");
        const owner = refreshTokens.get(supplied);
        if (owner === undefined) return json({ code: "invalid_grant" }, 400);
        // Rotation: the presented token dies with the exchange.
        refreshTokens.delete(supplied);
        return json(await issue(owner), 200);
      }

      if (grant === "authorization_code") {
        const code = field("code");
        const email = code.startsWith("valid_") ? code.slice(6) : null;
        const user = email === null ? undefined : users.get(email);
        if (user === undefined) return json({ code: "invalid_grant" }, 400);
        return json(await issue(user.id), 200);
      }

      return json({ code: "unsupported_grant_type" }, 400);
    }

    if (url.includes("/user_management/users?")) {
      const params = new URL(url, "http://stub.invalid").searchParams;
      const limit = Number(params.get("limit") ?? "10");
      const after = params.get("after");

      const ordered = [...users.entries()].sort(
        (a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime(),
      );
      const start =
        after === null ? 0 : ordered.findIndex(([, u]) => u.id === after) + 1;
      const page = ordered.slice(start, start + limit);
      const last = page.at(-1);

      return json(
        {
          data: page.map(([email, u]) => ({
            id: u.id,
            email,
            first_name: u.first,
            last_name: u.last,
            email_verified: u.verified,
            created_at: u.createdAt.toISOString(),
          })),
          list_metadata: {
            after:
              last !== undefined && start + limit < ordered.length
                ? last[1].id
                : null,
          },
        },
        200,
      );
    }

    if (url.includes("/revoke")) return json({ ok: true }, 200);

    const userMatch = /\/user_management\/users\/([^/?]+)$/.exec(url);
    if (userMatch !== null) {
      const id = decodeURIComponent(userMatch[1] ?? "");
      const entry = [...users.entries()].find(([, u]) => u.id === id);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "DELETE") {
        if (entry !== undefined) users.delete(entry[0]);
        return json({ ok: true }, 200);
      }
      if (entry === undefined) return json({ code: "entity_not_found" }, 404);
      if (method === "PUT") {
        if (Object.hasOwn(body, "first_name")) {
          entry[1].first = (body["first_name"] as string | null) ?? null;
        }
        if (Object.hasOwn(body, "last_name")) {
          entry[1].last = (body["last_name"] as string | null) ?? null;
        }
      }
      return json(
        {
          id: entry[1].id,
          email: entry[0],
          first_name: entry[1].first,
          last_name: entry[1].last,
        },
        200,
      );
    }

    return json({ code: "not_found" }, 404);
  };

  return {
    fetch: stub,
    register(email, workosUserId, options = {}) {
      users.set(email.toLowerCase(), {
        id: workosUserId,
        first: null,
        last: null,
        // Seeded records default to VERIFIED, because almost every suite wants
        // a normal signed-in user and an unverified default would quietly make
        // every existing fixture reapable.
        verified: options.verified ?? true,
        createdAt: options.createdAt ?? new Date(),
      });
    },
    directory() {
      return [...users.entries()].map(([email, u]) => ({
        id: u.id,
        email,
        verified: u.verified,
      }));
    },
    codeFor(email) {
      return codes.get(email.toLowerCase())?.code ?? null;
    },
    expire(email) {
      const live = codes.get(email.toLowerCase());
      if (live !== undefined) live.expired = true;
    },
    failNext(fragment, status) {
      failures.push({ fragment, status });
    },
  };
}
