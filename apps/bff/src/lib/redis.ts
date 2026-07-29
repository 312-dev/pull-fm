/**
 * The two Redis clients, and why there are two.
 *
 * THREAT-MODEL T11 is the highest-likelihood misconfiguration in this system,
 * and it is not exotic: eviction policy in Redis is per instance, not per
 * database. The cache wants `allkeys-lru`, because losing a cached artist is a
 * cache miss. Quota counters want `noeviction`, because losing a counter is a
 * rate limit that fails OPEN with no error, no alert, and no signal of any kind
 * while the abuse protections are simply absent.
 *
 * Putting both on one instance means a cache-fill event silently disables rate
 * limiting. So there are two clients here, they are not interchangeable, and
 * the quota client is the one that fails CLOSED.
 */

import { Redis, type RedisOptions } from "ioredis";

export type RedisRole = "cache" | "quota";

function baseOptions(role: RedisRole): RedisOptions {
  return {
    /**
     * A limiter that queues forever under a Redis outage is a latency bomb on
     * every request, so retries are capped low: once they are exhausted the
     * command REJECTS, and the quota path turns that rejection into a 503
     * rather than into a silently skipped check.
     *
     * The offline queue is left ENABLED, which looks like the opposite of
     * failing closed and is not. With it disabled, every command issued between
     * process start and the first successful connection fails immediately, so a
     * node that has just booted rejects real traffic for the duration of a TCP
     * handshake. With it enabled and the retry count capped, a command issued
     * during a genuine outage still rejects, just after a bounded delay. The
     * failure mode is the same; the startup race is gone.
     */
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    commandTimeout: role === "quota" ? 1_000 : 2_000,
  };
}

export function createRedis(url: string, role: RedisRole): Redis {
  const client = new Redis(url, baseOptions(role));
  // Without a listener an ECONNREFUSED on a background reconnect is an
  // unhandled 'error' event, which terminates the process.
  client.on("error", () => {
    /* surfaced to callers as a rejected command */
  });
  return client;
}

/** Answers PING. Used by /readyz so a failure names the culprit. */
export async function redisHealthy(client: Redis): Promise<boolean> {
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fixed-window counter increment, evaluated server side in one round trip.
 *
 * A fixed window is chosen over a sliding log because the value being protected
 * is a per-token request budget, where an at-most-2x burst across a window
 * boundary is acceptable and a per-request sorted-set write is not. The script
 * is atomic, so two concurrent requests cannot both observe count = limit - 1.
 */
const INCR_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

export interface WindowCount {
  readonly count: number;
  readonly ttlSeconds: number;
}

export async function incrementWindow(
  client: Redis,
  key: string,
  windowSeconds: number,
): Promise<WindowCount> {
  const raw = (await client.eval(
    INCR_WITH_TTL,
    1,
    key,
    String(windowSeconds),
  )) as [number, number];
  return { count: raw[0], ttlSeconds: raw[1] < 0 ? windowSeconds : raw[1] };
}

/**
 * Atomically claims a one-time value.
 *
 * Returns true exactly once for a given key, and false for every subsequent
 * caller, including two callers racing in the same millisecond. Used for the
 * single-use export download link: a replayed link must lose the race rather
 * than be checked and then deleted, which is a classic time-of-check window.
 */
export async function claimOnce(
  client: Redis,
  key: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await client.set(key, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

/**
 * Deletes every key under a prefix using SCAN, never KEYS.
 *
 * `KEYS *` blocks the entire server for the duration of the scan, which on the
 * quota instance means every rate-limit check in flight times out. Account
 * deletion is exactly the operation most likely to run against a large keyspace
 * at an inconvenient moment.
 */
export async function deleteByPrefix(
  client: Redis,
  prefix: string,
): Promise<number> {
  let cursor = "0";
  let deleted = 0;
  do {
    const [next, keys] = await client.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length > 0) {
      deleted += await client.del(...keys);
    }
  } while (cursor !== "0");
  return deleted;
}
