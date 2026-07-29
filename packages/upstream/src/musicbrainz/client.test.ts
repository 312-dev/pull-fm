import { describe, expect, it } from "vitest";

import { RateLimiter } from "../rate-limiter.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import {
  MUSICBRAINZ_MIN_INTERVAL_MS,
  MusicBrainzClient,
  escapeLucene,
} from "./client.js";

const UA = "PullFM/0.1.0 (ope@312.dev)";

function make(http: FakeHttp, clock = new FakeClock()) {
  const limiter = new RateLimiter({
    minIntervalMs: MUSICBRAINZ_MIN_INTERVAL_MS,
    maxQueueDepth: 100,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
  });
  const client = new MusicBrainzClient({
    userAgent: UA,
    rateLimiter: limiter,
    baseUrl: "https://mb.test/ws/2",
    fetch: http.fetch,
    clock,
  });
  return { client, limiter, clock };
}

describe("MusicBrainzClient licence conditions", () => {
  it("refuses to construct without a descriptive User-Agent", () => {
    const limiter = new RateLimiter({ minIntervalMs: 1000, maxQueueDepth: 10 });
    expect(
      () =>
        new MusicBrainzClient({ userAgent: "curl/8", rateLimiter: limiter }),
    ).toThrow(/User-Agent|identify/i);
    expect(
      () => new MusicBrainzClient({ userAgent: "", rateLimiter: limiter }),
    ).toThrow();
  });

  it("sends the User-Agent on every request", async () => {
    const http = new FakeHttp().always({ body: { id: mbid(1), name: "A" } });
    const { client } = make(http);
    await client.lookupArtist(mbid(1));
    expect(http.lastRequest?.headers["User-Agent"]).toBe(UA);
  });

  it("paces every call through the shared 1 req/s limiter", async () => {
    const http = new FakeHttp().always({ body: { id: mbid(1), name: "A" } });
    const { client, limiter, clock } = make(http);

    await client.lookupArtist(mbid(1));
    await client.lookupArtist(mbid(2));
    await client.lookupArtist(mbid(3));

    expect(limiter.stats.dispatched).toBe(3);
    // 1 req/s is a global per-IP limit: two of the three had to wait a second.
    expect(clock.sleeps.filter((ms) => ms > 0)).toHaveLength(2);
    expect(limiter.peakInWindow(1000)).toBe(1);
  });
});

describe("MusicBrainzClient parsing", () => {
  it("parses an artist lookup, including the hyphenated keys", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        id: mbid(7),
        name: "Björk",
        "sort-name": "Björk",
        country: "IS",
        "life-span": { begin: "1977", ended: false },
        // Present in the payload and deliberately NOT parsed; see the licence
        // assertion below.
        tags: [{ name: "electronic", count: 12 }],
      },
    });
    const { client } = make(http);
    const artist = await client.lookupArtist(mbid(7));
    expect(artist).toEqual({
      mbid: mbid(7),
      name: "Björk",
      sortName: "Björk",
      country: "IS",
      beganYear: 1977,
    });
  });

  it("never requests or parses supplementary data (CC BY-NC-SA 3.0)", async () => {
    // MusicBrainz CORE data is CC0. Tags, ratings and genres are supplementary
    // and are CC BY-NC-SA 3.0, so a single `inc=tags` would attach attribution,
    // NonCommercial and ShareAlike obligations to everything derived from this
    // response. The parameter was removed for that reason
    // (docs/compliance/metabrainz-terms-review.md F1) and this test is what
    // stops it coming back as a one-line "enrichment".
    const http = new FakeHttp().always({
      body: {
        id: mbid(7),
        name: "Björk",
        tags: [{ name: "electronic", count: 12 }],
        genres: [{ name: "trip hop" }],
        rating: { value: 4.5 },
      },
    });
    const { client } = make(http);
    const artist = await client.lookupArtist(mbid(7));

    const url = http.lastRequest?.url ?? "";
    expect(url).not.toContain("inc=");
    expect(Object.keys(artist ?? {})).not.toContain("tags");
    expect(JSON.stringify(artist)).not.toContain("electronic");
    expect(JSON.stringify(artist)).not.toContain("trip hop");
  });

  it("reads the artist name from artist-credit on a recording", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        id: mbid(3),
        title: "Jóga",
        length: 305_000,
        "artist-credit": [
          { name: "Björk", artist: { id: mbid(7), name: "Björk" } },
        ],
      },
    });
    const { client } = make(http);
    const rec = await client.lookupRecording(mbid(3));
    expect(rec?.artistName).toBe("Björk");
    expect(rec?.artistMbid).toBe(mbid(7));
    expect(rec?.lengthMs).toBe(305_000);
  });

  it("returns null for a 404 rather than throwing", async () => {
    const http = new FakeHttp().enqueue({
      status: 404,
      body: { error: "Not Found" },
    });
    const { client } = make(http);
    expect(await client.lookupArtist(mbid(9))).toBeNull();
  });

  it("keeps usable search hits when one row is malformed", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        artists: [
          { name: "no id here", score: 100 },
          { id: mbid(2), name: "Real Artist", score: 97 },
        ],
      },
    });
    const { client } = make(http);
    const hits = await client.searchArtist("Real Artist");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entity.name).toBe("Real Artist");
    expect(hits[0]?.score).toBe(97);
  });

  it("sends a Lucene query for a recording search", async () => {
    const http = new FakeHttp().enqueue({ body: { recordings: [] } });
    const { client } = make(http);
    await client.searchRecording("Blur", "Song 2");
    const url = http.lastRequest?.url ?? "";
    expect(url).toContain("recording%3A%22Song+2%22");
    expect(url).toContain("artist%3A%22Blur%22");
  });
});

describe("release lookup", () => {
  it("sums the track count across every medium", async () => {
    // A box set reports one `media` entry per disc. Reading the first medium's
    // count is the mistake that makes a 3xCD release render as 12 tracks.
    const http = new FakeHttp().enqueue({
      body: {
        id: mbid(9),
        title: "The Collection",
        date: "1997-06-16",
        country: "GB",
        media: [{ "track-count": 12 }, { "track-count": 11 }],
        "artist-credit": [
          { name: "Blur", artist: { id: mbid(8), name: "Blur" } },
        ],
      },
    });
    const { client } = make(http);
    const release = await client.lookupRelease(mbid(9));

    expect(release?.trackCount).toBe(23);
    expect(release?.artistMbid).toBe(mbid(8));
    expect(release?.date).toBe("1997-06-16");
    // Without inc=media there is no track count at all, so the parameter is
    // asserted rather than assumed.
    expect(http.lastRequest?.url).toContain("media");
  });

  it("treats 404 as an empty answer about the catalogue, not a failure", async () => {
    const http = new FakeHttp().enqueue({ status: 404, body: {} });
    const { client } = make(http);
    await expect(client.lookupRelease(mbid(1))).resolves.toBeNull();
  });
});

describe("escapeLucene", () => {
  it("escapes syntax that would silently change the query", () => {
    // An unescaped quote does not error; it returns plausible wrong results,
    // and the crosswalk records those permanently.
    expect(escapeLucene("AC/DC")).toBe("AC\\/DC");
    expect(escapeLucene('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeLucene("!!! (band)")).toBe("\\!\\!\\! \\(band\\)");
  });
});

function mbid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
