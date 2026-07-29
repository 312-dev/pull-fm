import { describe, expect, it } from "vitest";

import { FakeClock, FakeHttp } from "../testing/fake-http.js";
import { LISTENBRAINZ_QUOTA, ListenBrainzClient } from "./client.js";

const TOKEN = "test-token-not-a-real-credential";

function make(http: FakeHttp, clock = new FakeClock()) {
  return new ListenBrainzClient({
    baseUrl: "https://lb.test",
    labsBaseUrl: "https://labs.test",
    fetch: http.fetch,
    clock,
    retry: { maxAttempts: 1 },
  });
}

function mbid(n: number): string {
  return `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

describe("ListenBrainzClient auth", () => {
  it("sends the per-user token as an Authorization header", async () => {
    const http = new FakeHttp().enqueue({ body: { payload: { mbids: [] } } });
    await make(http).recommendedRecordings("gray", TOKEN);
    expect(http.lastRequest?.headers["Authorization"]).toBe(`Token ${TOKEN}`);
    // The credential must never travel in the URL, where logs would capture it.
    expect(http.lastRequest?.url).not.toContain(TOKEN);
  });

  it("reports an invalid token without throwing", async () => {
    const http = new FakeHttp().enqueue({ status: 401, body: {} });
    expect(await make(http).validateToken(TOKEN)).toEqual({
      valid: false,
      userName: undefined,
    });
  });

  it("reports a valid token and the username it belongs to", async () => {
    const http = new FakeHttp().enqueue({
      body: { code: 200, valid: true, user_name: "gray" },
    });
    expect(await make(http).validateToken(TOKEN)).toEqual({
      valid: true,
      userName: "gray",
    });
  });
});

describe("ListenBrainzClient recommendations", () => {
  it("parses collaborative-filtered recordings with scores", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        payload: {
          mbids: [
            { recording_mbid: mbid(1), score: 0.98 },
            { recording_mbid: mbid(2), score: 0.71 },
            { recording_mbid: "not-a-uuid", score: 0.5 },
          ],
          model_id: "20260725-cf-recording",
        },
      },
    });
    const recs = await make(http).recommendedRecordings("gray", TOKEN, 3);
    expect(recs).toEqual([
      { recordingMbid: mbid(1), score: 0.98 },
      { recordingMbid: mbid(2), score: 0.71 },
    ]);
  });

  it("parses the createdfor playlists that back Weekly Discovery", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        playlist_count: 1,
        playlists: [
          {
            playlist: {
              identifier: "https://listenbrainz.org/playlist/abc",
              title: "Weekly Discovery for gray",
              annotation: "<p>x</p>",
              date: "2026-07-27T00:00:00Z",
            },
          },
        ],
      },
    });
    const playlists = await make(http).createdForPlaylists("gray", TOKEN);
    expect(playlists[0]?.title).toBe("Weekly Discovery for gray");
  });

  it("flattens the MBID-keyed lb-radio response", async () => {
    const http = new FakeHttp().enqueue({
      body: {
        [mbid(9)]: {
          artist_name: "Seed",
          recordings: [
            {
              recording_mbid: mbid(1),
              recording_name: "Track One",
              artist_mbid: mbid(5),
              artist_name: "Other",
              similarity: 0.9,
            },
          ],
        },
      },
    });
    const radio = await make(http).artistRadio(mbid(9), TOKEN);
    expect(radio).toEqual([
      {
        recordingMbid: mbid(1),
        recordingName: "Track One",
        artistMbid: mbid(5),
        artistName: "Other",
        similarity: 0.9,
      },
    ]);
  });

  it("treats 204 from the stats endpoint as 'not enough listens yet'", async () => {
    const http = new FakeHttp().enqueue({ status: 204, body: "" });
    expect(await make(http).topArtists("newuser", TOKEN)).toEqual([]);
  });
});

describe("ListenBrainzClient endpoints the audit found broken", () => {
  it("returns null for the 500 on /1/explore/lb-radio rather than failing a feed", async () => {
    const http = new FakeHttp().enqueue({
      status: 500,
      body: { code: 500, error: "Currently disabled due to high load" },
    });
    expect(await make(http).exploreRadio("energetic", TOKEN)).toBeNull();
  });
});

describe("ListenBrainzClient labs tier (no SLA)", () => {
  it("sends the exact algorithm enum labs requires", async () => {
    const http = new FakeHttp().enqueue({ body: [] });
    await make(http).similarArtists(mbid(4));
    expect(http.lastRequest?.url).toContain("algorithm=session_based_days_");
    expect(http.lastRequest?.url).toContain("labs.test");
  });

  it("returns [] when labs 500s, because labs failing is a normal condition", async () => {
    const http = new FakeHttp().always({ status: 500, body: {} });
    expect(await make(http).similarArtists(mbid(4))).toEqual([]);
  });

  it("returns [] when labs rejects a bad algorithm enum", async () => {
    const http = new FakeHttp().enqueue({
      status: 400,
      body: { error: "Invalid algorithm" },
    });
    expect(await make(http).similarArtists(mbid(4), "made-up")).toEqual([]);
  });

  it("does not let a labs outage open the circuit on the main API", async () => {
    const http = new FakeHttp().always({ status: 500, body: {} });
    const client = make(http);
    for (let i = 0; i < 5; i++) await client.similarArtists(mbid(4));
    expect(client.status()).toBe("ok");
  });

  it("parses similar artists when labs is healthy", async () => {
    const http = new FakeHttp().enqueue({
      body: [
        { artist_mbid: mbid(11), name: "Neighbour", score: 963 },
        { artist_mbid: "junk", name: "Bad", score: 1 },
      ],
    });
    const similar = await make(http).similarArtists(mbid(4));
    expect(similar).toEqual([
      { artistMbid: mbid(11), name: "Neighbour", score: 963 },
    ]);
  });
});

describe("ListenBrainzClient quota", () => {
  it("defaults to the observed 30 requests per 10 seconds", async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().always({ body: { payload: { mbids: [] } } });
    const client = make(http, clock);
    expect(LISTENBRAINZ_QUOTA).toEqual({ limit: 30, windowMs: 10_000 });
    for (let i = 0; i < 30; i++) {
      await client.recommendedRecordings("gray", TOKEN);
    }
    await expect(client.recommendedRecordings("gray", TOKEN)).rejects.toThrow(
      /quota/,
    );
  });
});
