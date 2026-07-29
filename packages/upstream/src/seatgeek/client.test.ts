import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { UpstreamError } from "../errors.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import {
  PersonalDataRejectedError,
  SEATGEEK_ALLOWED_PARAMS,
  SEATGEEK_ATTRIBUTION,
  SEATGEEK_BASE_URL,
  SEATGEEK_PRIMARY_COVERAGE,
  SeatGeekClient,
  assertNoPersonalData,
  describeAuthFailure,
  parseEvent,
} from "./client.js";

const CLIENT_ID = "test-client-id-not-a-real-credential";
const CLIENT_SECRET = "test-client-secret-not-a-real-credential";

function make(http: FakeHttp, withSecret = true) {
  return new SeatGeekClient({
    clientId: CLIENT_ID,
    ...(withSecret ? { clientSecret: CLIENT_SECRET } : {}),
    baseUrl: "https://sg.test/2",
    fetch: http.fetch,
    clock: new FakeClock(),
    retry: { maxAttempts: 1 },
  });
}

function eventFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 6_543_210,
    title: "Young The Giant with Grouplove",
    short_title: "Young The Giant",
    type: "concert",
    datetime_utc: "2026-09-14T02:00:00",
    datetime_local: "2026-09-13T21:00:00",
    datetime_tbd: false,
    url: "https://seatgeek.com/young-the-giant-tickets/6543210",
    venue: {
      id: 88,
      name: "Terminal 5",
      city: "New York",
      state: "NY",
      country: "US",
      url: "https://seatgeek.com/terminal-5-tickets/",
    },
    performers: [
      {
        id: 8741,
        name: "Young The Giant",
        slug: "young-the-giant",
        type: "band",
      },
    ],
    // Present in real responses and deliberately unpopulated by SeatGeek.
    stats: { lowest_price: null, average_price: null },
    ...overrides,
  };
}

describe("SeatGeek authentication", () => {
  it("uses HTTP Basic and keeps the credential out of the URL", async () => {
    const http = new FakeHttp().enqueue({ body: { events: [] } });
    await make(http).listEvents({ performerId: 8741 });

    const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64")}`;
    expect(http.lastRequest?.headers["Authorization"]).toBe(expected);
    // Query strings leak through access logs, proxies, and referrer headers.
    expect(http.lastRequest?.url).not.toContain("client_id");
    expect(http.lastRequest?.url).not.toContain(CLIENT_ID);
    expect(http.lastRequest?.url).not.toContain(CLIENT_SECRET);
  });

  it("falls back to the client_id query parameter only when there is no secret", async () => {
    const http = new FakeHttp().enqueue({ body: { events: [] } });
    await make(http, false).listEvents({ performerId: 1 });
    expect(http.lastRequest?.headers["Authorization"]).toBeUndefined();
    expect(http.lastRequest?.url).toContain(`client_id=${CLIENT_ID}`);
  });

  it("distinguishes 40307 (no credential) from 40302 (credential rejected)", () => {
    // Different operational meanings: one is a config bug, the other a revoked
    // key. Collapsing them into "403" costs an hour of the wrong debugging.
    expect(describeAuthFailure({ code: 40307 })).toContain(
      "configuration error",
    );
    expect(describeAuthFailure({ code: 40302 })).toContain("wrong or revoked");
    expect(describeAuthFailure({ code: 200 })).toBeNull();
    expect(describeAuthFailure(null)).toBeNull();
  });

  it("raises the specific auth message rather than a bare 403", async () => {
    const http = new FakeHttp().enqueue({
      status: 403,
      body: { status: 403, code: 40302, message: "Invalid client credentials" },
    });
    const err = (await make(http)
      .listEvents({ performerId: 1 })
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err.message).toContain("40302");
    expect(err.message).not.toContain(CLIENT_SECRET);
  });
});

describe("SeatGeek queries", () => {
  it("prefers an id lookup and excludes past events", async () => {
    const http = new FakeHttp().enqueue({ body: { events: [] } });
    await make(http).listEvents({
      performerId: 8741,
      city: "Chicago",
      state: "IL",
      country: "US",
      fromUtc: "2026-07-29T00:00:00.000Z",
    });
    const url = http.lastRequest?.url ?? "";
    expect(url).toContain("performers.id=8741");
    expect(url).toContain("venue.city=Chicago");
    expect(url).toContain("datetime_utc.gte=2026-07-29");
    // Scoped queries keep us far from the 10,000-result cap that landed
    // 2026-01-01, which is why no bulk sync is needed for this product.
    expect(url).toContain("per_page=");
  });

  it("searches performers by name, never by a guessed slug", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        performers: [{ id: 8741, name: "Radiohead", slug: "radiohead" }],
      },
    });
    const performers = await make(http).searchPerformers("Radiohead");
    // performers.slug=radiohead returns 0 results against the live API.
    expect(http.lastRequest?.url).toContain("q=Radiohead");
    expect(http.lastRequest?.url).not.toContain("slug=");
    expect(performers[0]?.id).toBe(8741);
  });

  it("returns an empty list for a 404 rather than failing", async () => {
    const http = new FakeHttp().enqueue({ status: 404, body: {} });
    expect(await make(http).searchPerformers("Nobody")).toEqual([]);
  });
});

describe("SeatGeek response shapes", () => {
  it("parses the enveloped shape the live service returns", async () => {
    const http = new FakeHttp().enqueue({
      body: { events: [eventFixture()], meta: { total: 1, page: 1 } },
    });
    const events = await make(http).listEvents({ performerId: 8741 });
    expect(events).toHaveLength(1);
    expect(events[0]?.venue?.city).toBe("New York");
  });

  it("parses the bare-array shape the vendored OpenAPI spec declares", async () => {
    // The spec says `type: array`; the live service returns an envelope. Both
    // are accepted rather than betting on which document is right.
    const http = new FakeHttp().enqueue({ body: [eventFixture()] });
    const events = await make(http).listEvents({ performerId: 8741 });
    expect(events).toHaveLength(1);
  });

  it("does not model prices, which SeatGeek does not return", () => {
    const parsed = parseEvent(eventFixture());
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("price");
    expect(Object.keys(parsed ?? {})).not.toContain("stats");
  });

  it("drops the datetime when the vendor flags it TBD", () => {
    const parsed = parseEvent(eventFixture({ datetime_tbd: true }));
    expect(parsed?.datetimeTbd).toBe(true);
  });
});

describe("SeatGeek vendored spec", () => {
  const specPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "vendor-specs",
    "seatgeek-platform-v2.openapi.json",
  );
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as {
    servers: { url: string }[];
    paths: Record<string, unknown>;
    components?: { securitySchemes?: Record<string, unknown> };
  };

  it("agrees with the base URL the client uses", () => {
    expect(spec.servers.some((s) => s.url === SEATGEEK_BASE_URL)).toBe(true);
  });

  it("declares the endpoints this client calls", () => {
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/events",
        "/performers",
        "/performers/{performerId}",
      ]),
    );
  });

  it("records that the spec documents no security scheme", () => {
    // Auth is absent from the document, so the Basic-auth choice comes from
    // SeatGeek's authentication docs plus a live verification, not the spec.
    expect(spec.components?.securitySchemes ?? {}).toEqual({});
  });

  it("ignores /recommendations: discovery comes from ListenBrainz", () => {
    expect(Object.keys(spec.paths)).toContain("/recommendations");
    const client = make(new FakeHttp());
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object),
    ).not.toContain("recommendations");
  });
});

describe("SeatGeek personal data (terms 4.4)", () => {
  it("sends no coordinate, postal code, or user identifier", async () => {
    const http = new FakeHttp().enqueue({ body: { events: [] } });
    await make(http).listEvents({
      performerId: 8741,
      city: "Chicago",
      state: "IL",
      country: "US",
    });
    const url = http.lastRequest?.url ?? "";
    for (const forbidden of [
      "lat=",
      "lon=",
      "latitude",
      "longitude",
      "geoip",
      "postal_code",
      "user_id",
      "user=",
      "email",
      "ip=",
    ]) {
      expect(url).not.toContain(forbidden);
    }
    // Only a coarse place name leaves the process.
    expect(url).toContain("venue.city=Chicago");
  });

  it("rejects a parameter that is not on the allow-list", () => {
    expect(() => {
      assertNoPersonalData({ lat: "41.8781", lon: "-87.6298" });
    }).toThrow(PersonalDataRejectedError);
    expect(() => {
      assertNoPersonalData({ geoip: "203.0.113.7" });
    }).toThrow(PersonalDataRejectedError);
    expect(() => {
      assertNoPersonalData({ user_id: "u_123" });
    }).toThrow(PersonalDataRejectedError);
  });

  it("rejects a precise coordinate even under an allowed parameter name", () => {
    // The leak that matters is the one smuggled through a legitimate field.
    expect(() => {
      assertNoPersonalData({ "venue.city": "41.8781" });
    }).toThrow(/coordinate/);
    expect(() => {
      assertNoPersonalData({ q: "-87.62980" });
    }).toThrow(/coordinate/);
  });

  it("rejects a postal code offered as a city", () => {
    expect(() => {
      assertNoPersonalData({ "venue.city": "60614" });
    }).toThrow(/postal code/);
  });

  it("rejects an email address anywhere in the query", () => {
    expect(() => {
      assertNoPersonalData({ q: "fan@example.com" });
    }).toThrow(/email/);
  });

  it("allows the ordinary coarse query unchanged", () => {
    expect(() => {
      assertNoPersonalData({
        "performers.id": 8741,
        "venue.city": "Chicago",
        "venue.state": "IL",
        "venue.country": "US",
        per_page: 20,
        "datetime_utc.gte": "2026-07-29T00:00:00.000Z",
      });
    }).not.toThrow();
  });

  it("keeps the credential out of a rejection message", () => {
    const err = (() => {
      try {
        assertNoPersonalData({ lat: "41.8781" });
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(String(err)).not.toContain(CLIENT_ID);
    expect(String(err)).not.toContain(CLIENT_SECRET);
  });

  it("has no postal-code or coordinate parameter on the allow-list at all", () => {
    for (const banned of [
      "venue.postal_code",
      "postal_code",
      "lat",
      "lon",
      "geoip",
      "range",
    ]) {
      expect(SEATGEEK_ALLOWED_PARAMS.has(banned)).toBe(false);
    }
  });
});

describe("SeatGeek attribution (terms 3.1)", () => {
  it("requires the logo, not a credit string", () => {
    // "Event data provided by SeatGeek" does not satisfy 3.1.
    expect(SEATGEEK_ATTRIBUTION.logoRequired).toBe(true);
    expect(SEATGEEK_ATTRIBUTION.logoAssetPage).toBe(
      "https://seatgeek.com/press",
    );
    expect(typeof SEATGEEK_ATTRIBUTION).not.toBe("string");
  });

  it("links every instance to the SeatGeek homepage", () => {
    expect(SEATGEEK_ATTRIBUTION.linkUrl).toBe("https://seatgeek.com");
  });

  it("permits proportional resizing only", () => {
    expect(SEATGEEK_ATTRIBUTION.logoModification).toBe(
      "proportional-resize-only",
    );
  });
});

describe("SeatGeek coverage", () => {
  it("declares the US and Canada as the dependable catalogue", () => {
    expect([...SEATGEEK_PRIMARY_COVERAGE]).toEqual(["US", "CA"]);
  });
});
