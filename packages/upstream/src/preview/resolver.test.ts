import { describe, expect, it } from "vitest";

import { DeezerClient } from "../deezer/client.js";
import { ItunesClient } from "../itunes/client.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import { PgPreviewStore } from "./pg-store.js";
import {
  DeezerPreviewNotCacheableError,
  MemoryPreviewStore,
  PreviewResolver,
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
    // ~20 calls/min per IP: the cache is what makes this viable at all.
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
