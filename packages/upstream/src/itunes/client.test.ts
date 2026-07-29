import { describe, expect, it } from "vitest";

import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import {
  ITUNES_ATTRIBUTION,
  ITUNES_QUOTA,
  ItunesClient,
  pickBestMatch,
} from "./client.js";

function make(http: FakeHttp, clock = new FakeClock()) {
  return new ItunesClient({
    baseUrl: "https://itunes.test",
    fetch: http.fetch,
    clock,
    retry: { maxAttempts: 1 },
  });
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    trackId: 1_234_567,
    trackName: "Song 2",
    artistName: "Blur",
    collectionName: "Blur",
    previewUrl: "https://audio-ssl.itunes.apple.com/preview/1234567.m4a",
    trackTimeMillis: 121_000,
    artworkUrl100: "https://is1-ssl.mzstatic.com/x/100x100bb.jpg",
    trackViewUrl: "https://music.apple.com/us/album/1234567",
    ...overrides,
  };
}

describe("ItunesClient preview resolution", () => {
  it("resolves a preview and marks it as never expiring", async () => {
    const http = new FakeHttp().enqueue({
      body: { resultCount: 1, results: [result()] },
    });
    const preview = await make(http).resolvePreview("Blur", "Song 2");
    expect(preview?.previewUrl).toContain("audio-ssl.itunes.apple.com");
    // Unsigned and stable, which is the whole reason iTunes is preferred.
    expect(preview?.expiresAt).toBeNull();
    expect(preview?.attribution).toBe(ITUNES_ATTRIBUTION);
  });

  it("requests a song entity, not a general search", async () => {
    const http = new FakeHttp().enqueue({ body: { results: [] } });
    await make(http).resolvePreview("Blur", "Song 2");
    const url = http.lastRequest?.url ?? "";
    expect(url).toContain("entity=song");
    expect(url).toContain("media=music");
    expect(url).toContain("limit=5");
  });

  it("rejects a karaoke or tribute result that ranks first", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        results: [
          result({
            artistName: "Karaoke Hits Band",
            trackName: "Song 2 (Karaoke Version)",
            previewUrl: "https://audio-ssl.itunes.apple.com/preview/wrong.m4a",
          }),
          result(),
        ],
      },
    });
    const preview = await make(http).resolvePreview("Blur", "Song 2");
    expect(preview?.artistName).toBe("Blur");
  });

  it("returns null rather than an unrelated track when nothing matches", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        results: [
          result({ artistName: "Someone Else", trackName: "Other Song" }),
        ],
      },
    });
    expect(await make(http).resolvePreview("Blur", "Song 2")).toBeNull();
  });

  it("skips results with no previewUrl", async () => {
    const http = new FakeHttp().enqueue({
      body: { results: [result({ previewUrl: undefined })] },
    });
    expect(await make(http).resolvePreview("Blur", "Song 2")).toBeNull();
  });

  it("looks a track up by Apple id when we already know it", async () => {
    const http = new FakeHttp().enqueue({ body: { results: [result()] } });
    const preview = await make(http).lookupTrack(1_234_567);
    expect(preview?.trackId).toBe(1_234_567);
    expect(http.lastRequest?.url).toContain("/lookup?");
  });
});

describe("ItunesClient quota (Apple say about 20 calls/min, scope unstated)", () => {
  it("budgets under Apple's documented limit", () => {
    // Under-spending costs a cache miss; over-spending costs the IP, with no
    // appeals process.
    expect(ITUNES_QUOTA.limit).toBeLessThan(20);
    expect(ITUNES_QUOTA.windowMs).toBe(60_000);
  });

  it("refuses locally once the minute's budget is spent", async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().always({ body: { results: [] } });
    const client = make(http, clock);
    for (let i = 0; i < ITUNES_QUOTA.limit; i++) {
      await client.resolvePreview("A", "B");
    }
    await expect(client.resolvePreview("A", "B")).rejects.toThrow(/quota/);
    expect(http.callCount).toBe(ITUNES_QUOTA.limit);

    clock.advance(60_001);
    await expect(client.resolvePreview("A", "B")).resolves.toBeNull();
  });
});

describe("pickBestMatch", () => {
  const base = {
    provider: "itunes" as const,
    previewUrl: "u",
    trackId: 1,
    collectionName: undefined,
    durationMs: undefined,
    artworkUrl: undefined,
    trackViewUrl: undefined,
    attribution: ITUNES_ATTRIBUTION,
    expiresAt: null,
  };

  it("prefers an exact artist and title match", () => {
    const best = pickBestMatch(
      [
        { ...base, artistName: "Blur", trackName: "Song 2 (Live)" },
        { ...base, artistName: "Blur", trackName: "Song 2" },
      ],
      "Blur",
      "Song 2",
    );
    expect(best?.trackName).toBe("Song 2");
  });

  it("returns null on an empty candidate list", () => {
    expect(pickBestMatch([], "Blur", "Song 2")).toBeNull();
  });
});
