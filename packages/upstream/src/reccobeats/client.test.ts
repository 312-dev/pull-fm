import { describe, expect, it } from "vitest";

import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import { ReccoBeatsClient } from "./client.js";

const UUID = "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const SPOTIFY_ID = "4uLU6hMCjMI75M1A2tKUQC";

function make(http: FakeHttp) {
  return new ReccoBeatsClient({
    baseUrl: "https://rb.test",
    fetch: http.fetch,
    clock: new FakeClock(),
    retry: { maxAttempts: 1 },
  });
}

describe("ReccoBeatsClient two-call sequence", () => {
  it("resolves a Spotify id to a ReccoBeats UUID first", async () => {
    const http = new FakeHttp()
      .enqueue({ body: { content: [{ id: UUID, trackTitle: "x" }] } })
      .enqueue({
        body: { id: UUID, tempo: 122, energy: 0.8, key: 5, mode: 1 },
      });

    const features = await make(http).audioFeatures(SPOTIFY_ID);

    expect(http.requests[0]?.url).toContain(`/v1/track?ids=${SPOTIFY_ID}`);
    // The second hop MUST use the ReccoBeats UUID; passing the Spotify id 404s.
    expect(http.requests[1]?.url).toBe(
      `https://rb.test/v1/track/${UUID}/audio-features`,
    );
    expect(features?.tempo).toBe(122);
    expect(features?.musicalKey).toBe(5);
    expect(features?.source).toBe("reccobeats");
  });

  it("stops after the first call when they do not know the track", async () => {
    const http = new FakeHttp().enqueue({ body: { content: [] } });
    expect(await make(http).audioFeatures(SPOTIFY_ID)).toBeNull();
    expect(http.callCount).toBe(1);
  });

  it("returns null on a 404 from the features call", async () => {
    const http = new FakeHttp().enqueue({ status: 404, body: {} });
    expect(await make(http).audioFeaturesByUuid(UUID)).toBeNull();
  });

  it("ignores a non-UUID id rather than making a doomed second call", async () => {
    const http = new FakeHttp().enqueue({
      body: { content: [{ id: SPOTIFY_ID }] },
    });
    expect(await make(http).resolveTrackId(SPOTIFY_ID)).toBeNull();
  });
});

describe("ReccoBeatsClient feature parsing", () => {
  it("drops a musical key outside 0-11, which the schema would reject", async () => {
    const http = new FakeHttp().enqueue({
      body: { id: UUID, key: 42, tempo: 100 },
    });
    const features = await make(http).audioFeaturesByUuid(UUID);
    expect(features?.musicalKey).toBeUndefined();
    expect(features?.tempo).toBe(100);
  });

  it("accepts features nested under audioFeatures", async () => {
    const http = new FakeHttp().enqueue({
      body: { audioFeatures: { tempo: 90, valence: 0.4 } },
    });
    const features = await make(http).audioFeaturesByUuid(UUID);
    expect(features?.tempo).toBe(90);
    expect(features?.valence).toBe(0.4);
  });

  it("records a confidence above AcousticBrainz but below authoritative", async () => {
    const http = new FakeHttp().enqueue({ body: { tempo: 120 } });
    const features = await make(http).audioFeaturesByUuid(UUID);
    expect(features?.confidence).toBeGreaterThan(0.5);
    expect(features?.confidence).toBeLessThan(1);
  });
});
