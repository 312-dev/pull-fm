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
import { createRedis } from "./lib/redis.js";
import {
  ConnectionService,
  type ProviderRegistry,
} from "./services/connections.js";
import { DeletionService } from "./services/deletion.js";
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
  const keys = new SigningKeys(activeKek);

  const workos = new WorkOsClient({
    baseUrl: cfg.workosApiBaseUrl,
    clientId: cfg.WORKOS_CLIENT_ID,
    apiKey: cfg.WORKOS_API_KEY,
    ...(overrides.fetchImpl === undefined
      ? {}
      : { fetchImpl: overrides.fetchImpl }),
  });

  const users = new UserService(db);

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

  const upstream = buildUpstream(cfg, db, {
    ...(overrides.upstreamFetch === undefined
      ? {}
      : { fetchImpl: overrides.upstreamFetch }),
    log,
  });

  return {
    cfg,
    db,
    cacheRedis,
    quotaRedis,
    keys,
    audit: new AuditLog(db, log as never),
    users,
    tokens,
    connections,
    wishlist: new WishlistService(db, keys),
    deletion: new DeletionService({ db, workos, cacheRedis, quotaRedis }),
    exports: new ExportService(db, keys, quotaRedis, {
      publicBaseUrl: cfg.PUBLIC_BASE_URL,
      linkTtlSeconds: cfg.EXPORT_LINK_TTL_S,
      cooldownSeconds: cfg.EXPORT_COOLDOWN_S,
    }),
    workos,
    upstream,
    discovery: new DiscoveryService(upstream, connections, keys),
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
