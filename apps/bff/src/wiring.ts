/**
 * Dependency construction.
 *
 * Split out of `index.ts` so the security suites can build the identical object
 * graph against a scratch database and a substituted identity provider without
 * duplicating the wiring, and therefore without testing a different application
 * than the one that ships.
 */

import { EnvelopeCipher, parseKek } from "@pull-fm/crypto";
import type { Redis } from "ioredis";

import type { FetchLike } from "@pull-fm/upstream";

import type { Config } from "./config.js";
import { AuditLog } from "./lib/audit.js";
import { Database } from "./lib/db.js";
import { SigningKeys } from "./lib/keys.js";
import { createMaintenanceGate } from "./lib/maintenance.js";
import { Registry } from "./lib/metrics.js";
import { installCollectors, recordProviderEvent } from "./lib/observability.js";
import { createRedis } from "./lib/redis.js";
import { SessionCookieCipher } from "./lib/session-cookie.js";
import { chargeUpstreamCall } from "./lib/upstream-budget.js";
import {
  AuditRetention,
  auditRetentionOptionsFromEnv,
} from "./services/audit-retention.js";
import {
  CacheWarmer,
  cacheWarmerOptionsFromEnv,
} from "./services/cache-warmer.js";
import { DirectoryReaper } from "./services/directory-reaper.js";
import {
  ExpirySweeper,
  expirySweeperOptionsFromEnv,
} from "./services/expiry-sweeper.js";
import { MagicAuthService } from "./services/magic-auth.js";
import {
  ConnectionService,
  type ProviderRegistry,
} from "./services/connections.js";
import { DeletionService } from "./services/deletion.js";
import {
  createErasureLedger,
  type ErasureLedger,
} from "./services/erasure-ledger.js";
import { DiscoveryService } from "./services/discovery.js";
import { EventsService } from "./services/events.js";
import { ExportService } from "./services/export.js";
import { TokenService } from "./services/tokens.js";
import { UserService } from "./services/users.js";
import { WishlistService } from "./services/wishlist.js";
import { WorkOsClient } from "./services/workos.js";
import type { Services } from "./routes/deps.js";
import { buildProviderRegistry } from "./services/providers.js";
import { buildUpstream } from "./services/upstream.js";

/** Minimal logger surface the audit writer needs. */
export interface WiringLogger {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface WiringOverrides {
  readonly db?: Database;
  readonly cacheRedis?: Redis;
  readonly quotaRedis?: Redis;
  readonly providers?: ProviderRegistry;
  readonly fetchImpl?: typeof fetch;
  /**
   * HTTP transport for the upstream music providers.
   *
   * Distinct from `fetchImpl`, which answers WorkOS. Substituted by the test
   * harness so no suite can reach MusicBrainz, Last.fm, iTunes or Deezer: those
   * providers revoke access for exactly the traffic a test suite produces, and
   * MusicBrainz and Apple have no appeals process.
   */
  readonly upstreamFetch?: FetchLike;
  /**
   * Environment the scheduled jobs read their knobs from. Defaults to
   * `process.env`.
   *
   * A seam, not a feature. The job windows are deliberately absent from
   * `config.ts` (see lib/job-env.ts), so without this there would be no way to
   * prove that an operator's override actually reaches the instance on the
   * bundle rather than a second one built next to the scheduler, which is the
   * exact class of bug putting the jobs on the bundle is meant to end.
   */
  readonly jobEnv?: NodeJS.ProcessEnv;
  /**
   * The out-of-band erasure ledger.
   *
   * A seam, and a necessary one: the deletion cascade now refuses to destroy
   * anything until the ledger write has succeeded, and the ONLY way to test
   * that refusal is to make the write fail. A suite cannot do that against a
   * real object store, and a suite that cannot do it is a suite that certifies
   * the happy path of the only irreversible operation in the API.
   */
  readonly erasureLedger?: ErasureLedger;
}

export function buildServices(
  cfg: Config,
  log: WiringLogger,
  overrides: WiringOverrides = {},
): Services {
  const db =
    overrides.db ??
    new Database({
      connectionString: cfg.DATABASE_URL,
      max: cfg.DATABASE_POOL_MAX,
      statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    });

  const cacheRedis =
    overrides.cacheRedis ?? createRedis(cfg.REDIS_URL, "cache");
  const quotaRedis =
    overrides.quotaRedis ?? createRedis(cfg.REDIS_QUOTA_URL, "quota");

  // The KEKs are parsed here rather than in config so a malformed key produces
  // a crypto error naming the key id, at startup, instead of an opaque failure
  // on the first user connection.
  const keks = new Map<string, Buffer>();
  for (const [id, base64] of cfg.CREDENTIAL_KEKS) {
    const [parsedId, key] = parseKek(id, base64);
    keks.set(parsedId, key);
  }
  const cipher = new EnvelopeCipher(keks, cfg.CREDENTIAL_ACTIVE_KEK_ID);

  // Cursor, export-link, and connect-state signing keys are DERIVED from the
  // active KEK with HKDF under distinct labels rather than configured
  // separately. See lib/keys.ts for why that is safe and what it costs.
  const activeKek = keks.get(cfg.CREDENTIAL_ACTIVE_KEK_ID);
  /* c8 ignore next 3 -- loadConfig already rejects an active id that is absent */
  if (activeKek === undefined) {
    throw new Error("active KEK missing after validation");
  }
  const audit = new AuditLog(db, log as never);
  const keys = new SigningKeys(activeKek);
  // Derived from the same root under its own HKDF label, for the reasons in
  // lib/keys.ts: one secret to escrow, domain-separated outputs, and a KEK
  // rotation that costs a re-sign-in rather than a failed rotation.
  const sessionCookies = new SessionCookieCipher(activeKek);

  const workos = new WorkOsClient({
    baseUrl: cfg.workosApiBaseUrl,
    clientId: cfg.WORKOS_CLIENT_ID,
    apiKey: cfg.WORKOS_API_KEY,
    ...(overrides.fetchImpl === undefined
      ? {}
      : { fetchImpl: overrides.fetchImpl }),
  });

  const users = new UserService(db);

  /**
   * The erasure ledger, and the one warning that has to be loud.
   *
   * A deployment with no ledger still deletes accounts - refusing an Article 17
   * erasure because an object-store credential is absent would be a worse
   * compliance outcome than performing it with a ten-minute recovery point -
   * but it must not do so quietly. This is the only place that knows the answer
   * at startup, and "the durability of every erasure on this node is bounded by
   * a timer" is not a fact anybody should have to infer from a missing variable.
   */
  const erasureLedger =
    overrides.erasureLedger ?? createErasureLedger(cfg.erasureLedger);
  if (!erasureLedger.configured && cfg.isProduction) {
    log.warn(
      { deployEnv: cfg.DEPLOY_ENV },
      "no erasure ledger is configured: account deletions will be made durable by the ledger exporter's timer, " +
        "so an erasure followed immediately by a restore can be lost. Set ERASURE_LEDGER_ENDPOINT, " +
        "ERASURE_LEDGER_BUCKET, ERASURE_LEDGER_ACCESS_KEY_ID and ERASURE_LEDGER_SECRET_ACCESS_KEY.",
    );
  }

  const tokens = new TokenService(db, {
    prefix: cfg.apiTokenPrefix,
    maxPerUser: cfg.API_TOKEN_MAX_PER_USER,
    defaultTtlDays: cfg.API_TOKEN_DEFAULT_TTL_DAYS,
    maxTtlDays: cfg.API_TOKEN_MAX_TTL_DAYS,
    defaultRateLimit: cfg.API_TOKEN_DEFAULT_RATE_LIMIT,
  });

  const connections = new ConnectionService(db, cipher, {
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
    providers: overrides.providers ?? buildProviderRegistry(cfg),
  });

  /**
   * The metrics registry, created BEFORE the upstream layer because it has to
   * be: `ProviderClient` takes its observer as a construction option, so a
   * registry built afterwards could only ever be attached to a second set of
   * clients. Every process that calls `buildServices` gets one, including the
   * four scheduled jobs, which is deliberate - a job container is where the
   * MusicBrainz pacer actually does its work.
   */
  const metrics = new Registry();

  /**
   * The maintenance gate. One object, consulted by the request hook, by
   * `GET /v1/config` and by `/metrics`, so those three can never disagree about
   * whether the service is refusing traffic. Three independent reads of the
   * same environment variable is how a status endpoint ends up cheerfully
   * reporting "available" during an outage it is itself serving 503s for.
   */
  const maintenance = createMaintenanceGate({
    envFlag: cfg.MAINTENANCE_MODE,
    flagFile: cfg.MAINTENANCE_FLAG_FILE,
    pollMs: cfg.MAINTENANCE_POLL_MS,
  });

  const upstream = buildUpstream(cfg, db, {
    ...(overrides.upstreamFetch === undefined
      ? {}
      : { fetchImpl: overrides.upstreamFetch }),
    log,
    onEvent: (event) => {
      recordProviderEvent(metrics, event);
      /**
       * The per-subject upstream budget is charged from the SAME event the
       * metric is, and that is the point rather than a convenience.
       *
       * `ProviderClient` emits `request` once per attempt, after the pacer has
       * granted a slot and the local quota counter has been consumed - that is,
       * at the exact moment a unit of a globally scarce budget is spent. Any
       * other definition of "an upstream call happened" would eventually drift
       * from this one, and a budget that disagrees with its own metric is a
       * budget nobody can audit. A retry emits its own `request` and is charged
       * again, because it consumes another real slot.
       *
       * `chargeUpstreamCall` finds the ambient account through an
       * AsyncLocalStorage the request opened, so a call made by a scheduled job
       * charges nobody. See lib/upstream-budget.ts.
       */
      if (event.kind === "request") chargeUpstreamCall();
    },
  });

  installCollectors(metrics, {
    buildSha: cfg.BUILD_SHA,
    deployEnv: cfg.DEPLOY_ENV,
    maintenance: () => maintenance.active(),
    poolStats: () => {
      const s = db.stats();
      return { total: s.total, idle: s.idle, waiting: s.waiting, max: s.max };
    },
    cacheStats: (provider) => upstream.cache.stats(provider as never),
    cacheCoalescing: () => upstream.cache.coalescing,
    crosswalkStats: () => upstream.crosswalk.stats(),
    pacerStats: () => ({
      ...upstream.musicbrainzLimiter.stats,
      queueDepth: upstream.musicbrainzLimiter.queueDepth,
    }),
    providerStatus: () => upstream.status(),
    cacheBytes: async (provider) =>
      (await upstream.cacheStore.sizeOf(provider as never)).bytes,
  });

  const discovery = new DiscoveryService(upstream, connections, keys);

  // The scheduled jobs read their windows from the environment rather than from
  // `cfg`; lib/job-env.ts explains why. Resolved here, once, so that the job an
  // operator's override reaches is the same object the entrypoint runs.
  const jobEnv = overrides.jobEnv ?? process.env;

  return {
    cfg,
    db,
    metrics,
    maintenance,
    cacheRedis,
    quotaRedis,
    keys,
    sessionCookies,
    audit,
    users,
    tokens,
    // Compensates for `magic_auth/send` auto-creating a WorkOS user for any
    // address, which makes the unauthenticated POST /v1/auth/start able to put
    // a personal-data record in the directory for a non-user. Never invoked by
    // a route; the only caller is the scheduled script in scripts/.
    directoryReaper: new DirectoryReaper(db, workos, audit, {
      reapAfterSeconds: cfg.AUTH_UNVERIFIED_REAP_AFTER_S,
      pageSize: cfg.AUTH_UNVERIFIED_REAP_PAGE_SIZE,
      maxDeletionsPerRun: cfg.AUTH_UNVERIFIED_REAP_MAX_DELETIONS,
      maxPagesPerRun: cfg.AUTH_UNVERIFIED_REAP_MAX_PAGES,
    }),
    // The other three scheduled jobs, registered the same way and for the same
    // reason: one construction of the object graph, so the entrypoints in
    // scripts/ run the job the suites exercise. None of them is reachable from
    // a route, and none should be; see the doc comments on `Services`.
    expirySweeper: new ExpirySweeper(db, expirySweeperOptionsFromEnv(jobEnv)),
    auditRetention: new AuditRetention(
      db,
      auditRetentionOptionsFromEnv(jobEnv),
    ),
    // Built from the same `discovery` and `upstream.previewWarmer` the request
    // path uses. Constructing it anywhere else risks warming a cache nothing
    // reads. `previewWarmer` is deliberately not `previews`: it has no Deezer
    // fallback, because a Deezer URL is signed and expiring and so warms
    // nothing.
    cacheWarmer: new CacheWarmer(
      db,
      discovery,
      upstream.previewWarmer,
      cacheWarmerOptionsFromEnv(jobEnv),
    ),
    // Every counter goes to the quota instance, never the cache: on an
    // `allkeys-lru` instance a cache-fill event would silently disable the
    // send and verify budgets, which on this route means an open mail relay.
    magicAuth: new MagicAuthService(workos, quotaRedis, {
      perIpMax: cfg.AUTH_MAGIC_AUTH_PER_IP_MAX,
      perEmailMax: cfg.AUTH_MAGIC_AUTH_PER_EMAIL_MAX,
      verifyMax: cfg.AUTH_MAGIC_AUTH_VERIFY_MAX,
      windowSeconds: cfg.AUTH_MAGIC_AUTH_WINDOW_S,
      floorMs: cfg.AUTH_START_FLOOR_MS,
    }),
    connections,
    wishlist: new WishlistService(db, keys),
    deletion: new DeletionService({
      db,
      workos,
      cacheRedis,
      quotaRedis,
      ledger: erasureLedger,
      log,
    }),
    exports: new ExportService(db, keys, quotaRedis, {
      publicBaseUrl: cfg.PUBLIC_BASE_URL,
      linkTtlSeconds: cfg.EXPORT_LINK_TTL_S,
      cooldownSeconds: cfg.EXPORT_COOLDOWN_S,
    }),
    workos,
    upstream,
    discovery,
    events: new EventsService(upstream),
  };
}

/** Closes everything `buildServices` opened. */
export async function closeServices(services: Services): Promise<void> {
  await Promise.allSettled([
    services.db.close(),
    services.cacheRedis.quit(),
    services.quotaRedis.quit(),
  ]);
}
