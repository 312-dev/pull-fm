import {
  recordingFor,
  recordingMbid,
  fnv1a,
  mulberry32,
} from "../../lib/catalog.js";
import { signPreviewUrl, verifyPreviewUrl } from "../lib/sign.js";

/**
 * Deezer API.
 *
 * THE POINT OF THIS PROVIDER
 * --------------------------
 * Deezer preview URLs are signed and expire (docs/UPSTREAM-TERMS.md L3), which
 * PLAN.md section 1a turns into a hard rule: never store a Deezer preview URL.
 * The mock enforces that rule mechanically. Every /track response carries a
 * freshly signed URL valid for previewTtlSeconds, and the CDN path verifies the
 * signature and the expiry for real.
 *
 * Consequences a load run will surface that a naive mock would hide:
 *   - a BFF that caches the resolved URL starts serving 403s once the TTL
 *     lapses, counted here as deezer.extra.previewExpired
 *   - a BFF that rewrites or truncates the token fails signature verification,
 *     counted as previewForged, which is a different bug with a different fix
 *
 * Deezer also answers HTTP 200 with an error object on quota exhaustion. That
 * is handled centrally in lib/respond.js because it applies to every route.
 */
export const deezer = {
  handle(ctx) {
    const p = ctx.pathname;

    const cdn = /^\/cdn\/preview\/(\d+)\.mp3$/.exec(p);
    if (cdn) return servePreview(ctx, cdn[1]);

    const track = /^\/track\/(\d+)$/.exec(p);
    if (track) return { status: 200, body: trackObject(ctx, Number(track[1])) };

    if (p === "/search" || p === "/search/track") {
      const q = ctx.query.get("q") ?? "";
      const rnd = mulberry32(fnv1a(`dz:${q}`));
      const data = [];
      for (let i = 0; i < 25; i++) {
        data.push(
          trackObject(ctx, 1_000_000 + Math.floor(rnd() * 900_000_000)),
        );
      }
      return {
        status: 200,
        body: {
          data,
          total: 300,
          next: `https://api.deezer.com/search?q=${encodeURIComponent(q)}&index=25`,
        },
      };
    }

    const artist = /^\/artist\/(\d+)$/.exec(p);
    if (artist) {
      const r = recordingFor(
        recordingMbid(fnv1a(`dz-artist:${artist[1]}`) % 2_000_000),
      );
      return {
        status: 200,
        body: {
          id: Number(artist[1]),
          name: r.artist.name,
          nb_album: 6,
          nb_fan: r.artist.listeners,
          picture_medium: `https://e-cdns-images.dzcdn.net/images/artist/${fnv1a(r.artist.mbid).toString(16)}/250x250-000000-80-0-0.jpg`,
          type: "artist",
        },
      };
    }

    // Deezer returns 200 with an error envelope for unknown resources too.
    return {
      status: 200,
      body: { error: { type: "DataException", message: "no data", code: 800 } },
    };
  },
};

function trackObject(ctx, id) {
  const r = recordingFor(recordingMbid(fnv1a(`dz-track:${id}`) % 2_000_000));
  const path = `/deezer/cdn/preview/${id}.mp3`;
  const token = signPreviewUrl({
    key: ctx.signingKey,
    path,
    ttlSeconds: ctx.previewTtlSeconds,
  });
  return {
    id,
    readable: true,
    title: r.title,
    title_short: r.title,
    duration: Math.round(r.lengthMs / 1000),
    rank: 500000,
    explicit_lyrics: false,
    // Signed and expiring. Storing this value anywhere is the bug we are
    // hunting for.
    preview: `${ctx.publicBase}${path}?${token}`,
    md5_image: fnv1a(r.mbid).toString(16),
    artist: {
      id: 1000 + (fnv1a(r.artist.mbid) % 900000),
      name: r.artist.name,
      type: "artist",
    },
    album: {
      id: 2000 + (fnv1a(r.releaseMbid) % 900000),
      title: r.releaseTitle,
      cover_medium: `https://e-cdns-images.dzcdn.net/images/cover/${fnv1a(r.releaseMbid).toString(16)}/250x250-000000-80-0-0.jpg`,
      type: "album",
    },
    type: "track",
  };
}

function servePreview(ctx, id) {
  const path = `/deezer/cdn/preview/${id}.mp3`;
  const result = verifyPreviewUrl({
    key: ctx.signingKey,
    path,
    token: ctx.query.get("hdnea"),
  });

  if (result.valid) {
    ctx.stats.bump("previewOk");
    return {
      status: 200,
      contentType: "audio/mpeg",
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
      },
      body: "MOCK_MP3_PREVIEW_PAYLOAD",
    };
  }

  ctx.stats.bump(
    result.reason === "expired"
      ? "previewExpired"
      : result.reason === "missing"
        ? "previewMissingToken"
        : "previewForged",
  );
  return {
    status: 403,
    contentType: "text/xml",
    headers: { "x-pullfm-mock-reason": result.reason },
    body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access denied</Message></Error>',
  };
}
