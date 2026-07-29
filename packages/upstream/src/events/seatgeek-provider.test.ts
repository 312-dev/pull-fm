import { describe, expect, it } from "vitest";

import { CachedUpstream } from "../cache/cache-first.js";
import { MemoryCacheStore } from "../cache/memory-store.js";
import { KillSwitch } from "../kill-switch.js";
import { SeatGeekClient } from "../seatgeek/client.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import {
  EVENTS_TTL_SECONDS,
  PERFORMER_ID_TTL_SECONDS,
  SeatGeekEventsProvider,
  coverageFor,
} from "./seatgeek-provider.js";
import { sanitizeOutboundUrl } from "./types.js";

const MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";

function build(http: FakeHttp, killSwitch?: KillSwitch) {
  const clock = new FakeClock();
  let now = clock.now();
  const store = new MemoryCacheStore(() => now);
  const cache = new CachedUpstream(store, { now: () => now });
  const client = new SeatGeekClient({
    clientId: "id",
    clientSecret: "secret",
    baseUrl: "https://sg.test/2",
    fetch: http.fetch,
    clock,
    retry: { maxAttempts: 1 },
    ...(killSwitch === undefined ? {} : { killSwitch }),
  });
  const provider = new SeatGeekEventsProvider({ client, cache });
  return { provider, advance: (ms: number) => (now += ms) };
}

function performersResponse(name = "Radiohead", id = 8741) {
  return {
    body: { performers: [{ id, name, slug: "radiohead", type: "band" }] },
  };
}

function eventsResponse(url = "https://seatgeek.com/radiohead-tickets/999") {
  return {
    body: {
      events: [
        {
          id: 999,
          title: "Radiohead",
          short_title: "Radiohead",
          type: "concert",
          datetime_utc: "2026-10-01T02:00:00",
          datetime_local: "2026-09-30T21:00:00",
          datetime_tbd: false,
          url,
          venue: {
            id: 5,
            name: "United Center",
            city: "Chicago",
            state: "IL",
            country: "US",
            url: "https://seatgeek.com/united-center-tickets/",
          },
          performers: [{ id: 8741, name: "Radiohead" }],
        },
      ],
    },
  };
}

describe("sanitizeOutboundUrl (non-commercial: no affiliate parameters)", () => {
  it("strips every query parameter and fragment", () => {
    expect(
      sanitizeOutboundUrl(
        "https://seatgeek.com/e/999?aid=12345&utm_source=x#top",
      ),
    ).toBe("https://seatgeek.com/e/999");
    expect(sanitizeOutboundUrl("https://seatgeek.com/e/999")).toBe(
      "https://seatgeek.com/e/999",
    );
  });
});

describe("SeatGeekEventsProvider", () => {
  it("resolves a performer id once, then queries by id", async () => {
    const http = new FakeHttp()
      .enqueue(performersResponse())
      .enqueue(eventsResponse())
      .enqueue(eventsResponse());
    const { provider, advance } = build(http);
    const query = {
      artistMbid: MBID,
      artistName: "Radiohead",
      city: "Chicago",
      state: "IL",
      country: "US",
    };

    await provider.findEventsForArtist(query);
    // Past the events TTL but well inside the performer-id TTL.
    advance((EVENTS_TTL_SECONDS + 1) * 1000);
    await provider.findEventsForArtist(query);

    const performerSearches = http.requests.filter((r) =>
      r.url.includes("/performers"),
    );
    expect(performerSearches).toHaveLength(1);
    expect(PERFORMER_ID_TTL_SECONDS).toBeGreaterThan(EVENTS_TTL_SECONDS);
  });

  it("caches the event list, so a repeat render costs nothing", async () => {
    const http = new FakeHttp()
      .enqueue(performersResponse())
      .enqueue(eventsResponse());
    const { provider } = build(http);
    const query = { artistMbid: MBID, artistName: "Radiohead", country: "US" };

    const first = await provider.findEventsForArtist(query);
    const second = await provider.findEventsForArtist(query);

    expect(http.callCount).toBe(2);
    expect(second.events).toEqual(first.events);
  });

  it("emits no affiliate or tracking parameters on any outbound link", async () => {
    const http = new FakeHttp()
      .enqueue(performersResponse())
      .enqueue(
        eventsResponse(
          "https://seatgeek.com/radiohead-tickets/999?aid=11111&utm_medium=partner&pid=abc",
        ),
      );
    const { provider } = build(http);
    const result = await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Radiohead",
      country: "US",
    });

    const links = [
      result.events[0]?.url ?? "",
      result.events[0]?.venue?.url ?? "",
    ];
    for (const link of links) {
      expect(link).not.toContain("?");
      expect(link).not.toMatch(/aid=|utm_|pid=|affiliate|partner/i);
    }
    expect(result.events[0]?.url).toBe(
      "https://seatgeek.com/radiohead-tickets/999",
    );
  });

  it("never exposes a price field, because SeatGeek does not return one", async () => {
    const http = new FakeHttp()
      .enqueue(performersResponse())
      .enqueue(eventsResponse());
    const { provider } = build(http);
    const result = await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Radiohead",
      country: "US",
    });
    expect(JSON.stringify(result)).not.toMatch(/price|listing/i);
    expect(provider.metadata.pricingUnavailable).toBe(true);
  });

  it("distinguishes 'not in the catalogue' from 'no shows'", async () => {
    const http = new FakeHttp().enqueue({ body: { performers: [] } });
    const { provider } = build(http);
    const result = await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Some Obscure Band",
      country: "US",
    });
    expect(result.artistUnknownToProvider).toBe(true);
    expect(result.events).toEqual([]);
  });

  it("caches a negative resolution so unknown artists stay cheap", async () => {
    const http = new FakeHttp().enqueue({ body: { performers: [] } });
    const { provider } = build(http);
    const query = {
      artistMbid: MBID,
      artistName: "Some Obscure Band",
      country: "US",
    };
    await provider.findEventsForArtist(query);
    await provider.findEventsForArtist(query);
    // Most artists in a discovery feed are not in a ticketing catalogue; not
    // caching that answer would mean a name search on every feed render.
    expect(http.callCount).toBe(1);
  });

  it("rejects a fuzzy near-match like a tribute act", async () => {
    const http = new FakeHttp().enqueue(
      performersResponse("Radiohead Tribute Band Chicago", 42),
    );
    const { provider } = build(http);
    const result = await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Radiohead",
      country: "US",
    });
    // A wrong performer id would be cached for 30 days.
    expect(result.artistUnknownToProvider).toBe(true);
  });

  it("reports coverage so a client can explain an empty shelf honestly", async () => {
    const http = new FakeHttp().always({ body: { performers: [] } });
    const { provider } = build(http);
    const de = await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Kraftwerk",
      country: "DE",
    });
    expect(de.coverage).toBe("limited");
    expect(coverageFor("US")).toBe("primary");
    expect(coverageFor("ca")).toBe("primary");
    expect(coverageFor(undefined)).toBe("unknown");
  });

  it("degrades to an empty shelf when the kill switch is off", async () => {
    const killSwitch = new KillSwitch(["seatgeek"]);
    const http = new FakeHttp().always({ body: { performers: [] } });
    const { provider } = build(http, killSwitch);
    const result = await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Radiohead",
      country: "US",
    });
    expect(result.events).toEqual([]);
    expect(http.callCount).toBe(0);
  });

  it("keys the cache by location, not by performer alone", async () => {
    const http = new FakeHttp()
      .enqueue(performersResponse())
      .enqueue(eventsResponse())
      .enqueue(eventsResponse());
    const { provider } = build(http);
    await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Radiohead",
      city: "Chicago",
      country: "US",
    });
    await provider.findEventsForArtist({
      artistMbid: MBID,
      artistName: "Radiohead",
      city: "New York",
      country: "US",
    });
    expect(http.requests.filter((r) => r.url.includes("/events"))).toHaveLength(
      2,
    );
  });
});
