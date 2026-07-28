import {
  artistFor,
  recordingFor,
  recordingMbid,
  artistMbid,
  fnv1a,
} from "../../lib/catalog.js";

/**
 * MusicBrainz web service (ws/2), JSON output.
 *
 * Shapes follow the real service closely enough that a client written against
 * the mock parses the real thing: hyphenated keys ("artist-credit",
 * "sort-name"), length in milliseconds, "count"/"offset" on search results.
 * Those hyphenated keys are the usual place a hand-rolled fixture diverges,
 * and the divergence only shows up against production.
 */
export const musicbrainz = {
  handle(ctx) {
    const p = ctx.pathname;

    // /ws/2/<entity>?query=... is search, /ws/2/<entity>/<mbid> is lookup.
    const lookup =
      /^\/ws\/2\/(recording|artist|release|release-group)\/([0-9a-f-]{36})$/.exec(
        p,
      );
    if (lookup) return lookupResponse(lookup[1], lookup[2]);

    const search = /^\/ws\/2\/(recording|artist|release)\/?$/.exec(p);
    if (search && ctx.query.has("query")) {
      return searchResponse(
        search[1],
        ctx.query.get("query"),
        Number(ctx.query.get("limit") ?? 25),
      );
    }

    return {
      status: 404,
      contentType: "application/json; charset=utf-8",
      body: { error: "Not Found" },
    };
  },
};

function lookupResponse(entity, mbid) {
  if (entity === "artist") {
    const a = artistFor(mbid);
    return {
      status: 200,
      body: {
        id: a.mbid,
        name: a.name,
        "sort-name": a.sortName,
        type: "Group",
        country: a.country,
        "life-span": { begin: String(a.beganYear), ended: false },
        tags: [{ name: a.genre, count: 12 }],
      },
    };
  }
  const r = recordingFor(mbid);
  return {
    status: 200,
    body: {
      id: r.mbid,
      title: r.title,
      length: r.lengthMs,
      video: false,
      "artist-credit": [
        {
          name: r.artist.name,
          joinphrase: "",
          artist: {
            id: r.artist.mbid,
            name: r.artist.name,
            "sort-name": r.artist.sortName,
          },
        },
      ],
      releases: [
        {
          id: r.releaseMbid,
          title: r.releaseTitle,
          date: `${r.year}-06-01`,
          country: r.artist.country,
          status: "Official",
        },
      ],
      isrcs: [`US${String(fnv1a(mbid) % 1000).padStart(3, "0")}${r.year}00001`],
    },
  };
}

function searchResponse(entity, query, limit) {
  const n = Math.min(Math.max(limit, 1), 25);
  const seed = fnv1a(`${entity}:${query}`);
  const items = [];
  for (let i = 0; i < n; i++) {
    const idx = (seed + i * 7919) % 2_000_000;
    if (entity === "artist") {
      const a = artistFor(artistMbid(idx));
      items.push({
        id: a.mbid,
        score: 100 - i * 2,
        name: a.name,
        "sort-name": a.sortName,
        country: a.country,
      });
    } else {
      const r = recordingFor(recordingMbid(idx));
      items.push({
        id: r.mbid,
        score: 100 - i * 2,
        title: r.title,
        length: r.lengthMs,
        "artist-credit": [
          {
            name: r.artist.name,
            artist: { id: r.artist.mbid, name: r.artist.name },
          },
        ],
      });
    }
  }
  const key =
    entity === "artist"
      ? "artists"
      : entity === "release"
        ? "releases"
        : "recordings";
  return {
    status: 200,
    body: {
      created: new Date().toISOString(),
      count: 1000,
      offset: 0,
      [key]: items,
    },
  };
}
