/**
 * Configuration, validated once at startup.
 *
 * The rule here is fail-fast: a missing or malformed value must crash the
 * process before it serves a request, never surface as a confusing 500 under
 * load. Everything is parsed through a schema so a typo in a Nomad variable is
 * a startup error with a clear message rather than `undefined` propagating into
 * an upstream call.
 *
 * No secret is ever defaulted. A default for a credential is how a staging key
 * silently ends up serving production traffic.
 */

import { z } from "zod";

/** Comma-separated `id:base64key` pairs, e.g. "kek:v1=BASE64,kek:v2=BASE64". */
const kekSetSchema = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const entries = new Map<string, string>();
    for (const pair of raw.split(",")) {
      const trimmed = pair.trim();
      if (trimmed === "") continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `KEK entry "${trimmed}" must be in the form id=base64key`,
        });
        return z.NEVER;
      }
      entries.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
    if (entries.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one KEK must be configured",
      });
      return z.NEVER;
    }
    return entries;
  });

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  /** staging and production are distinct deployments of NODE_ENV=production. */
  DEPLOY_ENV: z.enum(["local", "staging", "production"]).default("local"),

  /**
   * Git commit this image was built from, baked in at build time.
   *
   * Surfaced by /healthz so a deploy can be verified from outside the box, by
   * anything that can reach the public URL, without SSH and without trusting
   * the deployer's own report that it worked. The staging deploy job asserts on
   * exactly this value; see .github/workflows/deploy-staging.yml.
   */
  BUILD_SHA: z.string().default("unknown"),

  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  /**
   * `silent` is included because the test suites need it. It is deliberately
   * NOT usable in production: the cross-field check in loadConfig rejects it
   * there, because a service that logs nothing cannot be investigated and Gate
   * 3 requires 24 hours of logs to grep to zero, which presupposes logs.
   */
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  /**
   * POOLED connection string. In a cloud environment this is Neon's `-pooler`
   * host; locally it is PgBouncer on 6432. Both are PgBouncer in transaction
   * mode, which is the point: local development meets the same connection
   * semantics production does.
   */
  DATABASE_URL: z.string().url(),
  /**
   * DIRECT connection string, bypassing the pooler. Optional here because the
   * API server itself never needs it; it exists in the environment so the
   * migration step of a deploy can pick it up (see
   * packages/db/scripts/migrate.mjs, which takes a SESSION-level advisory lock
   * that a transaction pooler silently breaks). Validated rather than ignored
   * so a malformed value fails at startup instead of at 3am mid-deploy.
   */
  DATABASE_URL_DIRECT: z.string().url().optional(),
  /**
   * Deliberately small. Traffic scales by adding BFF nodes, and every node
   * multiplies into the server's connection limit. A transaction-mode pooler
   * is what actually absorbs concurrency; a large per-node pool just exhausts
   * the server sooner. See docs/PLAN.md Gate 1.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),

  /** Cache store. Evictable (`allkeys-lru`); losing a key is a cache miss. */
  REDIS_URL: z.string().url(),

  /**
   * Quota and rate-limit store. MUST be a separate instance configured with
   * `noeviction`, not a second logical database on the cache instance.
   *
   * Eviction policy in Redis is per-instance, not per-database. If counters
   * share an `allkeys-lru` instance with the cache, a cache-fill event evicts
   * them and every rate limit fails OPEN with no error and no alert, leaving
   * the abuse protections silently absent. See THREAT-MODEL T11.
   */
  REDIS_QUOTA_URL: z.string().url(),

  /** Envelope encryption keys for the per-user credential vault. */
  CREDENTIAL_KEKS: kekSetSchema,
  CREDENTIAL_ACTIVE_KEK_ID: z.string().min(1),

  /**
   * Public origin this API is reached at, e.g. https://api-staging.pull.fm.
   *
   * Used to build the connect-flow callback URL handed to Last.fm and the
   * single-use export download link. Both are compared for exact equality on
   * the way back in, so a wrong value fails closed rather than silently
   * accepting a foreign redirect target.
   */
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),

  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_API_KEY: z.string().min(1),

  /**
   * Magic Auth abuse budgets, counted in the QUOTA Redis (`noeviction`).
   *
   * Two dimensions, because they stop different attacks and neither one
   * subsumes the other:
   *
   *   PER_IP     one host enumerating or spraying many addresses.
   *   PER_EMAIL  many hosts pointed at one address, which is mailbox flooding
   *              and is the shape a botnet produces. A per-IP limit alone does
   *              not see it at all.
   *
   * The verify budget is separate and much tighter, because a Magic Auth code
   * is short and guessable at volume in a way that a request for one is not.
   */
  AUTH_MAGIC_AUTH_PER_IP_MAX: z.coerce.number().int().positive().default(10),
  AUTH_MAGIC_AUTH_PER_EMAIL_MAX: z.coerce.number().int().positive().default(5),
  AUTH_MAGIC_AUTH_VERIFY_MAX: z.coerce.number().int().positive().default(10),
  AUTH_MAGIC_AUTH_WINDOW_S: z.coerce.number().int().positive().default(3600),

  /**
   * Floor on how long POST /v1/auth/start takes to answer, in milliseconds.
   *
   * The route must not disclose whether an address has an account, and the
   * response body alone does not achieve that: an upstream that answers a known
   * address in 400ms and an unknown one in 40ms leaks the same fact through the
   * clock. Padding every response up to a fixed floor removes the correlation
   * that a caller can actually measure. It is not a constant-time guarantee and
   * is not claimed as one; see services/magic-auth.ts.
   */
  AUTH_START_FLOOR_MS: z.coerce.number().int().nonnegative().default(250),

  /**
   * Directory reaper: how long an unverified WorkOS record may live.
   *
   * `magic_auth/send` CREATES a user for an unknown address, and
   * POST /v1/auth/start is unauthenticated, so without this an anonymous caller
   * can cause a personal-data record to exist for someone who never consented.
   * The send budgets above bound the rate; this bounds the duration.
   *
   * 24 hours: two orders of magnitude above the 10 minute code lifetime, so a
   * person who asks for a code before lunch and finishes after is never racing
   * the job, and short enough that an unconsented record does not outlive a
   * day. Reaping is not destructive, because a later send simply recreates the
   * record, which is why this errs short. Full argument in
   * services/directory-reaper.ts.
   */
  AUTH_UNVERIFIED_REAP_AFTER_S: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 3600),
  /** Blast-radius cap on one sweep, not a throughput knob. */
  AUTH_UNVERIFIED_REAP_MAX_DELETIONS: z.coerce
    .number()
    .int()
    .positive()
    .default(500),
  AUTH_UNVERIFIED_REAP_PAGE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(100),
  AUTH_UNVERIFIED_REAP_MAX_PAGES: z.coerce
    .number()
    .int()
    .positive()
    .default(50),

  /**
   * Lifetime of the sealed session cookie.
   *
   * Bounds the cookie, not the WorkOS session: the access token inside it
   * expires on WorkOS's schedule and the refresh token is what the cookie is
   * really carrying. This is the outer limit past which the cookie is refused
   * without decrypting anything.
   */
  SESSION_COOKIE_TTL_S: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 3600),

  /**
   * Shared secret for `POST /v1/webhooks/workos` signature verification.
   *
   * Optional in configuration but never optional in effect: without it the
   * webhook route refuses every request with 503, and in production startup
   * fails outright (see the cross-field check in loadConfig). An unverified
   * webhook handler is an unauthenticated mass-deletion endpoint, because
   * `user.deleted` cascades through the credential vault. See THREAT-MODEL T20.
   */
  WORKOS_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Override for the WorkOS API origin and the JWKS endpoint.
   *
   * These exist for one reason: the BOLA and auth suites need to mint tokens
   * against a JWKS they control, so the authorization code under test runs
   * completely unmodified while only the identity provider is substituted
   * (security/BOLA-TESTING.md section 3, option B).
   *
   * That seam is a total authentication bypass if it is ever reachable in
   * production, so it is closed by three independent controls, two of which
   * live in loadConfig below:
   *
   *   1. In production both values are IGNORED and derived from
   *      WORKOS_CLIENT_ID, so they are not operator-settable at all.
   *   2. A startup assertion refuses to boot if the effective host is not the
   *      WorkOS host. Fail closed at boot, not at first request.
   *   3. A test asserts the assertion, so deleting it fails CI.
   */
  WORKOS_API_BASE_URL: z.string().url().default("https://api.workos.com"),
  WORKOS_JWKS_URL: z.string().url().optional(),

  /** Serves the self-hosted OpenAPI browser at /docs. */
  DOCS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * Personal API tokens.
   *
   * A cap per user exists because an uncapped list of long-lived credentials is
   * how a compromised account keeps its foothold after the password (here, the
   * social identity) is recovered.
   */
  API_TOKEN_MAX_PER_USER: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(10),
  API_TOKEN_DEFAULT_TTL_DAYS: z.coerce.number().int().positive().default(90),
  API_TOKEN_MAX_TTL_DAYS: z.coerce.number().int().positive().default(365),
  /** Default per-token requests per minute, counted in the quota Redis. */
  API_TOKEN_DEFAULT_RATE_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .max(600)
    .default(60),

  /**
   * How recently the caller must have authenticated for DELETE /v1/me.
   *
   * Account deletion is the only irreversible operation in the API, so it
   * requires a proof of recent authentication rather than merely a valid
   * session (THREAT-MODEL M16).
   */
  DELETE_FRESH_AUTH_MAX_AGE_S: z.coerce.number().int().positive().default(900),

  /** Minimum gap between two export requests by the same subject (M17/API4). */
  EXPORT_COOLDOWN_S: z.coerce.number().int().positive().default(300),
  /** Lifetime of the single-use export download link. */
  EXPORT_LINK_TTL_S: z.coerce.number().int().positive().default(600),

  /**
   * MusicBrainz requires a descriptive User-Agent identifying the application
   * and a contact address, and throttles generic agents harder. This is a
   * licence condition, not a nicety, so it is required rather than defaulted.
   */
  MUSICBRAINZ_USER_AGENT: z
    .string()
    .regex(
      /^[\w.-]+\/[\d.]+ \(.+\)$/,
      'must look like "PullFM/0.1.0 (contact@example.com)"',
    ),

  LASTFM_API_KEY: z.string().min(1).optional(),
  LASTFM_SHARED_SECRET: z.string().min(1).optional(),

  /**
   * Last.fm's terms cap cached Last.fm data at 100 MB (ToS 4.3.4). We alert
   * below the cap rather than at it, so eviction has time to act.
   */
  LASTFM_CACHE_CAP_MB: z.coerce.number().positive().default(80),

  /**
   * SeatGeek, the live-events provider.
   *
   * Absent client id disables `GET /v1/artists/:mbid/events` outright: the
   * route answers 501, which is a stable "this deployment has no events
   * provider" rather than an empty list that looks like "this artist is not
   * touring". The two are different answers and a client renders them
   * differently.
   *
   * The client id is 35 characters and the secret is 64. Only the secret is a
   * credential, but the id is still kept out of URLs and logs (see the Basic
   * auth reasoning in packages/upstream/src/seatgeek/client.ts).
   */
  SEATGEEK_CLIENT_ID: z.string().min(1).optional(),
  SEATGEEK_CLIENT_SECRET: z.string().min(1).optional(),

  /**
   * Runtime kill switch for the events provider.
   *
   * Separate from the credential being absent because the two situations are
   * operationally different: absent credentials are a deployment that never had
   * events, while this flag is the lever to pull the moment SeatGeek write to
   * say our use breaches their terms. Their terms make "stop now" a legal
   * obligation measured in hours, not deploy cycles, so it must be a
   * configuration flip rather than a code change.
   *
   * IT DEFAULTS TO OFF, AND IT USED TO DEFAULT TO ON. Defaulting to on meant
   * the flag was not a kill switch at all: it was a formality that any
   * deployment holding a SeatGeek client id had already bypassed. Staging
   * proved it on 2026-07-29, reporting `features.events: true` and
   * `providers.events: ok` while docs/PLAN.md §3 and §11.7 both say the route
   * is 501 pending Gate L.
   *
   * Gate L is not an engineering gate and it has not passed: the DPAs are
   * unsigned, no EU Article 27 representative is appointed, and the EULA that
   * has to name the SeatGeek Entities as third-party beneficiaries under their
   * clause 4.3 is not published. Serving events before those are true is a
   * breach of their terms, not a missing feature, so the failure mode of a
   * forgotten environment variable must be "off". Turning events ON is now the
   * act that takes a deliberate `SEATGEEK_ENABLED=true`; turning them off
   * remains a config flip and a restart, which is what the hours-not-deploys
   * obligation above actually requires.
   */
  SEATGEEK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  /**
   * Global per-IP request ceiling.
   *
   * A floor, not the real control: personal API tokens carry their own budget
   * and the routes that spend metered upstream quota get tighter limits. Kept
   * configurable because the right value differs between a staging box running
   * a load suite and a production node behind Cloudflare.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),

  /** Serves 503 with Retry-After on every route except health and metrics. */
  MAINTENANCE_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * A path whose EXISTENCE also means maintenance, checked at runtime.
   *
   * The environment variable needs a restart to change; this does not. Gate 6
   * asserts a flip in both directions inside sixty seconds, and a restart
   * cannot honestly claim the "cleared -> 200" half, because the gap between
   * container stop and container ready is connection failures rather than an
   * honest 503. Empty disables the lever. See lib/maintenance.ts.
   */
  MAINTENANCE_FLAG_FILE: z.string().default(""),

  /** How long a filesystem answer for the flag file may be reused. */
  MAINTENANCE_POLL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(1_000),

  /**
   * Bearer token required to scrape `/metrics`.
   *
   * `/metrics` reports pool depth, breaker state, upstream budgets and cache
   * ratios. None of that is a credential and all of it is reconnaissance, and
   * the origin's nginx serves `location /` to the edge, so without this the
   * endpoint is public the moment it stops being a stub.
   *
   * Loopback callers are exempt, checked against the SOCKET's peer address
   * rather than `req.ip`. That distinction is the whole control: `trustProxy`
   * is on, so `req.ip` is the leftmost `X-Forwarded-For` entry and any client
   * on earth can set it to 127.0.0.1. The socket address cannot be forged by an
   * HTTP header. It is what lets the node-local watchdog scrape with no
   * credential at all while the same endpoint stays shut from the edge.
   */
  METRICS_TOKEN: z.string().default(""),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends Omit<RawConfig, "CREDENTIAL_KEKS"> {
  readonly CREDENTIAL_KEKS: ReadonlyMap<string, string>;
  readonly isProduction: boolean;
  /** Effective JWKS endpoint after the production derivation below. */
  readonly workosJwksUrl: string;
  /** Effective WorkOS API origin after the production derivation below. */
  readonly workosApiBaseUrl: string;
  /** Token prefix for this deployment: `pfm_live` or `pfm_test`. */
  readonly apiTokenPrefix: "pfm_live" | "pfm_test";
  /** True when the events route has both a credential and the switch on. */
  readonly eventsEnabled: boolean;
  /** Name of the sealed session cookie. `__Host-` prefixed where it can be. */
  readonly sessionCookieName: string;
  /** Whether the session cookie carries `Secure`. False only on plain-HTTP local. */
  readonly sessionCookieSecure: boolean;
}

/**
 * The session cookie name, which is a security control rather than a label.
 *
 * The `__Host-` prefix is enforced by the browser, not by us: a cookie carrying
 * it is refused unless it is `Secure`, has `Path=/`, and has NO `Domain`
 * attribute. That last part is the one that matters here. Without it, a
 * compromised or hostile sibling host under the registrable domain can set a
 * `Domain=.pull.fm` cookie of the same name and shadow ours, which is a session
 * fixation vector that no amount of server-side care detects.
 *
 * It cannot be used over plain HTTP, so local development gets the unprefixed
 * name. The prefix is therefore derived from the deployment rather than
 * configured, so a staging or production node cannot be talked out of it.
 */
export function sessionCookieNameFor(secure: boolean): string {
  return secure ? "__Host-pullfm_session" : "pullfm_session";
}

/** The only host WorkOS identity material may ever be fetched from. */
export const WORKOS_HOST = "api.workos.com";

/** JWKS endpoint for a WorkOS client id. Derived, never configured, in prod. */
export function workosJwksUrlFor(clientId: string): string {
  return `https://${WORKOS_HOST}/sso/jwks/${encodeURIComponent(clientId)}`;
}

/**
 * Parses and validates the environment.
 *
 * Errors are aggregated so a fresh deployment reports every missing variable at
 * once instead of one per restart cycle.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Thrown, not logged: the logger may not exist yet, and this must be fatal.
    throw new Error(`invalid configuration:\n${details}`);
  }

  const cfg = result.data;

  // Cross-field check that the schema cannot express: the active key must be
  // one of the configured keys, or every write fails at runtime instead of now.
  if (!cfg.CREDENTIAL_KEKS.has(cfg.CREDENTIAL_ACTIVE_KEK_ID)) {
    throw new Error(
      `invalid configuration:\n  CREDENTIAL_ACTIVE_KEK_ID: "${cfg.CREDENTIAL_ACTIVE_KEK_ID}" is not present in CREDENTIAL_KEKS ` +
        `(configured: ${[...cfg.CREDENTIAL_KEKS.keys()].join(", ")})`,
    );
  }

  // A wildcard CORS origin on an API that serves per-user data would let any
  // site read it with the user's credentials.
  if (cfg.DEPLOY_ENV !== "local" && cfg.CORS_ORIGINS.includes("*")) {
    throw new Error(
      "invalid configuration:\n  CORS_ORIGINS: wildcard is not permitted outside local development",
    );
  }

  const isProduction =
    cfg.DEPLOY_ENV === "production" || cfg.NODE_ENV === "production";

  // --- The JWKS seam, closed ------------------------------------------------
  // Control 2 of three (security/BOLA-TESTING.md section 3): in production the
  // identity endpoints are DERIVED from the WorkOS client id, which is already
  // required configuration, so there is no operator-settable value to get
  // wrong. An override present in the environment is ignored rather than
  // honoured, because honouring it is a complete authentication bypass.
  const workosJwksUrl = isProduction
    ? workosJwksUrlFor(cfg.WORKOS_CLIENT_ID)
    : (cfg.WORKOS_JWKS_URL ?? workosJwksUrlFor(cfg.WORKOS_CLIENT_ID));
  const workosApiBaseUrl = isProduction
    ? `https://${WORKOS_HOST}`
    : cfg.WORKOS_API_BASE_URL;

  // Control 1 of three: fail closed at boot rather than at first request. If
  // the derivation above were ever weakened, this still refuses to start.
  if (isProduction) {
    for (const [name, value] of [
      ["WORKOS_JWKS_URL", workosJwksUrl],
      ["WORKOS_API_BASE_URL", workosApiBaseUrl],
    ] as const) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== WORKOS_HOST) {
        throw new Error(
          `invalid configuration:\n  ${name}: must be https://${WORKOS_HOST} in production, got "${value}". ` +
            "A non-WorkOS identity endpoint in production is a complete authentication bypass.",
        );
      }
    }

    if (cfg.LOG_LEVEL === "silent") {
      throw new Error(
        "invalid configuration:\n  LOG_LEVEL: silent is not permitted in production. " +
          "Gate 3 requires 24 hours of logs to grep to zero, which presupposes logs.",
      );
    }

    // An unverified WorkOS webhook is an unauthenticated mass-deletion
    // endpoint (THREAT-MODEL T20), so production refuses to start without the
    // signing secret rather than serving a route that cannot be trusted.
    if (cfg.WORKOS_WEBHOOK_SECRET === undefined) {
      throw new Error(
        "invalid configuration:\n  WORKOS_WEBHOOK_SECRET: required in production. " +
          "Without it POST /v1/webhooks/workos cannot verify signatures, and it handles user.deleted.",
      );
    }
  }

  // Derived, never configured: see sessionCookieNameFor. A deployment that is
  // not local is reached over TLS, so the cookie gets `Secure` and therefore
  // can carry the `__Host-` prefix.
  const sessionCookieSecure = cfg.DEPLOY_ENV !== "local";

  return {
    ...cfg,
    isProduction,
    workosJwksUrl,
    workosApiBaseUrl,
    apiTokenPrefix: cfg.DEPLOY_ENV === "production" ? "pfm_live" : "pfm_test",
    eventsEnabled: cfg.SEATGEEK_ENABLED && cfg.SEATGEEK_CLIENT_ID !== undefined,
    sessionCookieSecure,
    sessionCookieName: sessionCookieNameFor(sessionCookieSecure),
  };
}
