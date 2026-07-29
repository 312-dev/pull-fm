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
