import { describe, expect, it } from "vitest";

import type { UpstreamError } from "../errors.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import {
  DEEZER_ASSUMED_TTL_MS,
  DeezerClient,
  isExpired,
  parsePreviewExpiry,
} from "./client.js";

const NOW = 1_700_000_000_000;

function make(http: FakeHttp, clock = new FakeClock(NOW)) {
  return new DeezerClient({
    baseUrl: "https://dz.test",
    fetch: http.fetch,
    clock,
    retry: { maxAttempts: 1 },
  });
}

function signedUrl(expEpochSeconds: number): string {
  return `https://cdn.dz.test/preview/123.mp3?hdnea=exp=${String(expEpochSeconds)}~acl=/preview/123.mp3~hmac=deadbeef`;
}

function track(previewUrl: string) {
  return {
    id: 123,
    title: "Song 2",
    duration: 121,
    preview: previewUrl,
    artist: { id: 9, name: "Blur" },
    album: { id: 8, title: "Blur", cover_medium: "https://cdn/cover.jpg" },
  };
}

describe("parsePreviewExpiry", () => {
  it("reads the Akamai token expiry out of the signed URL", () => {
    expect(parsePreviewExpiry(signedUrl(1_700_000_600), NOW)).toBe(
      1_700_000_600_000,
    );
  });

  it("assumes a SHORT lifetime when no expiry is present", () => {
    // Treating an unknown expiry as long-lived is how a signed URL ends up
    // cached; treating it as nearly-expired only costs a re-resolve.
    expect(parsePreviewExpiry("https://cdn/preview.mp3", NOW)).toBe(
      NOW + DEEZER_ASSUMED_TTL_MS,
    );
    expect(DEEZER_ASSUMED_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("DeezerClient preview resolution", () => {
  it("always returns an expiry and marks the result as not cacheable", async () => {
    const http = new FakeHttp().enqueue({
      body: { data: [track(signedUrl(1_700_000_600))] },
    });
    const preview = await make(http).resolvePreview("Blur", "Song 2");
    expect(preview?.cacheable).toBe(false);
    expect(preview?.expiresAt).toBe(1_700_000_600_000);
    expect(preview?.durationMs).toBe(121_000);
  });

  it("reports an already-expired URL through isExpired", () => {
    const preview = {
      provider: "deezer" as const,
      previewUrl: signedUrl(1),
      trackId: 1,
      trackName: "t",
      artistName: "a",
      albumName: undefined,
      durationMs: undefined,
      artworkUrl: undefined,
      attribution: "x",
      expiresAt: NOW - 1,
      cacheable: false as const,
    };
    expect(isExpired(preview, NOW)).toBe(true);
    expect(isExpired({ ...preview, expiresAt: NOW + 1000 }, NOW)).toBe(false);
  });

  it("re-resolves by track id, which is the pre-playback path", async () => {
    const http = new FakeHttp().enqueue({
      body: track(signedUrl(1_700_000_900)),
    });
    const preview = await make(http).refreshPreview(123);
    expect(preview?.expiresAt).toBe(1_700_000_900_000);
    expect(http.lastRequest?.url).toBe("https://dz.test/track/123");
  });

  it("does not return a mismatched track", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        data: [
          {
            ...track(signedUrl(1_700_000_600)),
            title: "Completely Different",
            artist: { id: 1, name: "Someone Else" },
          },
        ],
      },
    });
    expect(await make(http).resolvePreview("Blur", "Song 2")).toBeNull();
  });
});

describe("DeezerClient in-band error envelope", () => {
  it("treats quota code 4 as rate limiting despite the HTTP 200", async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: {
        error: { type: "Exception", message: "Quota limit exceeded", code: 4 },
      },
    });
    const err = (await make(http)
      .resolvePreview("Blur", "Song 2")
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err.kind).toBe("rate_limited");
  });

  it("treats a DataException as a miss, not an outage", async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: { error: { type: "DataException", message: "no data", code: 800 } },
    });
    const err = (await make(http)
      .refreshPreview(1)
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err.kind).toBe("http");
    expect(err.countsAgainstProvider).toBe(false);
  });
});
