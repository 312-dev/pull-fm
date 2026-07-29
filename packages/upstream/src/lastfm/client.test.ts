import { describe, expect, it } from "vitest";

import type { UpstreamError } from "../errors.js";
import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import {
  LASTFM_ATTRIBUTION,
  LastfmClient,
  artistUrl,
  signParams,
  trackUrl,
} from "./client.js";

function make(http: FakeHttp, sharedSecret?: string) {
  return new LastfmClient({
    apiKey: "test-api-key-not-real",
    ...(sharedSecret === undefined ? {} : { sharedSecret }),
    baseUrl: "https://lfm.test/2.0",
    fetch: http.fetch,
    clock: new FakeClock(),
    retry: { maxAttempts: 1 },
  });
}

describe("Last.fm attribution (ToS 2.7 / 4.2.2)", () => {
  it("builds the required last.fm/music/[artist] link format", () => {
    expect(artistUrl("Sigur Rós")).toBe(
      "https://www.last.fm/music/Sigur+R%C3%B3s",
    );
    // Spaces must be "+", not "%20": the %20 form redirects, and a redirect is
    // not the specified format the terms require.
    expect(artistUrl("The National")).toBe(
      "https://www.last.fm/music/The+National",
    );
    expect(trackUrl("Blur", "Song 2")).toBe(
      "https://www.last.fm/music/Blur/_/Song+2",
    );
  });

  it("synthesises the attribution link when the response omits url", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        similarartists: { artist: [{ name: "Portishead", match: "0.9" }] },
      },
    });
    const similar = await make(http).similarArtists("Massive Attack");
    expect(similar[0]?.url).toBe("https://www.last.fm/music/Portishead");
    expect(LASTFM_ATTRIBUTION).toBe("Data provided by Last.fm");
  });
});

describe("Last.fm in-band errors", () => {
  it("treats error 29 as rate limiting even on an HTTP 200", async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: {
        error: 29,
        message: "Rate limit exceeded - Your IP has made too many requests",
      },
    });
    const err = (await make(http)
      .similarArtists("Anyone")
      .catch((e: unknown) => e)) as UpstreamError;
    // A client that only reads the status code keeps hammering here, and that
    // is how an API key gets suspended.
    expect(err.kind).toBe("rate_limited");
    expect(err.status).toBe(429);
  });

  it("treats error 10 (invalid api key) as non-retryable", async () => {
    const http = new FakeHttp().enqueue({
      status: 403,
      body: { error: 10, message: "Invalid API key" },
    });
    const err = (await make(http)
      .artistInfo("Anyone")
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err.kind).toBe("http");
    expect(err.retryable).toBe(false);
  });

  it("treats error 8 (operation failed) as transient", async () => {
    const http = new FakeHttp().enqueue({
      status: 200,
      body: { error: 8, message: "Operation failed" },
    });
    const err = (await make(http)
      .artistInfo("Anyone")
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err.retryable).toBe(true);
  });
});

describe("Last.fm parsing", () => {
  it("parses similar artists including string-typed numbers", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        similarartists: {
          artist: [
            {
              name: "Portishead",
              mbid: "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11",
              match: "0.964",
              url: "https://www.last.fm/music/Portishead",
            },
          ],
        },
      },
    });
    const similar = await make(http).similarArtists("Massive Attack");
    expect(similar[0]?.match).toBeCloseTo(0.964);
    expect(similar[0]?.mbid).toBe("8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11");
  });

  it("handles a single tag returned as an object rather than an array", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        artist: {
          name: "Boards of Canada",
          tags: { tag: { name: "idm" } },
          stats: { listeners: "1234567" },
        },
      },
    });
    const artist = await make(http).artistInfo("Boards of Canada");
    expect(artist?.tags).toEqual(["idm"]);
    expect(artist?.listeners).toBe(1_234_567);
  });

  it("normalises track duration from either seconds or milliseconds", async () => {
    const seconds = new FakeHttp().enqueue({
      body: {
        similartracks: {
          track: [{ name: "A", duration: 245, artist: { name: "X" } }],
        },
      },
    });
    const millis = new FakeHttp().enqueue({
      body: { track: { name: "A", duration: "245000", artist: { name: "X" } } },
    });
    const fromSeconds = await make(seconds).similarTracks("X", "A");
    const fromMillis = await make(millis).trackInfo("X", "A");
    expect(fromSeconds[0]?.durationMs).toBe(245_000);
    expect(fromMillis?.durationMs).toBe(245_000);
  });

  it("sends the api key but never a user credential on public reads", async () => {
    const http = new FakeHttp().enqueue({
      body: { topartists: { artist: [] } },
    });
    await make(http).userTopArtists("gray");
    const url = http.lastRequest?.url ?? "";
    expect(url).toContain("api_key=test-api-key-not-real");
    expect(url).toContain("method=user.getTopArtists");
    expect(url).not.toContain("sk=");
  });
});

describe("Last.fm auth.getSession", () => {
  it("signs the parameters without including format", () => {
    // Including `format` in the signed set produces a signature that always
    // fails: the classic hour-long debugging detour with this API.
    const signature = signParams(
      { api_key: "k", method: "auth.getSession", token: "t" },
      "secret",
    );
    expect(signature).toMatch(/^[0-9a-f]{32}$/);
    expect(
      signParams(
        { method: "auth.getSession", api_key: "k", token: "t" },
        "secret",
      ),
    ).toBe(signature);
  });

  it("exchanges a request token for a session key", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        session: { name: "gray", key: "session-key-value", subscriber: 0 },
      },
    });
    const session = await make(http, "shared-secret").getSession(
      "request-token",
    );
    expect(session).toEqual({
      userName: "gray",
      sessionKey: "session-key-value",
    });
    const url = http.lastRequest?.url ?? "";
    expect(url).toContain("api_sig=");
    expect(url).toContain("format=json");
  });

  it("refuses to sign without a shared secret", async () => {
    await expect(make(new FakeHttp()).getSession("t")).rejects.toThrow(
      /SHARED_SECRET/,
    );
  });

  it("reports a malformed session response rather than returning junk", async () => {
    const http = new FakeHttp().enqueue({ body: { session: {} } });
    const err = (await make(http, "s")
      .getSession("t")
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err.kind).toBe("malformed");
  });
});
