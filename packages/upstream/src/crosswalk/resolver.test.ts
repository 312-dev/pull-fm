import { describe, expect, it } from "vitest";

import { MusicBrainzClient } from "../musicbrainz/client.js";
import { RateLimiter } from "../rate-limiter.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import { CrosswalkResolver } from "./resolver.js";
import { MemoryCrosswalkStore } from "./store.js";

const UA = "PullFM/0.1.0 (ope@312.dev)";

function mbid(n: number): string {
  return `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function musicbrainz(http: FakeHttp) {
  const clock = new FakeClock();
  return new MusicBrainzClient({
    userAgent: UA,
    rateLimiter: new RateLimiter({
      minIntervalMs: 1000,
      maxQueueDepth: 100,
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    }),
    baseUrl: "https://mb.test/ws/2",
    fetch: http.fetch,
    clock,
    retry: { maxAttempts: 1 },
  });
}

describe("CrosswalkResolver local lookups", () => {
  it("hits exactly on a normalised key", async () => {
    const store = new MemoryCrosswalkStore();
    await store.record({
      entityType: "artist",
      normalizedKey: "bjork",
      mbid: mbid(1),
      confidence: 1,
      source: "seed",
    });
    const resolver = new CrosswalkResolver({ store });

    // Different spelling, same normalised key: no upstream call is possible
    // here because no MusicBrainz client was supplied.
    const result = await resolver.resolveArtist("Björk");
    expect(result).toEqual({
      mbid: mbid(1),
      confidence: 1,
      source: "seed",
      matchedBy: "exact",
    });
    expect(resolver.stats().exact).toBe(1);
  });

  it("falls back to a trigram match for a typo", async () => {
    const store = new MemoryCrosswalkStore();
    await store.record({
      entityType: "artist",
      normalizedKey: "radiohead",
      mbid: mbid(2),
      confidence: 1,
      source: "seed",
    });
    const resolver = new CrosswalkResolver({ store });

    const result = await resolver.resolveArtist("Radiohed");
    expect(result?.mbid).toBe(mbid(2));
    expect(result?.matchedBy).toBe("fuzzy");
    // A fuzzy hit is worth less than the row it matched.
    expect(result?.confidence).toBeLessThan(1);
    expect(resolver.stats().fuzzy).toBe(1);
  });

  it("refuses a fuzzy match below the threshold rather than guessing", async () => {
    const store = new MemoryCrosswalkStore();
    await store.record({
      entityType: "artist",
      normalizedKey: "the beatles",
      mbid: mbid(3),
      confidence: 1,
      source: "seed",
    });
    const resolver = new CrosswalkResolver({ store });
    // A false merge in a UNIQUE-keyed crosswalk is close to unrecoverable.
    expect(await resolver.resolveArtist("The Beach Boys")).toBeNull();
  });

  it("keys recordings by artist AND title, since titles are not unique", async () => {
    const store = new MemoryCrosswalkStore();
    const resolver = new CrosswalkResolver({ store });
    await resolver.learn("recording", "Intro", mbid(4), "listenbrainz");
    await store.record({
      entityType: "recording",
      normalizedKey: "the xx intro",
      mbid: mbid(5),
      confidence: 0.95,
      source: "listenbrainz",
    });
    const result = await resolver.resolveRecording("The xx", "Intro");
    expect(result?.mbid).toBe(mbid(5));
  });
});

describe("CrosswalkResolver remote fallback", () => {
  it("searches MusicBrainz on a miss and records the answer permanently", async () => {
    const http = new FakeHttp().enqueue({
      body: { artists: [{ id: mbid(6), name: "Sigur Rós", score: 100 }] },
    });
    const store = new MemoryCrosswalkStore();
    const resolver = new CrosswalkResolver({
      store,
      musicbrainz: musicbrainz(http),
    });

    const first = await resolver.resolveArtist("Sigur Rós");
    expect(first?.matchedBy).toBe("remote");
    expect(first?.mbid).toBe(mbid(6));

    // The second lookup is local: this is what makes the >90% warm hit rate
    // reachable without a backfill job.
    const second = await resolver.resolveArtist("Sigur Ros");
    expect(second?.matchedBy).toBe("exact");
    expect(http.callCount).toBe(1);
    expect(resolver.stats().warmHitRate).toBe(0.5);
  });

  it("ignores a low-scoring search result", async () => {
    const http = new FakeHttp().enqueue({
      body: { artists: [{ id: mbid(7), name: "Something Else", score: 42 }] },
    });
    const resolver = new CrosswalkResolver({
      store: new MemoryCrosswalkStore(),
      musicbrainz: musicbrainz(http),
    });
    expect(await resolver.resolveArtist("Nonexistent Band")).toBeNull();
    expect(resolver.stats().unresolved).toBe(1);
  });

  it("does not record a negative when MusicBrainz itself fails", async () => {
    const http = new FakeHttp().always({ status: 503, body: {} });
    const store = new MemoryCrosswalkStore();
    const resolver = new CrosswalkResolver({
      store,
      musicbrainz: musicbrainz(http),
    });
    expect(await resolver.resolveArtist("Anyone")).toBeNull();
    // An outage is not evidence that an artist does not exist.
    expect(store.size).toBe(0);
  });

  it("never writes an empty normalised key", async () => {
    const store = new MemoryCrosswalkStore();
    const resolver = new CrosswalkResolver({ store });
    await resolver.learn("artist", "!!!???", mbid(8), "listenbrainz");
    expect(store.size).toBe(0);
  });
});

describe("CrosswalkResolver learning from providers", () => {
  it("records name+MBID pairs that arrive free with other responses", async () => {
    const store = new MemoryCrosswalkStore();
    const resolver = new CrosswalkResolver({ store });
    await resolver.learn("artist", "Boards of Canada", mbid(9), "listenbrainz");
    const hit = await resolver.resolveArtist("boards of canada");
    expect(hit?.mbid).toBe(mbid(9));
    expect(hit?.source).toBe("listenbrainz");
  });

  it("lets a more confident resolution supersede a weaker one", async () => {
    const store = new MemoryCrosswalkStore();
    await store.record({
      entityType: "artist",
      normalizedKey: "aphex twin",
      mbid: mbid(10),
      confidence: 0.7,
      source: "musicbrainz:search:artist",
    });
    const resolver = new CrosswalkResolver({ store });
    await resolver.learn(
      "artist",
      "Aphex Twin",
      mbid(11),
      "listenbrainz",
      0.95,
    );
    expect((await resolver.resolveArtist("Aphex Twin"))?.mbid).toBe(mbid(11));
  });

  it("does not let a weaker resolution overwrite a stronger one", async () => {
    const store = new MemoryCrosswalkStore();
    await store.record({
      entityType: "artist",
      normalizedKey: "aphex twin",
      mbid: mbid(10),
      confidence: 1,
      source: "exact",
    });
    const resolver = new CrosswalkResolver({ store });
    await resolver.learn("artist", "Aphex Twin", mbid(11), "guess", 0.5);
    expect((await resolver.resolveArtist("Aphex Twin"))?.mbid).toBe(mbid(10));
  });
});
