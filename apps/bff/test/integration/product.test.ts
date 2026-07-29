/**
 * The product surface, end to end.
 *
 * Three things are asserted here that no unit test can reach, because all three
 * are properties of the wiring rather than of any one component:
 *
 *   1. WHAT IS NOT CALLED. MusicBrainz permits one request per second across
 *      the whole service and iTunes about twenty calls a minute. A
 *      request path that reaches either is a defect, and the only way to prove
 *      it does not is to count the calls. `upstreams.callsTo` is the assertion
 *      that matters most in this file.
 *   2. DEGRADATION IS A 200. A dead provider removes a shelf and sets
 *      `degraded`; it does not fail the request. Asserted by breaking every
 *      upstream and demanding a 200 back.
 *   3. THE LICENCE RULES. A Deezer preview URL is never persisted, SeatGeek
 *      data is unreachable through a personal API token, event attribution
 *      carries `logoRequired`, and outbound links carry no affiliate
 *      parameters. Each is a contractual obligation that a schema alone cannot
 *      enforce.
 *
 * No test in this file reaches a real provider. See test/helpers/upstreams.ts.
 */

import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import { jsonOf } from "../helpers/json.js";
import { provisionSubject, type Subject } from "../helpers/subjects.js";
import {
  FIXTURE_ARTIST_MBID,
  FIXTURE_ARTIST_NAME,
  FIXTURE_RECORDING_MBID,
  FIXTURE_RECORDING_TITLE,
  FIXTURE_RELEASE_MBID,
} from "../helpers/upstreams.js";

interface Envelope {
  sections: { kind: string; title: string; items: unknown[] }[];
  cursor: string | null;
  degraded: boolean;
  unavailableProviders: string[];
  attribution: { source: string; text: string; url?: string }[];
}

let ctx: TestApp;
let subject: Subject;

/** Connects ListenBrainz through the real connect flow with a mock provider. */
async function connect(as: Subject): Promise<void> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/v1/connections/listenbrainz",
    headers: {
      authorization: `Bearer ${as.token}`,
      "idempotency-key": `connect-${randomUUID()}`,
    },
    payload: { token: `lb_${as.id}` },
  });
  expect(res.statusCode).toBeLessThan(300);
}

function get(url: string, as: Subject | null = subject) {
  return ctx.app.inject({
    method: "GET",
    url,
    headers: as === null ? {} : { authorization: `Bearer ${as.token}` },
  });
}

beforeAll(async () => {
  ctx = await buildTestApp();
  subject = await provisionSubject(ctx, "product");
  await connect(subject);
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

beforeEach(() => {
  ctx.upstreams.heal();
  ctx.upstreams.reset();
});

describe("GET /v1/feed", () => {
  test("returns sections with the attribution the licences require", async () => {
    const res = await get("/v1/feed");
    expect(res.statusCode).toBe(200);
    const body = jsonOf<Envelope>(res);

    expect(body.sections.length).toBeGreaterThan(0);
    for (const section of body.sections) {
      expect(typeof section.kind).toBe("string");
      expect(section.items.length).toBeGreaterThan(0);
    }
    // Last.fm's terms mandate their link format and the client cannot render
    // what it cannot see, so the array travelling with the data is the control.
    expect(body.attribution.map((a) => a.source)).toContain("listenbrainz");
  });

  test("never reaches MusicBrainz or iTunes", async () => {
    // The whole cache-first architecture exists for this assertion. One request
    // per second globally means a feed render that fanned out to MusicBrainz
    // would be a remote kill switch operated by whoever refreshes fastest.
    await get("/v1/feed");
    expect(ctx.upstreams.callsTo("musicbrainz")).toEqual([]);
    expect(ctx.upstreams.callsTo("itunes")).toEqual([]);
  });

  test("a warm cache costs zero upstream calls", async () => {
    await get("/v1/feed");
    ctx.upstreams.reset();
    const res = await get("/v1/feed");

    expect(res.statusCode).toBe(200);
    // Gate 2 requires a warm hit rate above 90 percent. A second identical
    // render spending nothing is the strongest form of that.
    expect(ctx.upstreams.calls).toEqual([]);
  });

  test("a dead provider degrades the feed instead of failing it", async () => {
    const fresh = await provisionSubject(ctx, "degraded");
    await connect(fresh);
    ctx.upstreams.breakEverything();

    const res = await get("/v1/feed", fresh);
    expect(res.statusCode).toBe(200);
    const body = jsonOf<Envelope>(res);
    expect(body.degraded).toBe(true);
    expect(body.unavailableProviders).toContain("listenbrainz");
    expect(body.sections).toEqual([]);
  });

  test("a subject with no connection gets an honest empty feed, not an error", async () => {
    const stranger = await provisionSubject(ctx, "stranger");
    const res = await get("/v1/feed", stranger);

    expect(res.statusCode).toBe(200);
    const body = jsonOf<Envelope>(res);
    expect(body.sections).toEqual([]);
    expect(body.degraded).toBe(true);
    // We are not broken; we simply do not know them yet.
    expect(body.unavailableProviders).toContain("listenbrainz");
  });

  test("rejects a cursor issued to another subject", async () => {
    const other = await provisionSubject(ctx, "cursor-thief");
    const foreign = ctx.services.discovery.feedCursor(other.id, 0);
    const res = await get(`/v1/feed?cursor=${encodeURIComponent(foreign)}`);
    expect(res.statusCode).toBe(400);
  });

  test("marks the response private so no shared cache can serve it onward", async () => {
    const res = await get("/v1/feed");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});

describe("GET /v1/recommendations", () => {
  test("returns only the sections that are about this account", async () => {
    const res = await get("/v1/recommendations");
    expect(res.statusCode).toBe(200);
    const kinds = jsonOf<Envelope>(res).sections.map((s) => s.kind);
    for (const kind of kinds) {
      expect(["made_for_you", "because_you_like", "daily_mix"]).toContain(kind);
    }
  });

  test("exposes no raw upstream payload", async () => {
    // Last.fm and MusicBrainz licence their data for use, not redistribution,
    // so the token surface must carry our derived form and nothing else.
    const res = await get("/v1/recommendations");
    expect(res.body).not.toContain("similarartists");
    expect(res.body).not.toContain("artist-credit");
    expect(res.body).not.toContain("recording_mbid");
  });
});

describe("GET /v1/stations", () => {
  test("lists a station per seed artist, with a signed identifier", async () => {
    const res = await get("/v1/stations");
    expect(res.statusCode).toBe(200);
    const body = jsonOf<Envelope>(res);
    const items = body.sections[0]?.items as { id: string }[] | undefined;
    expect(items?.length).toBeGreaterThan(0);
    // Not a UUID and not a database key: a signed value binding subject and
    // seed, so there is no row whose id could be substituted.
    expect(items?.[0]?.id).toContain(".");
  });

  test("a station identifier minted for another subject is a 404", async () => {
    const other = await provisionSubject(ctx, "station-thief");
    const foreign = ctx.services.discovery.stationId(
      other.id,
      FIXTURE_ARTIST_MBID,
    );
    const res = await get(`/v1/stations/${encodeURIComponent(foreign)}/tracks`);
    expect(res.statusCode).toBe(404);
  });

  test("a tampered identifier is the same 404 as an unknown one", async () => {
    // A differential response would tell an attacker whether a guessed
    // identifier was ever real.
    const own = ctx.services.discovery.stationId(
      subject.id,
      FIXTURE_ARTIST_MBID,
    );
    const tampered = `${own.slice(0, -2)}xy`;
    const res = await get(
      `/v1/stations/${encodeURIComponent(tampered)}/tracks`,
    );
    expect(res.statusCode).toBe(404);
  });

  test("the owner gets tracks for their own station", async () => {
    const own = ctx.services.discovery.stationId(
      subject.id,
      FIXTURE_ARTIST_MBID,
    );
    const res = await get(`/v1/stations/${encodeURIComponent(own)}/tracks`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(FIXTURE_RECORDING_TITLE);
  });
});

describe("the catalogue routes", () => {
  test("search is served from the crosswalk and calls nothing", async () => {
    // The feed learns (name, MBID) pairs from ListenBrainz, which is what warms
    // the crosswalk without a backfill job.
    await get("/v1/feed");
    ctx.upstreams.reset();

    const res = await get(
      `/v1/search?q=${encodeURIComponent(FIXTURE_ARTIST_NAME)}`,
    );
    expect(res.statusCode).toBe(200);
    expect(ctx.upstreams.calls).toEqual([]);

    const body = jsonOf<Envelope>(res);
    expect(body.sections[0]?.kind).toBe("search_results");
    expect(body.sections[0]?.items.length).toBeGreaterThan(0);
  });

  test("an unresolved artist is a 404 rather than a MusicBrainz lookup", async () => {
    const res = await get(`/v1/artists/${randomUUID()}`);
    expect(res.statusCode).toBe(404);
    expect(ctx.upstreams.callsTo("musicbrainz")).toEqual([]);
  });

  test("a warmed artist is served from the cache, still calling nothing", async () => {
    await ctx.services.discovery.warmArtist(FIXTURE_ARTIST_MBID);
    ctx.upstreams.reset();

    const res = await get(`/v1/artists/${FIXTURE_ARTIST_MBID}`);
    expect(res.statusCode).toBe(200);
    expect(ctx.upstreams.calls).toEqual([]);

    const body = jsonOf<{ name: string; resolution: string }>(res);
    expect(body.name).toBe(FIXTURE_ARTIST_NAME);
    expect(body.resolution).toBe("musicbrainz");
  });

  test("never exposes MusicBrainz supplementary data", async () => {
    // Core MusicBrainz data is CC0. Tags, genres and ratings are CC BY-NC-SA
    // 3.0, and surfacing them would attach NonCommercial and ShareAlike terms
    // to this response and to anything built on it. The fixture payload
    // contains a tag precisely so this assertion can fail if one ever leaks.
    await ctx.services.discovery.warmArtist(FIXTURE_ARTIST_MBID);
    const res = await get(`/v1/artists/${FIXTURE_ARTIST_MBID}`);
    expect(res.body).not.toContain("should-never-be-parsed");
    expect(res.body).not.toContain("tags");
  });

  test("similar artists blends both sources and credits both", async () => {
    const res = await get(`/v1/artists/${FIXTURE_ARTIST_MBID}/similar`);
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      artists: { name: string; sources: string[] }[];
      attribution: { source: string }[];
    }>(res);

    expect(body.artists.length).toBeGreaterThan(0);
    const sources = new Set(body.artists.flatMap((a) => a.sources));
    expect(sources).toContain("listenbrainz:labs-similar");
    expect(sources).toContain("lastfm:similar");
    expect(body.attribution.map((a) => a.source)).toContain("lastfm");
  });

  test("a warmed release reports the track count summed across every medium", async () => {
    await ctx.services.discovery.warmRelease(FIXTURE_RELEASE_MBID);
    const res = await get(`/v1/albums/${FIXTURE_RELEASE_MBID}`);
    expect(res.statusCode).toBe(200);
    // 7 + 4. Reading the first medium is how a box set renders as half an album.
    expect(jsonOf<{ trackCount: number }>(res).trackCount).toBe(11);
  });
});

describe("GET /v1/tracks/:mbid/preview", () => {
  test("resolves a Deezer URL live and refuses to persist it", async () => {
    await ctx.services.discovery.warmRecording(FIXTURE_RECORDING_MBID);

    const res = await get(`/v1/tracks/${FIXTURE_RECORDING_MBID}/preview`);
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      provider: string;
      cacheable: boolean;
      expiresAt: number | null;
      url: string;
    }>(res);

    expect(body.provider).toBe("deezer");
    // The whole point. A stored Deezer URL passes every test written against a
    // warm cache and then 403s for users minutes later.
    expect(body.cacheable).toBe(false);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.url).toContain("hdnea=");

    const stored = await ctx.services.db.query(
      "SELECT provider FROM track_previews WHERE recording_mbid = $1",
      [FIXTURE_RECORDING_MBID],
    );
    expect(stored.rows).toEqual([]);

    // And no intermediary may keep it either.
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  test("an iTunes preview carries the store badge Apple's licence requires", async () => {
    // Apple's grant is six CONJUNCTIVE conditions. Condition (ii) requires the
    // preview to sit next to an approved store badge linking directly to the
    // page where THIS track can be purchased, so the badge and its per-item
    // link have to reach the client with the URL. Resolved through the
    // background path, which is the only path allowed to call iTunes.
    const mbid = FIXTURE_RECORDING_MBID;
    await ctx.services.upstream.previews.resolve({
      recordingMbid: mbid,
      artistName: FIXTURE_ARTIST_NAME,
      title: FIXTURE_RECORDING_TITLE,
    });
    ctx.upstreams.reset();

    const res = await get(`/v1/tracks/${mbid}/preview`);
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      provider: string;
      cacheable: boolean;
      attribution: {
        text: string;
        badge?: {
          required: boolean;
          linkUrl: string;
          placement: string;
          ordering: string;
        };
      };
    }>(res);

    expect(body.provider).toBe("itunes");
    expect(body.cacheable).toBe(true);
    // Condition (iii): the exact phrase.
    expect(body.attribution.text).toContain("courtesy of iTunes");
    // Condition (ii): a badge, and a link to this track rather than a homepage.
    expect(body.attribution.badge?.required).toBe(true);
    expect(body.attribution.badge?.linkUrl).toContain("music.apple.com");
    expect(body.attribution.badge?.placement).toBe("proximate-to-preview");
    expect(body.attribution.badge?.ordering).toBe("first");

    // And the store link is persisted, because the badge cannot be rebuilt
    // from a preview URL alone.
    const stored = await ctx.services.db.query<{ store_url: string | null }>(
      "SELECT store_url FROM track_previews WHERE recording_mbid = $1",
      [mbid],
    );
    expect(stored.rows[0]?.store_url).toContain("music.apple.com");

    // Serving it again spends nothing: no request path may call Apple.
    await get(`/v1/tracks/${mbid}/preview`);
    expect(ctx.upstreams.callsTo("itunes")).toEqual([]);

    // Clean up so the Deezer assertions above stay meaningful in any order.
    await ctx.services.db.query(
      "DELETE FROM track_previews WHERE recording_mbid = $1",
      [mbid],
    );
  });

  test("an unknown recording is a 404 and spends no iTunes budget", async () => {
    const res = await get(`/v1/tracks/${randomUUID()}/preview`);
    expect(res.statusCode).toBe(404);
    expect(ctx.upstreams.callsTo("itunes")).toEqual([]);
  });
});

describe("GET /v1/artists/:mbid/events", () => {
  beforeEach(async () => {
    await ctx.services.discovery.warmArtist(FIXTURE_ARTIST_MBID);
    ctx.upstreams.reset();
  });

  test("returns events with logo attribution, coverage, and no affiliate links", async () => {
    const res = await get(
      `/v1/artists/${FIXTURE_ARTIST_MBID}/events?country=US&city=Chicago`,
    );
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      coverage: string;
      artistUnknownToProvider: boolean;
      events: { url: string; venue?: { url?: string } }[];
      attribution: {
        logoRequired: boolean;
        logoAssetPage: string;
        linkUrl: string;
        logoModification: string;
      };
    }>(res);

    // Terms 3.1 require the LOGO, not a text credit. A `{source, text, url}`
    // shape cannot say that, which is why events are not in the feed envelope.
    expect(body.attribution.logoRequired).toBe(true);
    expect(body.attribution.logoAssetPage).toContain("seatgeek.com/press");
    expect(body.attribution.linkUrl).toBe("https://seatgeek.com");
    expect(body.attribution.logoModification).toBe("proportional-resize-only");

    // Coverage is part of the answer: an empty shelf in Berlin means "we cannot
    // see much here", which is a different message from "no shows".
    expect(body.coverage).toBe("primary");
    expect(body.artistUnknownToProvider).toBe(false);

    expect(body.events.length).toBeGreaterThan(0);
    // Pull.fm is locked non-commercial, so every outbound link is query
    // stripped. The fixture payload carries `?aid=affiliate` on purpose.
    for (const event of body.events) {
      expect(event.url).not.toContain("aid=");
      expect(event.venue?.url ?? "").not.toContain("aid=");
    }
  });

  test("reports limited coverage outside the provider's catalogue", async () => {
    const res = await get(
      `/v1/artists/${FIXTURE_ARTIST_MBID}/events?country=DE`,
    );
    expect(res.statusCode).toBe(200);
    expect(jsonOf<{ coverage: string }>(res).coverage).toBe("limited");
  });

  test("is unreachable with a personal API token", async () => {
    // THE COMPLIANCE ASSERTION. SeatGeek terms 7.13 forbid making their
    // material available to a search engine, directory, or AI/ML system. A
    // personal API token is a long-lived script-facing credential whose
    // consumer we cannot see, so event data must never travel through it.
    const minted = await ctx.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: {
        authorization: `Bearer ${subject.token}`,
        "idempotency-key": `events-token-${randomUUID()}`,
      },
      payload: { name: "events probe" },
    });
    const token = jsonOf<{ token: string }>(minted).token;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/artists/${FIXTURE_ARTIST_MBID}/events?country=US`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("seatgeek");

    // And the same token DOES work on a route that is meant to serve it, so
    // the 403 above is about this route rather than about a broken token.
    const allowed = await ctx.app.inject({
      method: "GET",
      url: "/v1/recommendations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.statusCode).toBe(200);
  });

  test("an artist we cannot name is a 404, not an empty list", async () => {
    const res = await get(`/v1/artists/${randomUUID()}/events?country=US`);
    expect(res.statusCode).toBe(404);
    expect(ctx.upstreams.callsTo("seatgeek")).toEqual([]);
  });
});

describe("events disabled", () => {
  test("answers 501 when no provider is configured", async () => {
    // The kill switch rather than an absent credential: the switch is the
    // lever that gets pulled if SeatGeek ever write to say our use breaches
    // their terms, and "stop now" is measured in hours, not deploy cycles.
    const off = await buildTestApp({ env: { SEATGEEK_ENABLED: "false" } });
    try {
      const guest = await provisionSubject(off, "events-off");
      const res = await off.app.inject({
        method: "GET",
        url: `/v1/artists/${FIXTURE_ARTIST_MBID}/events`,
        headers: { authorization: `Bearer ${guest.token}` },
      });
      // 501 rather than an empty list: "this deployment has no events" and
      // "this artist is not touring" are different answers and a client
      // renders them differently.
      expect(res.statusCode).toBe(501);

      const config = await off.app.inject({ method: "GET", url: "/v1/config" });
      expect(
        jsonOf<{ features: { events: boolean } }>(config).features.events,
      ).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe("GET /v1/config", () => {
  test("reports live provider health rather than a hard-coded list", async () => {
    const res = await get("/v1/config", null);
    expect(res.statusCode).toBe(200);
    const body = jsonOf<{
      features: Record<string, boolean>;
      providers: Record<string, string>;
    }>(res);
    expect(body.features["discovery"]).toBe(true);
    expect(body.features["events"]).toBe(true);
    for (const status of Object.values(body.providers)) {
      expect(["ok", "degraded", "disabled"]).toContain(status);
    }
  });
});

/**
 * COLD-CACHE STAMPEDE, end to end.
 *
 * The cache-first architecture assumes a miss is rare. That assumption is false
 * for exactly one shape of traffic, and it is the shape a launch produces: one
 * cold key that many users want in the same second. None of those requests has
 * returned yet, so none of them has written the row the others would have hit,
 * and a read-through cache alone suppresses nothing at all.
 *
 * These assertions count UPSTREAM CALLS rather than measuring latency, because
 * the count is the compliance property. MusicBrainz permits one request per
 * second across the whole service and iTunes about twenty a minute, neither with
 * an appeals process, so a hundred-to-one fan-out is a revoked integration
 * rather than a slow page.
 */
describe("a cold cache does not stampede", () => {
  // Real providers answer in tens to hundreds of milliseconds against a cache
  // read of about one. That gap IS the stampede window, so a zero-latency fake
  // would let every request serialise behind its own database read and these
  // tests would pass while measuring nothing.
  beforeEach(() => {
    ctx.upstreams.setLatency(40);
  });
  afterEach(() => {
    ctx.upstreams.setLatency(0);
  });

  test("a hundred concurrent requests for the same cold artist make one call", async () => {
    // A never-seen MBID, so every layer is genuinely cold. Reusing a fixture
    // would let a row warmed by an earlier test pass this vacuously.
    const cold = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 100 }, () => get(`/v1/artists/${cold}/similar`)),
    );

    for (const res of responses) expect(res.statusCode).toBe(200);
    // The whole point: one hundred requests, one upstream call.
    expect(ctx.upstreams.callsTo("labs.api.listenbrainz.org")).toHaveLength(1);
  });

  test("a burst of feed renders costs a constant, not one call each", async () => {
    const burst = await provisionSubject(ctx, "stampede-feed");
    await connect(burst);
    ctx.upstreams.reset();

    const responses = await Promise.all(
      Array.from({ length: 40 }, () => get("/v1/feed", burst)),
    );
    for (const res of responses) expect(res.statusCode).toBe(200);

    // A feed render touches several distinct keys, and the blend fetches some
    // of them in sequence, so the figure is a small constant rather than one.
    // What must hold is that it does not scale with the request count: without
    // coalescing this is several hundred calls.
    expect(ctx.upstreams.calls.length).toBeLessThan(10);
    // And still nothing may reach the two rate-limited providers.
    expect(ctx.upstreams.callsTo("musicbrainz")).toEqual([]);
    expect(ctx.upstreams.callsTo("itunes")).toEqual([]);
  });

  test("concurrent play requests resolve one preview, not one each", async () => {
    await ctx.services.discovery.warmRecording(FIXTURE_RECORDING_MBID);
    // Any iTunes row left by an earlier test would make this pass vacuously by
    // never reaching a provider at all.
    await ctx.services.db.query(
      "DELETE FROM track_previews WHERE recording_mbid = $1",
      [FIXTURE_RECORDING_MBID],
    );
    ctx.upstreams.reset();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        get(`/v1/tracks/${FIXTURE_RECORDING_MBID}/preview`),
      ),
    );

    for (const res of responses) expect(res.statusCode).toBe(200);
    expect(ctx.upstreams.callsTo("deezer")).toHaveLength(1);
    // A shared signed URL is correct: it is the same one Deezer would have
    // minted for each caller. What must never happen is persisting it.
    const stored = await ctx.services.db.query(
      "SELECT provider FROM track_previews WHERE recording_mbid = $1",
      [FIXTURE_RECORDING_MBID],
    );
    expect(stored.rows).toEqual([]);
  });

  test("a shared upstream failure is not retried once per caller", async () => {
    const cold = randomUUID();
    ctx.upstreams.breakEverything();

    const responses = await Promise.all(
      Array.from({ length: 30 }, () => get(`/v1/artists/${cold}/similar`)),
    );

    // labs.api has no SLA and contributes nothing rather than degrading the
    // response, so this is still a 200 with an empty list.
    for (const res of responses) expect(res.statusCode).toBe(200);
    // Thirty retries against a provider that just failed is the stampede again,
    // wearing the costume of resilience.
    expect(
      ctx.upstreams.callsTo("labs.api.listenbrainz.org").length,
    ).toBeLessThanOrEqual(1);
  });
});

/**
 * Pathological identifiers.
 *
 * An identifier reaches upstream URL construction, so anything that is not a
 * canonical UUID has to die at the schema rather than inside a client
 * (THREAT-MODEL T15/M31). A value containing `@`, `/`, `?`, `#` or CRLF is the
 * cheapest known path from a request to a redirected, credentialed upstream
 * call.
 */
describe("pathological identifiers are rejected before any upstream call", () => {
  const hostile: Record<string, string> = {
    "unicode digits": "١٢٣٤٥٦٧٨-٩٠١٢-٤٣٤٥-٨٦٧٨-٩٠١٢٣٤٥٦٧٨٩٠",
    "homoglyph hex": "b10bbff0-5354-4e2c-95a5-4b6b0d1a2Ь11",
    "CRLF injection": "b10bbff0-5354-4e2c-95a5-4b6b0d1a2b11%0d%0aX:1",
    "path traversal": "..%2f..%2fadmin",
    "url in the id": "https://evil.example/a",
    "at-sign host swap": "b10bbff0%40evil.example",
    "null byte": "b10bbff0-5354-4e2c-95a5-4b6b0d1a2b11%00",
    "zero width joiner": "b10bbff0-5354-4e2c-95a5-4b6b0d1a2b1‍1",
    "combining marks": "b10bbff0-5354-4e2c-95a5-4b6b0d1a2b1é",
    "right to left override": "b10bbff0-5354-4e2c-95a5-4b6b0d1a2b‮11",
    "sql-ish": "b10bbff0-5354-4e2c-95a5-4b6b0d1a2b11' OR '1'='1",
  };

  for (const [label, mbid] of Object.entries(hostile)) {
    test(`${label} is a 400 on every catalogue route and spends nothing`, async () => {
      const encoded = encodeURIComponent(mbid);
      for (const path of [
        `/v1/artists/${encoded}`,
        `/v1/artists/${encoded}/similar`,
        `/v1/tracks/${encoded}`,
        `/v1/tracks/${encoded}/preview`,
        `/v1/albums/${encoded}`,
      ]) {
        const res = await get(path);
        expect(res.statusCode).toBe(400);
        // RFC 9457, like every other error on this surface.
        expect(res.headers["content-type"]).toContain(
          "application/problem+json",
        );
      }
      expect(ctx.upstreams.calls).toEqual([]);
    });
  }

  test("an identifier longer than the URI limit is refused at the edge", async () => {
    // Rejected by the HTTP layer before routing rather than by the schema, so
    // the status is 414. Asserted separately because the assertion that matters
    // is the same either way: it never reaches a handler and never becomes part
    // of an upstream URL.
    const res = await get(`/v1/artists/${"0".repeat(8192)}`);
    expect([400, 414]).toContain(res.statusCode);
    expect(ctx.upstreams.calls).toEqual([]);
  });

  test("a unicode search term is served from the crosswalk without calling out", async () => {
    // Search takes free text by design, so the control here is not rejection:
    // it is that no user-supplied string can reach a provider at all.
    for (const q of [
      "Björk",
      "米津玄師",
      "🎵🎶",
      "'; DROP TABLE users; --",
      "a".repeat(256),
    ]) {
      const res = await get(`/v1/search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode).toBe(200);
    }
    expect(ctx.upstreams.calls).toEqual([]);
  });

  test("a search term past the schema limit is a 400, not a truncated query", async () => {
    const res = await get(`/v1/search?q=${"a".repeat(257)}`);
    expect(res.statusCode).toBe(400);
  });
});
