/**
 * A fake for every upstream music provider.
 *
 * NO TEST IN THIS REPOSITORY MAY CALL A REAL PROVIDER, and this file is what
 * makes that structural for the integration suites rather than a habit. Beyond
 * flakiness, the providers we depend on revoke access for exactly the traffic a
 * test suite produces: MusicBrainz blocks IPs, Apple documents about twenty
 * calls a minute with no appeals process, and Last.fm treats a terms breach as
 * grounds for immediate termination. `load/mock-upstreams` exists for the same
 * reason at a different scale.
 *
 * It answers with the SHAPES the real providers return, not with our parsed
 * types, so the client parsers run for real. A fake that returned already-parsed
 * objects would test the fake.
 *
 * `requests` records every call, which is how the suites assert the thing that
 * actually matters: that a warm cache produces ZERO upstream calls, and that no
 * request path ever reaches MusicBrainz or iTunes at all.
 */

import type { FetchLike, HttpResponse } from "@pull-fm/upstream";

export interface RecordedUpstreamCall {
  readonly url: string;
  readonly host: string;
  readonly path: string;
}

export interface FakeUpstreams {
  readonly fetch: FetchLike;
  readonly calls: RecordedUpstreamCall[];
  /** Calls to one host, by hostname fragment. */
  callsTo(fragment: string): RecordedUpstreamCall[];
  reset(): void;
  /** Forces every subsequent call to fail, for the degradation assertions. */
  breakEverything(): void;
  heal(): void;
}

/** A ListenBrainz artist MBID the fixtures agree on. */
export const FIXTURE_ARTIST_MBID = "b10bbff0-5354-4e2c-95a5-4b6b0d1a2b11";
export const FIXTURE_ARTIST_NAME = "Fixture Ensemble";
export const FIXTURE_RECORDING_MBID = "c20cbff0-5354-4e2c-95a5-4b6b0d1a2b22";
export const FIXTURE_RECORDING_TITLE = "Fixture Recording";
export const FIXTURE_RELEASE_MBID = "e40ebff0-5354-4e2c-95a5-4b6b0d1a2b44";

function json(body: unknown, status = 200): HttpResponse {
  const text = JSON.stringify(body);
  const headers = new Map<string, string>([
    ["content-type", "application/json"],
    // ListenBrainz publishes no numeric limit and documents that clients must
    // read these. Sending them here means the adaptive path runs in tests.
    ["x-ratelimit-limit", "30"],
    ["x-ratelimit-remaining", "29"],
    ["x-ratelimit-reset-in", "10"],
  ]);
  return {
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(text),
  };
}

export function fakeUpstreams(): FakeUpstreams {
  const calls: RecordedUpstreamCall[] = [];
  let broken = false;

  const fetch: FetchLike = (rawUrl) => {
    const url = new URL(rawUrl);
    calls.push({ url: rawUrl, host: url.hostname, path: url.pathname });

    if (broken) {
      return Promise.resolve(json({ error: "fixture outage" }, 503));
    }

    // --- ListenBrainz ------------------------------------------------------
    if (url.hostname === "api.listenbrainz.org") {
      if (url.pathname.includes("/cf/recommendation/")) {
        return Promise.resolve(
          json({
            payload: {
              mbids: [{ recording_mbid: FIXTURE_RECORDING_MBID, score: 0.91 }],
            },
          }),
        );
      }
      if (url.pathname.includes("/playlists/createdfor")) {
        return Promise.resolve(
          json({
            playlists: [
              {
                playlist: {
                  identifier: "https://listenbrainz.org/playlist/fixture",
                  title: "Weekly Fixtures",
                  annotation: "Generated for the fixture subject",
                },
              },
            ],
          }),
        );
      }
      if (url.pathname.includes("/lb-radio/artist/")) {
        return Promise.resolve(
          json({
            [FIXTURE_ARTIST_MBID]: {
              artist_name: FIXTURE_ARTIST_NAME,
              recordings: [
                {
                  recording_mbid: FIXTURE_RECORDING_MBID,
                  recording_name: FIXTURE_RECORDING_TITLE,
                  artist_mbid: FIXTURE_ARTIST_MBID,
                  artist_name: FIXTURE_ARTIST_NAME,
                  similarity: 0.8,
                },
              ],
            },
          }),
        );
      }
      if (url.pathname.includes("/stats/user/")) {
        return Promise.resolve(
          json({
            payload: {
              artists: [
                {
                  artist_mbid: FIXTURE_ARTIST_MBID,
                  artist_name: FIXTURE_ARTIST_NAME,
                  listen_count: 42,
                },
              ],
            },
          }),
        );
      }
      return Promise.resolve(json({}, 404));
    }

    if (url.hostname === "labs.api.listenbrainz.org") {
      return Promise.resolve(
        json([
          {
            artist_mbid: "d30dbff0-5354-4e2c-95a5-4b6b0d1a2b33",
            name: "Adjacent Ensemble",
            score: 12,
          },
        ]),
      );
    }

    // --- Last.fm -----------------------------------------------------------
    if (url.hostname === "ws.audioscrobbler.com") {
      // Case-insensitive on purpose: the real service is, and matching the
      // exact casing here would make the fake agree with a typo.
      const method = (url.searchParams.get("method") ?? "").toLowerCase();
      if (method === "artist.getsimilar") {
        return Promise.resolve(
          json({
            similarartists: {
              artist: [
                {
                  name: "Adjacent Ensemble",
                  match: "0.9",
                  url: "https://www.last.fm/music/Adjacent+Ensemble",
                },
              ],
            },
          }),
        );
      }
      if (method === "track.getsimilar") {
        return Promise.resolve(
          json({
            similartracks: {
              track: [
                {
                  name: "Adjacent Recording",
                  match: "0.7",
                  url: "https://www.last.fm/music/Adjacent+Ensemble/_/Adjacent+Recording",
                  artist: { name: "Adjacent Ensemble" },
                },
              ],
            },
          }),
        );
      }
      return Promise.resolve(json({ error: 6, message: "not found" }, 404));
    }

    // --- Deezer ------------------------------------------------------------
    // The only provider a REQUEST PATH is allowed to reach live, and only from
    // the preview route: their URLs are signed and expire, so they have to be
    // resolved at the moment of playback.
    if (url.hostname === "api.deezer.com") {
      return Promise.resolve(
        json({
          data: [
            {
              id: 12345,
              title: FIXTURE_RECORDING_TITLE,
              duration: 30,
              preview: `https://cdns-preview.dzcdn.net/fixture.mp3?hdnea=exp=${String(
                Math.floor(Date.now() / 1000) + 3600,
              )}~acl=/*~hmac=fixture`,
              artist: { name: FIXTURE_ARTIST_NAME },
              album: { title: "Fixture Album", cover_medium: "" },
            },
          ],
        }),
      );
    }

    // --- SeatGeek ----------------------------------------------------------
    if (url.hostname === "api.seatgeek.com") {
      if (url.pathname.endsWith("/performers")) {
        return Promise.resolve(
          json({
            performers: [
              { id: 9911, name: FIXTURE_ARTIST_NAME, slug: "fixture-ensemble" },
            ],
          }),
        );
      }
      if (url.pathname.endsWith("/events")) {
        return Promise.resolve(
          json({
            events: [
              {
                id: 7788,
                title: `${FIXTURE_ARTIST_NAME} at the Fixture Hall`,
                short_title: FIXTURE_ARTIST_NAME,
                type: "concert",
                datetime_utc: "2026-09-01T02:00:00",
                datetime_local: "2026-08-31T21:00:00",
                datetime_tbd: false,
                url: "https://seatgeek.com/e/7788?aid=affiliate",
                venue: {
                  id: 55,
                  name: "Fixture Hall",
                  city: "Chicago",
                  state: "IL",
                  country: "US",
                  url: "https://seatgeek.com/venues/55?aid=affiliate",
                },
                performers: [{ id: 9911, name: FIXTURE_ARTIST_NAME }],
              },
            ],
          }),
        );
      }
      return Promise.resolve(json({}, 404));
    }

    // --- MusicBrainz -------------------------------------------------------
    // Answered correctly, because the BACKGROUND warm path is real code that
    // needs testing. That no REQUEST path reaches it is asserted separately,
    // with `callsTo("musicbrainz")`, which is a stronger check than making the
    // fake fail: a 500 here would also be satisfied by code that calls
    // MusicBrainz and swallows the error.
    if (url.hostname === "musicbrainz.org") {
      if (url.pathname.startsWith("/ws/2/artist/")) {
        return Promise.resolve(
          json({
            id: FIXTURE_ARTIST_MBID,
            name: FIXTURE_ARTIST_NAME,
            "sort-name": "Ensemble, Fixture",
            country: "GB",
            "life-span": { begin: "1999" },
            // Supplementary data (CC BY-NC-SA 3.0). Present in the payload so
            // the test can prove we neither request nor parse it.
            tags: [{ name: "should-never-be-parsed", count: 3 }],
          }),
        );
      }
      if (url.pathname.startsWith("/ws/2/recording/")) {
        return Promise.resolve(
          json({
            id: FIXTURE_RECORDING_MBID,
            title: FIXTURE_RECORDING_TITLE,
            length: 214_000,
            "artist-credit": [
              {
                name: FIXTURE_ARTIST_NAME,
                artist: { id: FIXTURE_ARTIST_MBID, name: FIXTURE_ARTIST_NAME },
              },
            ],
          }),
        );
      }
      if (url.pathname.startsWith("/ws/2/release/")) {
        return Promise.resolve(
          json({
            id: FIXTURE_RELEASE_MBID,
            title: "Fixture Album",
            date: "2001-04-02",
            country: "GB",
            media: [{ "track-count": 7 }, { "track-count": 4 }],
            "artist-credit": [
              {
                name: FIXTURE_ARTIST_NAME,
                artist: { id: FIXTURE_ARTIST_MBID, name: FIXTURE_ARTIST_NAME },
              },
            ],
          }),
        );
      }
      return Promise.resolve(json({}, 404));
    }

    // --- iTunes ------------------------------------------------------------
    if (url.hostname === "itunes.apple.com") {
      return Promise.resolve(
        json({
          resultCount: 1,
          results: [
            {
              trackId: 4242,
              trackName: FIXTURE_RECORDING_TITLE,
              artistName: FIXTURE_ARTIST_NAME,
              collectionName: "Fixture Album",
              trackTimeMillis: 30_000,
              previewUrl:
                "https://audio-ssl.itunes.apple.com/fixture/preview.m4a",
              // Apple licence condition (ii). Without it the resolver refuses
              // to persist or serve the preview at all.
              trackViewUrl:
                "https://music.apple.com/us/album/fixture/1?i=4242&uo=4",
            },
          ],
        }),
      );
    }

    return Promise.resolve(json({ error: "unknown provider" }, 500));
  };

  return {
    fetch,
    calls,
    callsTo: (fragment) => calls.filter((c) => c.host.includes(fragment)),
    reset: () => {
      calls.length = 0;
    },
    breakEverything: () => {
      broken = true;
    },
    heal: () => {
      broken = false;
    },
  };
}
