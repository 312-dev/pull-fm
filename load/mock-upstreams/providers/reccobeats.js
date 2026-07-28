import {
  recordingFor,
  recordingMbid,
  uuidFrom,
  fnv1a,
  mulberry32,
} from "../../lib/catalog.js";

/**
 * ReccoBeats.
 *
 * The two-call sequence from docs/UPSTREAM-TERMS.md is modeled faithfully
 * because it is the part that breaks integrations:
 *
 *   GET /v1/track?ids=<spotify_id>          -> ReccoBeats UUID
 *   GET /v1/track/<uuid>/audio-features     -> features, keyed on THAT uuid
 *
 * Passing a Spotify id straight to the second call returns 404, exactly as the
 * real service does. A mock that accepted either id would let a broken
 * two-hop resolver pass the gate and then 404 on every real request.
 *
 * PLAN.md section 1 requires this provider to be cache-behind and never on the
 * hot path, so the honest expectation for a warm steady-state run is a very low
 * request count here. The stats endpoint makes that checkable.
 */
export const reccobeats = {
  handle(ctx) {
    if (ctx.pathname === "/v1/track") {
      const ids = (ctx.query.get("ids") ?? "").split(",").filter(Boolean);
      if (ids.length === 0)
        return { status: 400, body: { message: "ids is required" } };
      return {
        status: 200,
        body: {
          content: ids.slice(0, 40).map((spotifyId) => {
            const r = recordingFor(
              recordingMbid(fnv1a(`rb:${spotifyId}`) % 2_000_000),
            );
            return {
              id: uuidFrom(fnv1a(`rb-uuid:${spotifyId}`)),
              trackTitle: r.title,
              durationMs: r.lengthMs,
              isrc: null,
              ean: null,
              upc: null,
              href: `https://open.spotify.com/track/${spotifyId}`,
              popularity: 40 + (fnv1a(spotifyId) % 55),
              availableCountries: "US,GB,DE",
              artists: [
                {
                  id: uuidFrom(fnv1a(`rb-artist:${r.artist.mbid}`)),
                  name: r.artist.name,
                },
              ],
            };
          }),
        },
      };
    }

    const feat = /^\/v1\/track\/([0-9a-f-]{36})\/audio-features$/.exec(
      ctx.pathname,
    );
    if (feat) {
      const rnd = mulberry32(fnv1a(`rb-feat:${feat[1]}`));
      return {
        status: 200,
        // Exactly Spotify's deprecated audio-features schema, which is what
        // ReccoBeats returns and what our features table is keyed on.
        body: {
          id: feat[1],
          acousticness: round3(rnd()),
          danceability: round3(rnd()),
          energy: round3(rnd()),
          instrumentalness: round3(rnd()),
          liveness: round3(rnd()),
          loudness: round3(-20 + rnd() * 18),
          speechiness: round3(rnd() * 0.5),
          tempo: Math.round(60 + rnd() * 120),
          valence: round3(rnd()),
        },
      };
    }

    // A Spotify id in the features slot: the real API 404s here. Reproduced so
    // the two-hop bug cannot pass silently.
    if (/^\/v1\/track\/[^/]+\/audio-features$/.test(ctx.pathname)) {
      return { status: 404, body: { message: "Track not found" } };
    }

    return { status: 404, body: { message: "Not found" } };
  },
};

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
