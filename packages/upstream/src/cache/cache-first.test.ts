import { describe, expect, it, vi } from "vitest";

import { UpstreamError } from "../errors.js";
import { MalformedPayloadError, reqString } from "../json.js";
import { CachedUpstream } from "./cache-first.js";
import { CacheGovernor, lastfmCap } from "./governor.js";
import { MemoryCacheStore } from "./memory-store.js";

const parseName = (payload: unknown): string => reqString(payload, "name");

describe("CachedUpstream", () => {
  it("fetches on a miss and serves from cache afterwards", async () => {
    const store = new MemoryCacheStore();
    const cache = new CachedUpstream(store);
    const load = vi.fn(() => Promise.resolve({ name: "Björk" }));

    const first = await cache.fetch({
      provider: "musicbrainz",
      key: "artist:1",
      ttlSeconds: 3600,
      load,
      parse: parseName,
    });
    const second = await cache.fetch({
      provider: "musicbrainz",
      key: "artist:1",
      ttlSeconds: 3600,
      load,
      parse: parseName,
    });

    expect(first).toEqual({ value: "Björk", hit: false, stale: false });
    expect(second.hit).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.stats("musicbrainz").hitRate).toBe(0.5);
  });

  it("refetches once the TTL lapses", async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(() => now);
    const cache = new CachedUpstream(store, { now: () => now });
    const load = vi.fn(() => Promise.resolve({ name: "a" }));
    const spec = {
      provider: "lastfm" as const,
      key: "k",
      ttlSeconds: 60,
      load,
      parse: parseName,
    };

    await cache.fetch(spec);
    now += 61_000;
    await cache.fetch(spec);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("serves a stale entry when the refresh fails", async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(() => now);
    const cache = new CachedUpstream(store, { now: () => now });

    await cache.fetch({
      provider: "lastfm",
      key: "k",
      ttlSeconds: 60,
      load: () => Promise.resolve({ name: "cached" }),
      parse: parseName,
    });
    now += 61_000;

    const result = await cache.fetch({
      provider: "lastfm",
      key: "k",
      ttlSeconds: 60,
      load: () =>
        Promise.reject(
          new UpstreamError({
            provider: "lastfm",
            kind: "server_error",
            message: "503",
          }),
        ),
      parse: parseName,
    });

    // An expired similar-artist list beats an empty shelf.
    expect(result).toEqual({ value: "cached", hit: true, stale: true });
    expect(cache.stats("lastfm").stale).toBe(1);
  });

  it("propagates the failure when there is no stale entry to fall back to", async () => {
    const cache = new CachedUpstream(new MemoryCacheStore());
    await expect(
      cache.fetch({
        provider: "deezer",
        key: "k",
        ttlSeconds: 60,
        load: () =>
          Promise.reject(
            new UpstreamError({
              provider: "deezer",
              kind: "timeout",
              message: "timed out",
            }),
          ),
        parse: parseName,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("evicts a poisoned row and refetches instead of serving it forever", async () => {
    const store = new MemoryCacheStore();
    const cache = new CachedUpstream(store);
    // A row written by an older build whose shape the current parser rejects.
    await store.set("listenbrainz", "k", { legacyName: "x" }, 3600);

    const result = await cache.fetch({
      provider: "listenbrainz",
      key: "k",
      ttlSeconds: 3600,
      load: () => Promise.resolve({ name: "fresh" }),
      parse: parseName,
    });

    expect(result.value).toBe("fresh");
    expect(cache.stats("listenbrainz").poisoned).toBe(1);
  });

  it("honours refresh: true by skipping the read but still writing", async () => {
    const store = new MemoryCacheStore();
    const cache = new CachedUpstream(store);
    await store.set("itunes", "k", { name: "old" }, 3600);

    const result = await cache.fetch({
      provider: "itunes",
      key: "k",
      ttlSeconds: 3600,
      refresh: true,
      load: () => Promise.resolve({ name: "new" }),
      parse: parseName,
    });

    expect(result.value).toBe("new");
    expect(await cache.peek("itunes", "k", parseName)).toBe("new");
  });

  it("caches permanently when ttlSeconds is null", async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(() => now);
    const cache = new CachedUpstream(store, { now: () => now });
    const load = vi.fn(() => Promise.resolve({ name: "features" }));
    const spec = {
      provider: "reccobeats" as const,
      key: "track:1",
      ttlSeconds: null,
      load,
      parse: parseName,
    };

    await cache.fetch(spec);
    now += 365 * 24 * 3600 * 1000;
    const later = await cache.fetch(spec);

    // ReccoBeats is an anonymous operator with no SLA; a permanent cache is
    // what makes its disappearance a degradation rather than an outage.
    expect(later.hit).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("runs the governor after a write so the Last.fm cap is enforced", async () => {
    const store = new MemoryCacheStore();
    const governor = new CacheGovernor(store, {
      caps: { lastfm: lastfmCap(80) },
      checkEveryWrites: 1,
    });
    const spy = vi.spyOn(governor, "afterWrite");
    const cache = new CachedUpstream(store, { governor });

    await cache.fetch({
      provider: "lastfm",
      key: "k",
      ttlSeconds: 3600,
      load: () => Promise.resolve({ name: "x" }),
      parse: parseName,
    });

    expect(spy).toHaveBeenCalledWith("lastfm");
  });

  it("peek never calls an upstream and returns null past the TTL", async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(() => now);
    const cache = new CachedUpstream(store, { now: () => now });
    await store.set("musicbrainz", "k", { name: "x" }, 10);
    expect(await cache.peek("musicbrainz", "k", parseName)).toBe("x");
    now += 11_000;
    expect(await cache.peek("musicbrainz", "k", parseName)).toBeNull();
  });

  it("peek reports a poisoned row as a miss rather than throwing", async () => {
    const store = new MemoryCacheStore();
    await store.set("musicbrainz", "k", { wrong: true }, 100);
    const cache = new CachedUpstream(store);
    expect(await cache.peek("musicbrainz", "k", parseName)).toBeNull();
  });

  it("collapses a concurrent miss storm into one upstream call", async () => {
    const store = new MemoryCacheStore();
    const cache = new CachedUpstream(store);
    let inFlight = 0;
    let peakConcurrency = 0;
    const load = vi.fn(async () => {
      inFlight++;
      peakConcurrency = Math.max(peakConcurrency, inFlight);
      await Promise.resolve();
      inFlight--;
      return { name: "Björk" };
    });
    const spec = {
      provider: "musicbrainz" as const,
      key: "artist:cold",
      ttlSeconds: 3600,
      load,
      parse: parseName,
    };

    // A hundred users asking for the same uncached artist in the same tick. A
    // read-through cache alone suppresses NOTHING here: the first call has not
    // returned, so there is no row for the other ninety-nine to hit. At
    // MusicBrainz's 1 req/s global ceiling this is the difference between a
    // slow render and a terms violation.
    const results = await Promise.all(
      Array.from({ length: 100 }, () => cache.fetch(spec)),
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(peakConcurrency).toBe(1);
    for (const r of results) expect(r.value).toBe("Björk");
    // Every caller genuinely missed the cache, so none is counted as a hit.
    // Inflating the Gate 2 warm-hit-rate with coalesced callers would hide a
    // cold start going wrong behind a healthy-looking graph.
    expect(cache.stats("musicbrainz").misses).toBe(100);
    expect(cache.stats("musicbrainz").hits).toBe(0);
    expect(cache.stats("musicbrainz").coalesced).toBe(99);
    expect(cache.coalescing).toEqual({ started: 1, joined: 99 });
  });

  it("writes the row exactly once under a miss storm", async () => {
    const store = new MemoryCacheStore();
    const set = vi.spyOn(store, "set");
    const cache = new CachedUpstream(store);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        cache.fetch({
          provider: "lastfm",
          key: "similar-artists:cold",
          ttlSeconds: 3600,
          load: () => Promise.resolve({ name: "x" }),
          parse: parseName,
        }),
      ),
    );

    // Twenty identical upserts would be twenty write amplifications on the row
    // the governor then has to measure against the 100 MB Last.fm cap.
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("never coalesces two different keys", async () => {
    const cache = new CachedUpstream(new MemoryCacheStore());
    const load = vi.fn((name: string) => Promise.resolve({ name }));

    const [a, b] = await Promise.all([
      cache.fetch({
        provider: "lastfm",
        key: "k1",
        ttlSeconds: 60,
        load: () => load("one"),
        parse: parseName,
      }),
      cache.fetch({
        provider: "lastfm",
        key: "k2",
        ttlSeconds: 60,
        load: () => load("two"),
        parse: parseName,
      }),
    ]);

    // Serving one artist's neighbours under another artist's key would be a
    // cache-poisoning bug introduced by the fix for a rate-limit bug.
    expect(a.value).toBe("one");
    expect(b.value).toBe("two");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce the same key across two providers", async () => {
    const cache = new CachedUpstream(new MemoryCacheStore());
    const load = vi.fn((name: string) => Promise.resolve({ name }));

    const [a, b] = await Promise.all([
      cache.fetch({
        provider: "lastfm",
        key: "similar:blur",
        ttlSeconds: 60,
        load: () => load("lastfm"),
        parse: parseName,
      }),
      cache.fetch({
        provider: "listenbrainz",
        key: "similar:blur",
        ttlSeconds: 60,
        load: () => load("listenbrainz"),
        parse: parseName,
      }),
    ]);

    expect(a.value).toBe("lastfm");
    expect(b.value).toBe("listenbrainz");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps keys distinct when one is a prefix of another", async () => {
    const cache = new CachedUpstream(new MemoryCacheStore());
    const load = vi.fn((name: string) => Promise.resolve({ name }));

    // The provider and key are joined with a NUL, which no key can contain, so
    // `lastfm` + `a:b` cannot collide with a provider whose name ends in `a`.
    const [a, b] = await Promise.all([
      cache.fetch({
        provider: "lastfm",
        key: "artist",
        ttlSeconds: 60,
        load: () => load("short"),
        parse: parseName,
      }),
      cache.fetch({
        provider: "lastfm",
        key: "artist:1",
        ttlSeconds: 60,
        load: () => load("long"),
        parse: parseName,
      }),
    ]);

    expect(a.value).toBe("short");
    expect(b.value).toBe("long");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one upstream failure across every concurrent caller", async () => {
    const cache = new CachedUpstream(new MemoryCacheStore());
    const load = vi.fn(() =>
      Promise.reject(
        new UpstreamError({
          provider: "listenbrainz",
          kind: "timeout",
          message: "timed out",
        }),
      ),
    );
    const spec = {
      provider: "listenbrainz" as const,
      key: "cold",
      ttlSeconds: 60,
      load,
      parse: parseName,
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 25 }, () => cache.fetch(spec)),
    );

    for (const outcome of settled) {
      expect(outcome.status).toBe("rejected");
      // The caller must still see the provider's own error, not the internal
      // wrapper the coalescing layer uses to classify it.
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        UpstreamError,
      );
    }
    // Twenty-five retries against an upstream that just timed out is the
    // stampede again, wearing the costume of resilience.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("still serves each caller its own stale entry when a shared refresh fails", async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(() => now);
    const cache = new CachedUpstream(store, { now: () => now });

    await cache.fetch({
      provider: "lastfm",
      key: "k",
      ttlSeconds: 60,
      load: () => Promise.resolve({ name: "cached" }),
      parse: parseName,
    });
    now += 61_000;

    const load = vi.fn(() =>
      Promise.reject(
        new UpstreamError({
          provider: "lastfm",
          kind: "server_error",
          message: "503",
        }),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        cache.fetch({
          provider: "lastfm",
          key: "k",
          ttlSeconds: 60,
          load,
          parse: parseName,
        }),
      ),
    );

    // Only the FILL is shared. Each caller still runs its own recovery, so
    // joining a flight never changes what a caller would have concluded alone.
    for (const r of results) {
      expect(r).toEqual({ value: "cached", hit: true, stale: true });
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refuses to cache a payload it cannot parse, even under coalescing", async () => {
    const store = new MemoryCacheStore();
    const cache = new CachedUpstream(store);
    const spec = {
      provider: "listenbrainz" as const,
      key: "malformed",
      ttlSeconds: 60,
      load: () => Promise.resolve({ unexpected: "shape" }),
      parse: parseName,
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => cache.fetch(spec)),
    );
    for (const outcome of settled) expect(outcome.status).toBe("rejected");

    // Caching an unparseable payload would turn one bad provider response into
    // a TTL-long outage that the poison path then has to clean up on every read.
    expect(await store.get("listenbrainz", "malformed")).toBeNull();
  });

  it("does not serve a stale entry to cover a parse failure", async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(() => now);
    const cache = new CachedUpstream(store, { now: () => now });

    await cache.fetch({
      provider: "lastfm",
      key: "k",
      ttlSeconds: 60,
      load: () => Promise.resolve({ name: "cached" }),
      parse: parseName,
    });
    now += 61_000;

    // The provider answered; we simply could not make sense of it. Falling back
    // to a stale row here would hide our own defect behind plausible data,
    // which is why only a LOAD failure is allowed to reach the stale path.
    await expect(
      cache.fetch({
        provider: "lastfm",
        key: "k",
        ttlSeconds: 60,
        load: () => Promise.resolve({}),
        parse: () => {
          throw new TypeError("programmer error");
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("admits a fresh call once the flight settles rather than memoising", async () => {
    const store = new MemoryCacheStore();
    const cache = new CachedUpstream(store);
    const load = vi.fn(() => Promise.resolve({ name: "v" }));
    const spec = {
      provider: "deezer" as const,
      key: "k",
      ttlSeconds: 60,
      refresh: true,
      load,
      parse: parseName,
    };

    // `refresh: true` skips the cache read every time, so a second sequential
    // call proves the in-flight map cleared rather than becoming an unbounded
    // memo with no TTL and no eviction.
    await cache.fetch(spec);
    await cache.fetch(spec);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("lets a non-schema parse error through instead of swallowing a bug", async () => {
    const store = new MemoryCacheStore();
    await store.set("musicbrainz", "k", { name: "x" }, 100);
    const cache = new CachedUpstream(store);
    await expect(
      cache.fetch({
        provider: "musicbrainz",
        key: "k",
        ttlSeconds: 100,
        load: () => Promise.resolve({}),
        parse: () => {
          throw new TypeError("programmer error");
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(new MalformedPayloadError("p", "d")).toBeInstanceOf(Error);
  });
});
