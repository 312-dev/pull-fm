/**
 * The local-first client, tested from both sides of its one decision.
 *
 * Two properties matter more than the rest and both are asserted directly rather
 * than inferred from a hit count:
 *
 *   1. WITH THE FLAG OFF, NOT ONE QUERY IS ISSUED and the behaviour is byte for
 *      byte the inherited client's. That is what makes the flag a kill switch
 *      instead of a preference, and it is exactly what SEATGEEK_ENABLED failed
 *      to be.
 *   2. A LOCAL ANSWER IS RE-VERIFIED. `combined_lookup` is a concatenation, so a
 *      prefix scan finds near-misses and an exact key can be reached by a
 *      different (artist, title) split. Without the re-fold the resolver writes
 *      the wrong MBID into a UNIQUE-keyed crosswalk, permanently.
 */

import { describe, expect, it } from "vitest";

import { RateLimiter } from "../rate-limiter.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import { MUSICBRAINZ_MIN_INTERVAL_MS } from "./client.js";
import type {
  CanonicalLoadState,
  CanonicalRow,
  CanonicalStore,
} from "./canonical-store.js";
import { LocalFirstMusicBrainzClient } from "./local-first.js";

const UA = "PullFM/0.1.0 (ope@312.dev)";

function mbid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function row(over: Partial<CanonicalRow> = {}): CanonicalRow {
  return {
    recordingMbid: mbid(1),
    recordingName: "The Boxer",
    releaseMbid: mbid(2),
    releaseName: "Bridge Over Troubled Water",
    artistMbid: mbid(3),
    artistMbids: [mbid(3)],
    artistCreditName: "Simon & Garfunkel",
    score: 564,
    ...over,
  };
}

/** Records every call so "did it touch the database" is directly assertable. */
class FakeCanonical implements CanonicalStore {
  exactCalls: string[] = [];
  prefixCalls: [string, string][] = [];
  exact: CanonicalRow[] = [];
  prefix: CanonicalRow[] = [];

  loadState(): Promise<CanonicalLoadState | null> {
    return Promise.resolve(null);
  }
  lookupExact(key: string): Promise<CanonicalRow[]> {
    this.exactCalls.push(key);
    return Promise.resolve(this.exact);
  }
  lookupArtistPrefix(k: string, upper: string): Promise<CanonicalRow[]> {
    this.prefixCalls.push([k, upper]);
    return Promise.resolve(this.prefix);
  }
  lookupRecordingMbid(): Promise<CanonicalRow | null> {
    return Promise.resolve(null);
  }
  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  get touched(): number {
    return this.exactCalls.length + this.prefixCalls.length;
  }
}

function make(
  opts: { enabled?: boolean | undefined; canonical?: CanonicalStore } = {},
  http = new FakeHttp(),
) {
  const clock = new FakeClock();
  const limiter = new RateLimiter({
    minIntervalMs: MUSICBRAINZ_MIN_INTERVAL_MS,
    maxQueueDepth: 100,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
  });
  const client = new LocalFirstMusicBrainzClient({
    userAgent: UA,
    rateLimiter: limiter,
    baseUrl: "https://mb.test/ws/2",
    fetch: http.fetch,
    clock,
    ...(opts.canonical === undefined ? {} : { canonical: opts.canonical }),
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
  });
  return { client, http, limiter, clock };
}

describe("the flag defaults to OFF and is a real kill switch", () => {
  it("is disabled when `enabled` is not passed at all", async () => {
    const canonical = new FakeCanonical();
    canonical.exact = [row()];
    const http = new FakeHttp().always({ body: { recordings: [] } });
    const { client } = make({ canonical }, http);

    await client.searchRecording("Simon & Garfunkel", "The Boxer");

    expect(canonical.touched).toBe(0);
    expect(client.localStats.enabled).toBe(false);
    expect(client.localStats.remoteFallbacks).toBe(1);
  });

  it("is disabled when `enabled` is anything other than the boolean true", async () => {
    // A "false" string out of an environment, a null through JSON, an undefined
    // from an optional property: all of them must leave this off. `enabled ===
    // true` is the only accepting comparison.
    for (const value of ["true", 1, {}, null, undefined] as unknown[]) {
      const canonical = new FakeCanonical();
      canonical.exact = [row()];
      const http = new FakeHttp().always({ body: { recordings: [] } });
      const { client } = make(
        { canonical, enabled: value as boolean | undefined },
        http,
      );
      await client.searchRecording("Simon & Garfunkel", "The Boxer");
      expect(canonical.touched).toBe(0);
    }
  });

  it("is disabled when the flag is on but no store was wired", async () => {
    const http = new FakeHttp().always({ body: { recordings: [] } });
    const { client } = make({ enabled: true }, http);
    await client.searchRecording("a", "b");
    expect(client.localStats.enabled).toBe(false);
  });

  it("issues the identical upstream request it would have without the feature", async () => {
    const canonical = new FakeCanonical();
    const http = new FakeHttp().always({ body: { artists: [] } });
    const { client } = make({ canonical, enabled: false }, http);
    await client.searchArtist("Björk", 3);
    expect(http.lastRequest?.url).toContain("/artist");
    expect(http.lastRequest?.headers["User-Agent"]).toBe(UA);
  });
});

describe("recording search", () => {
  it("answers from the local table without an upstream call", async () => {
    const canonical = new FakeCanonical();
    canonical.exact = [row()];
    const http = new FakeHttp().always({ body: { recordings: [] } });
    const { client, limiter } = make({ canonical, enabled: true }, http);

    const hits = await client.searchRecording("Simon & Garfunkel", "The Boxer");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.entity.mbid).toBe(mbid(1));
    expect(hits[0]?.entity.artistMbid).toBe(mbid(3));
    expect(hits[0]?.score).toBe(100);
    expect(http.requests).toHaveLength(0);
    // The pacer is untouched, which is the whole point: it sees less traffic and
    // behaves no differently for the traffic it does see.
    expect(limiter.stats.dispatched).toBe(0);
    expect(client.localStats.localHits).toBe(1);
  });

  it("looks the key up with the dump's own fold", async () => {
    const canonical = new FakeCanonical();
    canonical.exact = [row()];
    const { client } = make({ canonical, enabled: true });
    await client.searchRecording("Simon & Garfunkel", "The Boxer");
    expect(canonical.exactCalls[0]).toBe("simongarfunkeltheboxer");
  });

  it("tries the decorated title first and the stripped one second", async () => {
    const canonical = new FakeCanonical();
    canonical.exact = [];
    const http = new FakeHttp().always({ body: { recordings: [] } });
    const { client } = make({ canonical, enabled: true }, http);

    await client.searchRecording(
      "Pink Floyd",
      "Wish You Were Here - 2011 Remaster",
    );

    expect(canonical.exactCalls).toEqual([
      "pinkfloydwishyouwerehere2011remaster",
      "pinkfloydwishyouwerehere",
    ]);
  });

  it("REJECTS a row whose artist credit does not fold to the query's", async () => {
    // The fold concatenates, so artist "ab" + title "c" and artist "a" +
    // title "bc" produce one key. Only comparing the artist halves separates
    // them, and without this the resolver records the wrong MBID permanently.
    const canonical = new FakeCanonical();
    canonical.exact = [row({ artistCreditName: "Simon and Garfunke" })];
    const http = new FakeHttp().always({ body: { recordings: [] } });
    const { client } = make({ canonical, enabled: true }, http);

    const hits = await client.searchRecording("Simon & Garfunkel", "The Boxer");

    expect(hits).toEqual([]);
    expect(http.requests).toHaveLength(1);
    expect(client.localStats.remoteFallbacks).toBe(1);
  });

  it("falls through to the network on a local miss, unchanged", async () => {
    const canonical = new FakeCanonical();
    const http = new FakeHttp().always({
      body: {
        recordings: [
          { id: mbid(9), title: "The Boxer", score: 97, "artist-credit": [] },
        ],
      },
    });
    const { client, limiter } = make({ canonical, enabled: true }, http);

    const hits = await client.searchRecording("Simon & Garfunkel", "The Boxer");

    expect(hits[0]?.entity.mbid).toBe(mbid(9));
    expect(hits[0]?.score).toBe(97);
    expect(limiter.stats.dispatched).toBe(1);
    expect(client.localStats.remoteFallbacks).toBe(1);
  });

  it("does not query at all for a key it cannot transliterate", async () => {
    // The dump publishes a pinyin transliteration this implementation cannot
    // reproduce, so the row is unreachable and the query is decidably pointless.
    // Counted separately from a miss, because it is a permanent coverage gap
    // rather than something a load will fix.
    const canonical = new FakeCanonical();
    const http = new FakeHttp().always({ body: { recordings: [] } });
    const { client } = make({ canonical, enabled: true }, http);

    await client.searchRecording("Various Artists", "乡愁四韵");

    expect(canonical.touched).toBe(0);
    expect(client.localStats.unmatchable).toBe(1);
    expect(client.localStats.remoteFallbacks).toBe(1);
  });

  it("de-duplicates by recording MBID and honours the limit", async () => {
    const canonical = new FakeCanonical();
    canonical.exact = [
      row(),
      row(),
      row({ recordingMbid: mbid(4) }),
      row({ recordingMbid: mbid(5) }),
    ];
    const { client } = make({ canonical, enabled: true });
    const hits = await client.searchRecording(
      "Simon & Garfunkel",
      "The Boxer",
      2,
    );
    expect(hits.map((h) => h.entity.mbid)).toEqual([mbid(1), mbid(4)]);
  });
});

describe("artist search", () => {
  it("answers from a prefix scan, with the bound computed locally", async () => {
    const canonical = new FakeCanonical();
    canonical.prefix = [row()];
    const { client } = make({ canonical, enabled: true });

    const hits = await client.searchArtist("Simon & Garfunkel");

    expect(canonical.prefixCalls[0]).toEqual([
      "simongarfunkel",
      "simongarfunkem",
    ]);
    expect(hits[0]?.entity.mbid).toBe(mbid(3));
    expect(hits[0]?.entity.name).toBe("Simon & Garfunkel");
  });

  it("REJECTS an artist whose name merely starts with the query", async () => {
    // "beatles" and "beatlesque" share a prefix. Resolving one to the other
    // would be a permanent false merge in the crosswalk.
    const canonical = new FakeCanonical();
    canonical.prefix = [
      row({ artistCreditName: "Beatlesque", artistMbid: mbid(7) }),
    ];
    const http = new FakeHttp().always({ body: { artists: [] } });
    const { client } = make({ canonical, enabled: true }, http);

    const hits = await client.searchArtist("Beatles");

    expect(hits).toEqual([]);
    expect(http.requests).toHaveLength(1);
  });

  it("keeps the exact-match rows out of a prefix scan that also found near misses", async () => {
    const canonical = new FakeCanonical();
    canonical.prefix = [
      row({ artistCreditName: "Beatlesque", artistMbid: mbid(7) }),
      row({ artistCreditName: "The Beatles", artistMbid: mbid(8) }),
    ];
    const { client } = make({ canonical, enabled: true });
    const hits = await client.searchArtist("The Beatles");
    expect(hits.map((h) => h.entity.mbid)).toEqual([mbid(8)]);
  });

  it("reports nothing it does not know rather than guessing", async () => {
    // The dump carries no sort name, country or begin year. Emitting an empty
    // string would be written into a cache as though MusicBrainz had said so.
    const canonical = new FakeCanonical();
    canonical.prefix = [row()];
    const { client } = make({ canonical, enabled: true });
    const [hit] = await client.searchArtist("Simon & Garfunkel");
    expect(hit?.entity.sortName).toBeUndefined();
    expect(hit?.entity.country).toBeUndefined();
    expect(hit?.entity.beganYear).toBeUndefined();
  });

  it("de-duplicates by artist MBID across an artist's many recordings", async () => {
    const canonical = new FakeCanonical();
    canonical.prefix = [row(), row({ recordingMbid: mbid(4) }), row()];
    const { client } = make({ canonical, enabled: true });
    const hits = await client.searchArtist("Simon & Garfunkel");
    expect(hits).toHaveLength(1);
  });
});

describe("MBID lookups are deliberately NOT intercepted", () => {
  it("still calls upstream for lookupRecording, because the dump has no length", async () => {
    const canonical = new FakeCanonical();
    canonical.exact = [row()];
    const http = new FakeHttp().always({
      body: { id: mbid(1), title: "The Boxer", length: 308000 },
    });
    const { client } = make({ canonical, enabled: true }, http);

    const rec = await client.lookupRecording(mbid(1));

    expect(rec?.lengthMs).toBe(308000);
    expect(http.requests).toHaveLength(1);
    expect(canonical.touched).toBe(0);
  });

  it("still calls upstream for lookupArtist", async () => {
    const canonical = new FakeCanonical();
    const http = new FakeHttp().always({
      body: { id: mbid(3), name: "Simon & Garfunkel", country: "US" },
    });
    const { client } = make({ canonical, enabled: true }, http);
    const artist = await client.lookupArtist(mbid(3));
    expect(artist?.country).toBe("US");
    expect(canonical.touched).toBe(0);
  });
});
