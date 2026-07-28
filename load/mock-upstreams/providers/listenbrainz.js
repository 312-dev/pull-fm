import {
  artistFor,
  recordingFor,
  recordingMbid,
  artistMbid,
  fnv1a,
  mulberry32,
} from "../../lib/catalog.js";

/**
 * ListenBrainz.
 *
 * Only the endpoints docs/UPSTREAM-TERMS.md verified as working are modeled as
 * healthy. The endpoints the audit found broken are modeled as broken, on
 * purpose:
 *
 *   /1/explore/lb-radio                        500, "disabled due to high load"
 *   /1/popularity/top-recordings-for-artist/*  500
 *   /1/similar-artists, /1/similar-recordings  404 on api.*, they live on labs.*
 *
 * A mock that happily serves those would let us build a feed section on an
 * endpoint that does not work, and the load test would certify it.
 */
export const listenbrainz = {
  handle(ctx) {
    const p = ctx.pathname;

    if (p === "/1/validate-token") {
      return {
        status: 200,
        body: {
          code: 200,
          message: "Token valid.",
          valid: true,
          user_name: "loadtest",
        },
      };
    }

    let m = /^\/1\/cf\/recommendation\/user\/([^/]+)\/recording$/.exec(p);
    if (m)
      return cfRecommendations(
        decodeURIComponent(m[1]),
        Number(ctx.query.get("count") ?? 25),
      );

    m = /^\/1\/user\/([^/]+)\/playlists\/createdfor$/.exec(p);
    if (m) return createdForPlaylists(decodeURIComponent(m[1]));

    m = /^\/1\/lb-radio\/artist\/([0-9a-f-]{36})$/.exec(p);
    if (m) return lbRadioArtist(m[1]);

    m = /^\/1\/stats\/user\/([^/]+)\/artists$/.exec(p);
    if (m) return userTopArtists(decodeURIComponent(m[1]));

    // labs.api.listenbrainz.org similarity, reachable through the same mock.
    if (
      p.startsWith("/similar-artists") ||
      p.startsWith("/similar-recordings")
    ) {
      if (!ctx.query.get("algorithm")) {
        // The real labs API rejects a missing or wrong algorithm enum.
        return { status: 400, body: { error: "Invalid algorithm" } };
      }
      return similar(
        ctx.query.get("artist_mbids") ?? ctx.query.get("recording_mbids") ?? "",
      );
    }

    if (p.startsWith("/1/explore/lb-radio")) {
      return {
        status: 500,
        body: { code: 500, error: "Currently disabled due to high load" },
      };
    }
    if (p.startsWith("/1/popularity/top-recordings-for-artist")) {
      return {
        status: 500,
        body: { code: 500, error: "Internal server error" },
      };
    }
    if (
      p.startsWith("/1/similar-artists") ||
      p.startsWith("/1/similar-recordings")
    ) {
      return { status: 404, body: { code: 404, error: "Not found" } };
    }

    return { status: 404, body: { code: 404, error: "Not found" } };
  },
};

function cfRecommendations(user, count) {
  const rnd = mulberry32(fnv1a(`cf:${user}`));
  const n = Math.min(Math.max(count, 1), 100);
  const mbids = [];
  for (let i = 0; i < n; i++) {
    mbids.push({
      recording_mbid: recordingMbid(Math.floor(rnd() * 2_000_000)),
      score: Number((1 - i / (n * 1.2)).toFixed(6)),
      latest_listened_at: null,
    });
  }
  return {
    status: 200,
    body: {
      payload: {
        count: mbids.length,
        entity: "recording",
        last_updated: Math.floor(Date.now() / 1000) - 86_400 * 3,
        mbids,
        model_id: "20260725-cf-recording",
        model_url: "https://listenbrainz.org",
        offset: 0,
        total_mbid_count: 1000,
        user_name: user,
      },
    },
  };
}

function createdForPlaylists(user) {
  const stamp = new Date().toISOString();
  return {
    status: 200,
    body: {
      playlist_count: 2,
      playlists: ["Weekly Jams", "Weekly Discovery"].map((title, i) => ({
        playlist: {
          annotation: `<p>${title} for ${user}</p>`,
          creator: "troi-bot",
          date: stamp,
          identifier: `https://listenbrainz.org/playlist/${recordingMbid(fnv1a(`${user}:${i}`))}`,
          title: `${title} for ${user}, week of ${stamp.slice(0, 10)}`,
          extension: {
            "https://musicbrainz.org/doc/jspf#playlist": {
              creator: "troi-bot",
              public: true,
            },
          },
        },
      })),
    },
  };
}

function lbRadioArtist(mbid) {
  const rnd = mulberry32(fnv1a(`lbr:${mbid}`));
  const seed = artistFor(mbid);
  const recordings = [];
  for (let i = 0; i < 15; i++) {
    const r = recordingFor(recordingMbid(Math.floor(rnd() * 2_000_000)));
    recordings.push({
      recording_mbid: r.mbid,
      recording_name: r.title,
      artist_mbid: r.artist.mbid,
      artist_name: r.artist.name,
      similarity: Number((1 - i * 0.05).toFixed(3)),
    });
  }
  return {
    status: 200,
    body: { [seed.mbid]: { artist_name: seed.name, recordings } },
  };
}

function userTopArtists(user) {
  const rnd = mulberry32(fnv1a(`top:${user}`));
  const artists = [];
  for (let i = 0; i < 25; i++) {
    const a = artistFor(artistMbid(Math.floor(rnd() * 2_000_000)));
    artists.push({
      artist_mbid: a.mbid,
      artist_name: a.name,
      listen_count: 500 - i * 15,
    });
  }
  return {
    status: 200,
    body: {
      payload: {
        artists,
        count: artists.length,
        from_ts: 0,
        last_updated: Math.floor(Date.now() / 1000),
        offset: 0,
        range: "all_time",
        to_ts: Math.floor(Date.now() / 1000),
        total_artist_count: 4000,
        user_id: user,
      },
    },
  };
}

function similar(mbidCsv) {
  const first = mbidCsv.split(",")[0] ?? "";
  const rnd = mulberry32(fnv1a(`sim:${first}`));
  const out = [];
  for (let i = 0; i < 18; i++) {
    const a = artistFor(artistMbid(Math.floor(rnd() * 2_000_000)));
    out.push({
      artist_mbid: a.mbid,
      name: a.name,
      score: 1000 - i * 37,
      reference_mbid: first,
    });
  }
  return { status: 200, body: out };
}
