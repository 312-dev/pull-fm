import {
  artistFor,
  recordingFor,
  recordingMbid,
  artistMbid,
  fnv1a,
  mulberry32,
} from "../../lib/catalog.js";

/**
 * Last.fm 2.0 API.
 *
 * Everything hangs off /2.0/?method=<name>. Two behaviors are modeled that
 * clients routinely get wrong:
 *
 *   1. A missing or unknown api_key returns HTTP 403 with error 10 / error 6.
 *      Last.fm does not 401.
 *   2. Errors come back as HTTP 200 in some client libraries' experience and
 *      as 4xx in others. We return the documented status plus the numeric
 *      error envelope, which is the part that is stable.
 *
 * Also relevant to PLAN.md section 1a constraint 2: responses here are the
 * source of the data that must stay under the 100 MB Last.fm cache cap. The
 * similar-artist payload is deliberately fat (image arrays and all) so that a
 * cache-size projection made from a load run is not an underestimate.
 */
export const lastfm = {
  handle(ctx) {
    if (!ctx.pathname.startsWith("/2.0")) {
      return {
        status: 404,
        body: { error: 6, message: "Invalid resource specified" },
      };
    }
    if (!ctx.query.get("api_key")) {
      return { status: 403, body: { error: 10, message: "Invalid API key" } };
    }
    const method = (ctx.query.get("method") ?? "").toLowerCase();

    switch (method) {
      case "artist.getsimilar":
        return similarArtists(
          ctx.query.get("artist") ?? ctx.query.get("mbid") ?? "unknown",
        );
      case "artist.getinfo":
        return artistInfo(
          ctx.query.get("mbid") ?? ctx.query.get("artist") ?? "unknown",
        );
      case "track.getinfo":
        return trackInfo(
          ctx.query.get("mbid") ?? ctx.query.get("track") ?? "unknown",
        );
      case "track.getsimilar":
        return similarTracks(
          ctx.query.get("mbid") ?? ctx.query.get("track") ?? "unknown",
        );
      case "user.gettopartists":
        return topArtists(ctx.query.get("user") ?? "loadtest");
      case "auth.getsession":
        return {
          status: 200,
          body: {
            session: {
              name: "loadtest",
              key: `mock-session-${fnv1a(ctx.query.get("token") ?? "t").toString(16)}`,
              subscriber: 0,
            },
          },
        };
      default:
        return {
          status: 400,
          body: {
            error: 3,
            message:
              "Invalid Method - No method with that name in this package",
          },
        };
    }
  },
};

function images(seed) {
  // The real API returns five sizes per artist. Kept in full because dropping
  // them makes cached payloads look ~40% smaller than they are, and the 100 MB
  // Last.fm cap is measured on what we actually store.
  return ["small", "medium", "large", "extralarge", "mega"].map((size) => ({
    "#text": `https://lastfm.freetls.fastly.net/i/u/${size}/${seed}.png`,
    size,
  }));
}

function similarArtists(ref) {
  const rnd = mulberry32(fnv1a(`lfm-sim:${ref}`));
  const artist = [];
  for (let i = 0; i < 30; i++) {
    const a = artistFor(artistMbid(Math.floor(rnd() * 2_000_000)));
    artist.push({
      name: a.name,
      mbid: a.mbid,
      match: Number((1 - i * 0.03).toFixed(6)),
      url: `https://www.last.fm/music/${encodeURIComponent(a.name)}`,
      image: images(fnv1a(a.mbid).toString(16)),
      streamable: "0",
    });
  }
  return {
    status: 200,
    body: { similarartists: { artist, "@attr": { artist: ref } } },
  };
}

function artistInfo(ref) {
  const a = artistFor(
    /^[0-9a-f-]{36}$/.test(ref) ? ref : artistMbid(fnv1a(ref) % 2_000_000),
  );
  return {
    status: 200,
    body: {
      artist: {
        name: a.name,
        mbid: a.mbid,
        url: `https://www.last.fm/music/${encodeURIComponent(a.name)}`,
        image: images(fnv1a(a.mbid).toString(16)),
        stats: {
          listeners: String(a.listeners),
          playcount: String(a.listeners * 34),
        },
        tags: {
          tag: [
            {
              name: a.genre,
              url: `https://www.last.fm/tag/${encodeURIComponent(a.genre)}`,
            },
          ],
        },
        bio: {
          summary: `${a.name} is a ${a.genre} act formed in ${a.beganYear}. <a href="https://www.last.fm/music/${encodeURIComponent(a.name)}">Read more on Last.fm</a>.`,
          published: "01 Jan 2020, 00:00",
        },
      },
    },
  };
}

function trackInfo(ref) {
  const r = recordingFor(
    /^[0-9a-f-]{36}$/.test(ref) ? ref : recordingMbid(fnv1a(ref) % 2_000_000),
  );
  return {
    status: 200,
    body: {
      track: {
        name: r.title,
        mbid: r.mbid,
        url: `https://www.last.fm/music/${encodeURIComponent(r.artist.name)}/_/${encodeURIComponent(r.title)}`,
        duration: String(r.lengthMs),
        listeners: String(r.artist.listeners),
        playcount: String(r.artist.listeners * 12),
        artist: {
          name: r.artist.name,
          mbid: r.artist.mbid,
          url: `https://www.last.fm/music/${encodeURIComponent(r.artist.name)}`,
        },
        album: {
          title: r.releaseTitle,
          image: images(fnv1a(r.releaseMbid).toString(16)),
        },
        toptags: { tag: [{ name: r.artist.genre }] },
      },
    },
  };
}

function similarTracks(ref) {
  const rnd = mulberry32(fnv1a(`lfm-simtrack:${ref}`));
  const track = [];
  for (let i = 0; i < 20; i++) {
    const r = recordingFor(recordingMbid(Math.floor(rnd() * 2_000_000)));
    track.push({
      name: r.title,
      mbid: r.mbid,
      match: Number((1 - i * 0.04).toFixed(6)),
      duration: Math.round(r.lengthMs / 1000),
      artist: { name: r.artist.name, mbid: r.artist.mbid },
      image: images(fnv1a(r.mbid).toString(16)),
    });
  }
  return {
    status: 200,
    body: { similartracks: { track, "@attr": { artist: ref } } },
  };
}

function topArtists(user) {
  const rnd = mulberry32(fnv1a(`lfm-top:${user}`));
  const artist = [];
  for (let i = 0; i < 50; i++) {
    const a = artistFor(artistMbid(Math.floor(rnd() * 2_000_000)));
    artist.push({
      name: a.name,
      mbid: a.mbid,
      playcount: String(900 - i * 15),
      "@attr": { rank: String(i + 1) },
      image: images(fnv1a(a.mbid).toString(16)),
    });
  }
  return {
    status: 200,
    body: {
      topartists: {
        artist,
        "@attr": {
          user,
          page: "1",
          perPage: "50",
          totalPages: "8",
          total: "400",
        },
      },
    },
  };
}
