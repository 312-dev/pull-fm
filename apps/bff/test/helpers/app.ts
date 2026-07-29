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
  /** Every route the ROUTER holds, as seen by Fastify rather than by the spec. */
  readonly routes: RoutedOperation[];
  readonly services: Services;
  readonly cfg: Config;
  readonly idp: LocalIdp;
  readonly webhookSecret: string;
  close(): Promise<void>;
}

export const TEST_WEBHOOK_SECRET = "whsec_test_not_a_real_secret_value";

export interface TestAppOptions {
  readonly maintenanceMode?: boolean;
  readonly env?: Record<string, string>;
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
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    // The global per-IP floor is not what these suites test, and every request
    // in them arrives from 127.0.0.1. Left at its default the suite would
    // eventually throttle itself, which would look like an authorization
    // failure. The limiter has its own dedicated test.
    RATE_LIMIT_MAX: "100000",
    MAINTENANCE_MODE: opts.maintenanceMode === true ? "true" : "false",
    ...opts.env,
  });

  const services = buildServices(
    cfg,
    { error: () => undefined, warn: () => undefined },
    {
      providers: mockProviderRegistry(),
      // WorkOS REST calls (session revocation, user deletion) are answered
      // locally. The signature-verified webhook path and the JWT path are the
      // security-relevant parts and both run for real.
      fetchImpl: stubWorkOsFetch,
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
    cfg,
    idp,
    webhookSecret: TEST_WEBHOOK_SECRET,
    async close() {
      await app.close();
      await closeServices(services);
      await idp.close();
    },
  };
}

/** Answers the four WorkOS REST calls this application makes. */
const stubWorkOsFetch: typeof fetch = (input) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.includes("/revoke") || url.includes("/user_management/users/")) {
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
};
