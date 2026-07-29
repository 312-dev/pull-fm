import { describe, expect, it } from "vitest";

import { DeezerClient } from "../deezer/client.js";
import { ItunesClient } from "../itunes/client.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import { PgPreviewStore } from "./pg-store.js";
import {
  DeezerPreviewNotCacheableError,
  MemoryPreviewStore,
  PreviewResolver,
  appleStoreUrl,
} from "./resolver.js";

const NOW = 1_700_000_000_000;
const MBID = "30000000-0000-4000-8000-000000000001";

function itunesResult() {
  return {
    resultCount: 1,
    results: [
      {
        trackId: 1,
        trackName: "Song 2",
        artistName: "Blur",
        previewUrl: "https://audio-ssl.itunes.apple.com/preview/1.m4a",
        trackTimeMillis: 121_000,
        // Apple licence condition (ii): without this the preview cannot be
        // rendered next to a store badge, so the resolver refuses to serve it.
        trackViewUrl: "https://music.apple.com/us/album/song-2/1?i=2&uo=4",
      },
    ],
  };
}

function deezerResult(expEpochSeconds: number) {
  return {
    data: [
      {
        id: 5,
        title: "Song 2",
        duration: 121,
        preview: `https://cdn.dz/preview/5.mp3?hdnea=exp=${String(expEpochSeconds)}~acl=/preview/5.mp3~hmac=abc`,
        artist: { id: 1, name: "Blur" },
        album: { id: 2, title: "Blur" },
      },
    ],
  };
}

function build(itunesHttp?: FakeHttp, deezerHttp?: FakeHttp) {
  const clock = new FakeClock(NOW);
  const store = new MemoryPreviewStore(() => NOW);
  const resolver = new PreviewResolver({
    store,
    ...(itunesHttp === undefined
      ? {}
      : {
          itunes: new ItunesClient({
            baseUrl: "https://itunes.test",
            fetch: itunesHttp.fetch,
            clock,
            retry: { maxAttempts: 1 },
          }),
        }),
    ...(deezerHttp === undefined
      ? {}
      : {
          deezer: new DeezerClient({
            baseUrl: "https://dz.test",
            fetch: deezerHttp.fetch,
            clock,
            retry: { maxAttempts: 1 },
          }),
        }),
    now: () => NOW,
  });
  return { resolver, store };
}

const TRACK = { recordingMbid: MBID, artistName: "Blur", title: "Song 2" };

describe("PreviewResolver: iTunes is persisted", () => {
  it("resolves through iTunes and stores the stable URL", async () => {
    const itunes = new FakeHttp().enqueue({ body: itunesResult() });
    const { resolver, store } = build(itunes);

    const preview = await resolver.resolve(TRACK);

    expect(preview?.provider).toBe("itunes");
    expect(preview?.expiresAt).toBeNull();
    expect(preview?.cacheable).toBe(true);
    expect(store.size).toBe(1);
  });

  it("serves a stored preview without spending iTunes quota", async () => {
    const itunes = new FakeHttp().enqueue({ body: itunesResult() });
    const { resolver } = build(itunes);
    await resolver.resolve(TRACK);
    const second = await resolver.resolve(TRACK);
    // Apple document "approximately 20 calls per minute" and state no scope
    // for it. The cache is what makes this viable at all.
    expect(itunes.callCount).toBe(1);
    expect(second?.provider).toBe("itunes");
  });

  it("resolveCached never touches an upstream", async () => {
    const itunes = new FakeHttp().always({ body: itunesResult() });
    const { resolver } = build(itunes);
    expect(await resolver.resolveCached(MBID)).toBeNull();
    expect(itunes.callCount).toBe(0);
  });
});

describe("PreviewResolver: Deezer is NEVER persisted", () => {
  it("falls back to Deezer without writing anything to the store", async () => {
    const itunes = new FakeHttp().enqueue({ body: { results: [] } });
    const deezer = new FakeHttp().enqueue({
      body: deezerResult(NOW / 1000 + 600),
    });
    const { resolver, store } = build(itunes, deezer);

    const preview = await resolver.resolve(TRACK);

    expect(preview?.provider).toBe("deezer");
    expect(preview?.cacheable).toBe(false);
    expect(preview?.expiresAt).toBe((NOW / 1000 + 600) * 1000);
    // The entire point: a stored Deezer URL 403s minutes later.
    expect(store.size).toBe(0);
    expect(await resolver.resolveCached(MBID)).toBeNull();
  });

  it("refuses an explicit attempt to store a Deezer preview", async () => {
    const store = new MemoryPreviewStore();
    await expect(
      store.put({
        recordingMbid: MBID,
        provider: "deezer",
        url: "https://cdn.dz/preview/5.mp3?hdnea=exp=1~hmac=a",
        durationMs: 30_000,
        storeUrl: null,
      }),
    ).rejects.toBeInstanceOf(DeezerPreviewNotCacheableError);
  });

  it("refuses a Deezer write at the Postgres store too", async () => {
    const store = new PgPreviewStore({
      query: () => Promise.resolve({ rows: [] }),
    });
    await expect(
      store.put({
        recordingMbid: MBID,
        provider: "deezer",
        url: "https://cdn.dz/x.mp3",
        durationMs: undefined,
        storeUrl: null,
      }),
    ).rejects.toBeInstanceOf(DeezerPreviewNotCacheableError);
  });

  it("writes url_expires_at NULL for iTunes, matching the schema constraint", async () => {
    const statements: string[] = [];
    const store = new PgPreviewStore({
      query: (text) => {
        statements.push(text);
        return Promise.resolve({ rows: [] });
      },
    });
    await store.put({
      recordingMbid: MBID,
      provider: "itunes",
      url: "https://audio-ssl.itunes.apple.com/preview/1.m4a",
      durationMs: 30_000,
      storeUrl: "https://music.apple.com/us/album/x/1?i=2",
    });
    expect(statements[0]).toContain("'itunes'");
    expect(statements[0]).toContain("NULL");
  });
});

describe("PreviewResolver: Deezer expiry is respected", () => {
  it("discards a preview that has already expired", async () => {
    const itunes = new FakeHttp().enqueue({ body: { results: [] } });
    const deezer = new FakeHttp().enqueue({
      body: deezerResult(NOW / 1000 - 10),
    });
    const { resolver } = build(itunes, deezer);
    // An expired URL is not a preview, it is a future 403.
    expect(await resolver.resolve(TRACK)).toBeNull();
  });

  it("re-resolves at playback time rather than reusing a URL", async () => {
    const deezer = new FakeHttp()
      .enqueue({ body: deezerResult(NOW / 1000 + 60) })
      .enqueue({ body: deezerResult(NOW / 1000 + 600) });
    const { resolver } = build(undefined, deezer);

    const first = await resolver.refreshForPlayback(TRACK);
    const second = await resolver.refreshForPlayback(TRACK);

    expect(deezer.callCount).toBe(2);
    expect(second?.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0);
  });

  it("prefers a stored iTunes URL over re-resolving Deezer at playback", async () => {
    const itunes = new FakeHttp().enqueue({ body: itunesResult() });
    const deezer = new FakeHttp().always({
      body: deezerResult(NOW / 1000 + 600),
    });
    const { resolver } = build(itunes, deezer);
    await resolver.resolve(TRACK);
    const atPlayback = await resolver.refreshForPlayback(TRACK);
    expect(atPlayback?.provider).toBe("itunes");
    expect(deezer.callCount).toBe(0);
  });
});

describe("PreviewResolver failure handling", () => {
  it("falls through to Deezer when the iTunes quota is spent", async () => {
    const itunes = new FakeHttp().always({ body: { results: [] } });
    const deezer = new FakeHttp().always({
      body: deezerResult(NOW / 1000 + 600),
    });
    const { resolver } = build(itunes, deezer);

    // Spend the iTunes budget, then confirm the next resolution still works.
    for (let i = 0; i < 20; i++) {
      await resolver.resolve({
        ...TRACK,
        recordingMbid: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      });
    }
    const preview = await resolver.resolve(TRACK);
    expect(preview?.provider).toBe("deezer");
  });

  it("returns null when neither provider is configured", async () => {
    const { resolver } = build();
    expect(await resolver.resolve(TRACK)).toBeNull();
  });
});

describe("Apple licence condition (ii): the store badge", () => {
  it("carries the track's own store link, not a provider homepage", async () => {
    // Verbatim: the badge must act as "a link directly to pages within iTunes
    // where consumers can purchase the promoted content". A homepage link does
    // not satisfy that, so the link is per item and comes from trackViewUrl.
    const itunes = new FakeHttp().enqueue({ body: itunesResult() });
    const { resolver } = build(itunes);
    const preview = await resolver.resolve(TRACK);

    expect(preview?.attribution.source).toBe("itunes");
    expect(preview?.attribution.text).toContain("courtesy of iTunes");
    expect(preview?.attribution.badge?.required).toBe(true);
    expect(preview?.attribution.badge?.linkUrl).toContain("music.apple.com");
    expect(preview?.attribution.badge?.placement).toBe("proximate-to-preview");
    // Apple's guidelines put their badge first where several appear, which is
    // also our answer on condition (vi) and the Qobuz/Bandcamp links.
    expect(preview?.attribution.badge?.ordering).toBe("first");
    // There is no "Download on iTunes" artwork despite the clause naming one.
    expect(preview?.attribution.badge?.variants).not.toContain("Download on");
  });

  it("refuses an iTunes preview with no store link and falls back to Deezer", async () => {
    // Partial compliance with a conjunctive licence is non-compliance. A
    // playable preview under a licence we do satisfy beats an unplayable one
    // under a licence we do not.
    const withoutStoreUrl = itunesResult();
    delete (withoutStoreUrl.results[0] as { trackViewUrl?: string })
      .trackViewUrl;
    const itunes = new FakeHttp().enqueue({ body: withoutStoreUrl });
    const deezer = new FakeHttp().enqueue({
      body: deezerResult(NOW / 1000 + 600),
    });
    const { resolver, store } = build(itunes, deezer);

    const preview = await resolver.resolve(TRACK);
    expect(preview?.provider).toBe("deezer");
    // Nothing unservable was written, so a later request does not find a row
    // it then has to refuse.
    expect(store.size).toBe(0);
  });

  it("treats a stored row with no store link as absent", async () => {
    // Rows written before condition (ii) was implemented. Serving one hands a
    // client a preview it cannot legally render.
    const store = new MemoryPreviewStore(() => NOW);
    await store.put({
      recordingMbid: MBID,
      provider: "itunes",
      url: "https://audio-ssl.itunes.apple.com/preview/1.m4a",
      durationMs: 30_000,
      storeUrl: null,
    });
    const resolver = new PreviewResolver({ store, now: () => NOW });
    expect(await resolver.resolveCached(MBID)).toBeNull();
  });

  it("stops serving a row once its revalidation window closes", async () => {
    // Apple may "remove any Promo Content immediately upon request", so an
    // indefinitely stored URL would serve withdrawn content from our own table.
    const store = new MemoryPreviewStore(() => NOW);
    await store.put({
      recordingMbid: MBID,
      provider: "itunes",
      url: "https://audio-ssl.itunes.apple.com/preview/1.m4a",
      durationMs: 30_000,
      storeUrl: "https://music.apple.com/us/album/x/1?i=2",
    });

    const fresh = new PreviewResolver({ store, now: () => NOW });
    expect(await fresh.resolveCached(MBID)).not.toBeNull();

    const stale = new PreviewResolver({
      store,
      now: () => NOW + 31 * 24 * 60 * 60 * 1000,
    });
    expect(await stale.resolveCached(MBID)).toBeNull();
  });

  it("rejects a store link that is not on an Apple host", () => {
    // A badge pointing somewhere that is not Apple's store is worse than no
    // badge: it is a breach dressed as compliance.
    expect(
      appleStoreUrl("https://music.apple.com/us/album/x/1?i=2"),
    ).not.toBeNull();
    // The old host still validates; Apple moved to music.apple.com but the
    // check is not pinned to either.
    expect(
      appleStoreUrl("https://itunes.apple.com/us/album/x/1"),
    ).not.toBeNull();
    expect(appleStoreUrl("https://evil.example/apple.com/x")).toBeNull();
    expect(appleStoreUrl("http://music.apple.com/us/album/x")).toBeNull();
    expect(appleStoreUrl("https://notapple.com/x")).toBeNull();
    expect(appleStoreUrl(undefined)).toBeNull();
    expect(appleStoreUrl("")).toBeNull();
  });
});

/**
 * The stampede control on the preview path.
 *
 * This is where a cold cache is most dangerous, because the track at the top of
 * everyone's feed is ONE recording MBID that many clients ask for inside the
 * same second. Apple documents about twenty calls a MINUTE with no stated scope
 * and no appeals process, so the count of calls is the compliance property, not
 * a latency one.
 */
describe("PreviewResolver: concurrent resolution is coalesced", () => {
  it("resolves one preview per recording however many callers arrive at once", async () => {
    const itunes = new FakeHttp().always({ body: itunesResult() });
    const { resolver, store } = build(itunes);

    const previews = await Promise.all(
      Array.from({ length: 50 }, () => resolver.resolve(TRACK)),
    );

    // Fifty callers, one call to Apple. Without this the preview route is a
    // remote kill switch operated by whoever refreshes fastest.
    expect(itunes.callCount).toBe(1);
    expect(resolver.coalescing).toEqual({ started: 1, joined: 49 });
    for (const preview of previews) expect(preview?.provider).toBe("itunes");
    expect(store.size).toBe(1);
  });

  it("re-resolves Deezer once per playback burst without persisting it", async () => {
    const deezer = new FakeHttp().always({
      body: deezerResult(Math.floor(NOW / 1000) + 3600),
    });
    const { resolver, store } = build(undefined, deezer);

    const previews = await Promise.all(
      Array.from({ length: 40 }, () => resolver.refreshForPlayback(TRACK)),
    );

    expect(deezer.callCount).toBe(1);
    for (const preview of previews) {
      expect(preview?.provider).toBe("deezer");
      // Sharing the URL is not a compromise: it is the same signed URL Deezer
      // would have minted for each caller, with the same expiry.
      expect(preview?.cacheable).toBe(false);
      expect(preview?.expiresAt).toBe(previews[0]?.expiresAt);
    }
    // And it is still never persisted, which is the rule the whole file exists
    // to enforce.
    expect(store.size).toBe(0);
  });

  it("keeps different recordings independent", async () => {
    const itunes = new FakeHttp().always({ body: itunesResult() });
    const { resolver } = build(itunes);
    const other = {
      recordingMbid: "30000000-0000-4000-8000-000000000002",
      artistName: "Blur",
      title: "Beetlebum",
    };

    await Promise.all([resolver.resolve(TRACK), resolver.resolve(other)]);

    // Coalescing two different recordings would serve one track's preview for
    // another, which is a worse bug than the rate limit it was avoiding.
    expect(itunes.callCount).toBe(2);
  });

  it("does not let a playback refresh join a full resolve", async () => {
    // The two methods are not interchangeable: `resolve` may persist an iTunes
    // row and `refreshForPlayback` is Deezer only. A shared key would hand one
    // caller the other's semantics.
    const itunes = new FakeHttp().always({ body: itunesResult() });
    const deezer = new FakeHttp().always({
      body: deezerResult(Math.floor(NOW / 1000) + 3600),
    });
    const { resolver } = build(itunes, deezer);

    const [resolved, refreshed] = await Promise.all([
      resolver.resolve(TRACK),
      resolver.refreshForPlayback(TRACK),
    ]);

    expect(resolved?.provider).toBe("itunes");
    expect(refreshed?.provider).toBe("deezer");
  });

  it("shares one upstream failure instead of retrying per caller", async () => {
    const itunes = new FakeHttp().always({ status: 503 });
    const deezer = new FakeHttp().always({ status: 503 });
    const { resolver } = build(itunes, deezer);

    const previews = await Promise.all(
      Array.from({ length: 30 }, () => resolver.resolve(TRACK)),
    );

    // A degradation, not an error: no preview right now renders as a disabled
    // play button. Thirty retries against a provider that just returned 503
    // would be the stampede again.
    for (const preview of previews) expect(preview).toBeNull();
    expect(itunes.callCount).toBe(1);
    expect(deezer.callCount).toBe(1);
  });

  it("admits a new resolution after the previous one settled", async () => {
    const itunes = new FakeHttp().always({ status: 503 });
    const deezer = new FakeHttp().always({ status: 503 });
    const { resolver } = build(itunes, deezer);

    await resolver.resolve(TRACK);
    await resolver.resolve(TRACK);

    // The in-flight map must not become a negative cache: a failed resolve that
    // never cleared its key would make the recording permanently unresolvable.
    expect(itunes.callCount).toBe(2);
  });
});
