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
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  DATABASE_URL: z.string().url(),
  /**
   * Deliberately small. Traffic scales by adding BFF nodes, and every node
   * multiplies into Postgres `max_connections`. PgBouncer in transaction mode
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

  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_API_KEY: z.string().min(1),

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

  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  /** Serves 503 with Retry-After on every route except health. */
  MAINTENANCE_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends Omit<RawConfig, "CREDENTIAL_KEKS"> {
  readonly CREDENTIAL_KEKS: ReadonlyMap<string, string>;
  readonly isProduction: boolean;
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

  return { ...cfg, isProduction: cfg.DEPLOY_ENV === "production" };
}
