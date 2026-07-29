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
