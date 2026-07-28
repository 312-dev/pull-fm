import {
  recordingFor,
  recordingMbid,
  fnv1a,
  mulberry32,
} from "../../lib/catalog.js";

/**
 * iTunes Search API.
 *
 * Two properties matter and both are modeled:
 *
 *   1. Preview URLs are UNSIGNED and do not expire (verified in
 *      docs/UPSTREAM-TERMS.md L2). So iTunes preview URLs are cacheable, and
 *      the mock's iTunes CDN path accepts any request forever. The contrast
 *      with Deezer is the point: the same BFF code path must treat the two
 *      differently, and only a mock that behaves differently can prove it does.
 *   2. The quota is ~20 calls/minute per IP. Enforced by the server's rate
 *      limiter, not here.
 *
 * Apple's terms also forbid caching the preview AUDIO (only the URL may be
 * stored). The mock cannot enforce a licence, but it does count CDN hits, so a
 * run that downloads every preview once and never again is visible in the
 * stats as a suspiciously low CDN count.
 */
export const itunes = {
  handle(ctx) {
    if (ctx.pathname === "/search") return search(ctx);
    if (ctx.pathname === "/lookup") return lookup(ctx);
    // /cdn/preview/<id>.m4a is handled here but bypasses quota (see server.js:
    // paths under /cdn/ are treated as edge traffic, not API traffic).
    if (ctx.pathname.startsWith("/cdn/preview/")) {
      ctx.stats.bump("previewOk");
      return {
        status: 200,
        contentType: "audio/x-m4a",
        headers: {
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=86400",
        },
        // A token payload rather than real audio. Byte-accurate audio would
        // make the load generator's network the bottleneck instead of the BFF.
        body: "MOCK_M4A_PREVIEW_PAYLOAD",
      };
    }
    return {
      status: 404,
      contentType: "text/plain; charset=utf-8",
      body: "Not Found",
    };
  },
};

function trackResult(r) {
  return {
    wrapperType: "track",
    kind: "song",
    artistId: 100000 + (fnv1a(r.artist.mbid) % 900000),
    collectionId: 200000 + (fnv1a(r.releaseMbid) % 900000),
    trackId: r.itunesTrackId,
    artistName: r.artist.name,
    collectionName: r.releaseTitle,
    trackName: r.title,
    collectionCensoredName: r.releaseTitle,
    trackCensoredName: r.title,
    artistViewUrl: `https://music.apple.com/us/artist/${fnv1a(r.artist.mbid) % 900000}`,
    trackViewUrl: `https://music.apple.com/us/album/${r.itunesTrackId}`,
    // Unsigned, no expiry, hotlinkable. Deliberately different from Deezer.
    previewUrl: `${r.previewBase}/itunes/cdn/preview/${r.itunesTrackId}.m4a`,
    artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/${fnv1a(r.mbid) % 999999}/100x100bb.jpg`,
    releaseDate: `${r.year}-06-01T07:00:00Z`,
    trackTimeMillis: r.lengthMs,
    country: "USA",
    currency: "USD",
    primaryGenreName: r.artist.genre,
    isStreamable: true,
  };
}

function search(ctx) {
  const term = ctx.query.get("term") ?? "";
  const limit = Math.min(
    Math.max(Number(ctx.query.get("limit") ?? 25), 1),
    200,
  );
  const rnd = mulberry32(fnv1a(`itunes:${term}`));
  const results = [];
  for (let i = 0; i < limit; i++) {
    const r = recordingFor(recordingMbid(Math.floor(rnd() * 2_000_000)));
    r.previewBase = ctx.publicBase;
    results.push(trackResult(r));
  }
  return { status: 200, body: { resultCount: results.length, results } };
}

function lookup(ctx) {
  const id = ctx.query.get("id") ?? "";
  // The crosswalk direction that matters: given an iTunes id we already
  // resolved, hand back the same track every time.
  const r = recordingFor(recordingMbid(fnv1a(`itunes-id:${id}`) % 2_000_000));
  r.itunesTrackId = Number(id) || r.itunesTrackId;
  r.previewBase = ctx.publicBase;
  return { status: 200, body: { resultCount: 1, results: [trackResult(r)] } };
}
