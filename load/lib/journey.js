/**
 * The user journey: one iteration of any scenario is one full session.
 *
 * TRAFFIC MODEL (PLAN.md section 3, restated as code)
 * --------------------------------------------------
 *   10,000 registered users, 2,000 DAU, ~1.5 sessions/day  ->  ~3,000 sessions/day
 *   per session: 1 config fetch, 1 feed load, then a browse loop
 *
 * The mix is expressed as weights rather than a fixed script so the shape can
 * be retuned from the environment when real usage data exists, without touching
 * any scenario. Weights are drawn WITH replacement `ACTIONS_PER_SESSION` times,
 * so the expected composition of a session is the weight vector scaled to that
 * count.
 *
 * Why a session-shaped iteration rather than a flat endpoint mix: a flat mix
 * gets the request ratios right and the CONCURRENCY wrong. Real load arrives as
 * bursts of correlated requests from one user against one cache key space, and
 * that is what fills connection pools.
 *
 * WHAT CHANGED WHEN THIS MET THE REAL BFF
 * ---------------------------------------
 * The previous mix covered six endpoints and got three of them wrong. It is
 * recorded here rather than quietly fixed, because each error is the kind that
 * produces a confidently green run measuring nothing:
 *
 *   - `/v1/recommendations`, `/v1/stations`, `/v1/stations/:id/tracks`,
 *     `/v1/tracks/:mbid`, `/v1/albums/:mbid` and `/v1/artists/:mbid/similar`
 *     were absent. Half of them are the only routes that reach ListenBrainz,
 *     so the mix exercised almost none of the upstream layer.
 *   - `POST /v1/wishlist` sent `{mbid, source}`. The route requires
 *     `artistName` and `title` and rejects the rest with 400.
 *   - Feed items were read as `item.mbid`. They are `item.recordingMbid`, so
 *     `PREVIEW_SOURCE=feed` selected nothing on every session.
 *   - `body.degraded` was tested with `Array.isArray`. It is a boolean, so
 *     degradation was never once detected.
 */
import { check, sleep } from "k6";

import { CONFIG } from "./config.js";
import { apiRequest, playPreview } from "./http.js";
import {
  feedDegraded,
  feedEmpty,
  sessionsCompleted,
  sessionDuration,
} from "./metrics.js";
import {
  currentUser,
  pickRecordingMbid,
  pickArtistMbid,
  pickSearchTerm,
  thinkTime,
} from "./users.js";

/**
 * Expected actions per session. Override with MIX='{"preview":10,"search":4}'
 * to reshape without editing this file.
 *
 * `credential` records which auth kind `requireAuth` admits for that route.
 * Getting it wrong is not a subtle error: a personal API token on `/v1/search`
 * is a flat 403, so a mix that guessed would report a third of its requests as
 * failures and blame the system.
 */
const ACTIONS = {
  // --- personal API token admitted -----------------------------------------
  recommendations: { weight: 2, credential: "token" },
  stations: { weight: 1, credential: "token" },
  station_tracks: { weight: 1.5, credential: "token" },
  wishlist_read: { weight: 1, credential: "token" },

  // --- session only --------------------------------------------------------
  preview: { weight: 15, credential: "session" },
  artist: { weight: 2, credential: "session" },
  artist_similar: { weight: 1, credential: "session" },
  track: { weight: 1.5, credential: "session" },
  album: { weight: 1, credential: "session" },
  search: { weight: 1.5, credential: "session" },
  wishlist_add: { weight: 0.6, credential: "session" },
  wishlist_delete: { weight: 0.15, credential: "session" },
};

const DEFAULT_MIX = Object.fromEntries(
  Object.entries(ACTIONS).map(([k, v]) => [k, v.weight]),
);

const MIX = (() => {
  const merged = { ...DEFAULT_MIX };
  if (__ENV.MIX) {
    try {
      Object.assign(merged, JSON.parse(__ENV.MIX));
    } catch (e) {
      throw new Error(`MIX is not valid JSON: ${e.message}`);
    }
  }
  const entries = Object.entries(merged).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  // Precompute a cumulative table: picking is then one random number and a
  // short scan, which matters at a few thousand draws per second.
  let acc = 0;
  return entries.map(([name, w]) => {
    acc += w / total;
    return { name, cumulative: acc };
  });
})();

function pickAction(rnd) {
  const u = rnd();
  for (const a of MIX) if (u <= a.cumulative) return a.name;
  return MIX[MIX.length - 1].name;
}

function credentialOf(action) {
  return ACTIONS[action] ? ACTIONS[action].credential : "session";
}

/**
 * One complete session.
 * @param {{phase?: string}} opts phase tag, used by soak and chaos
 */
export function runSession(opts = {}) {
  const phase = opts.phase;
  const user = currentUser();
  const rnd = user.rnd;
  const started = Date.now();

  // --- app launch ----------------------------------------------------------
  // /v1/config is the first call any client makes: min version, feature flags,
  // maintenance state, and the coarse per-provider health map. It is public and
  // on the critical path of every cold start.
  const config = apiRequest("GET", "/v1/config", {
    endpoint: "config",
    user,
    phase,
  });
  check(config, { "config: 200": (r) => r.status === 200 });

  // --- feed ----------------------------------------------------------------
  const feed = apiRequest("GET", "/v1/feed", {
    endpoint: "feed",
    user,
    credential: "token",
    phase,
  });
  const feedItems = inspectFeed(feed);

  sleep(thinkTime(4, rnd));

  // --- browse --------------------------------------------------------------
  for (let i = 0; i < CONFIG.actionsPerSession; i++) {
    const action = pickAction(rnd);
    const credential = credentialOf(action);

    switch (action) {
      case "preview":
        resolvePreview(user, rnd, feedItems, phase);
        // A preview is 30 seconds long and users skip early and often. This is
        // the dominant think time in the whole model.
        sleep(thinkTime(3, rnd));
        break;

      case "recommendations": {
        // A seed makes the cache key vary per user's current interest, which is
        // what a real "more like this" tap does. Without one every request in
        // the run shares a key and the hit rate is a property of the test.
        const seed = pickArtistMbid(rnd);
        const res = apiRequest(
          "GET",
          `/v1/recommendations?seed=${encodeURIComponent(seed)}`,
          { endpoint: "recommendations", user, credential, phase },
        );
        check(res, { "recommendations: 200": (r) => r.status === 200 });
        sleep(thinkTime(5, rnd));
        break;
      }

      case "stations": {
        const res = apiRequest("GET", "/v1/stations", {
          endpoint: "stations",
          user,
          credential,
          phase,
        });
        check(res, { "stations: 200": (r) => r.status === 200 });
        // Station ids are signed and subject-bound, so they cannot be
        // synthesised: a made-up id is a 404 by design. Carry the real ones
        // forward for the station_tracks action.
        user.stationIds = stationIdsOf(res);
        sleep(thinkTime(4, rnd));
        break;
      }

      case "station_tracks": {
        const ids = user.stationIds ?? [];
        if (ids.length === 0) break;
        const id = ids[Math.floor(rnd() * ids.length)];
        const res = apiRequest(
          "GET",
          `/v1/stations/${encodeURIComponent(id)}/tracks`,
          {
            endpoint: "station_tracks",
            user,
            credential,
            cacheable: true,
            phase,
          },
        );
        check(res, { "station tracks: 200": (r) => r.status === 200 });
        sleep(thinkTime(6, rnd));
        break;
      }

      case "artist": {
        const res = apiRequest("GET", `/v1/artists/${pickArtistMbid(rnd)}`, {
          endpoint: "artist",
          user,
          credential,
          cacheable: true,
          // A catalogue route reads the crosswalk and never calls out, so a
          // miss is a 404 by design rather than a failure. Counting it as an
          // error would make a correctly cold system look broken.
          expect: [200, 404],
          phase,
        });
        check(res, {
          "artist: 200 or 404": (r) => r.status === 200 || r.status === 404,
        });
        sleep(thinkTime(6, rnd));
        break;
      }

      case "artist_similar": {
        const res = apiRequest(
          "GET",
          `/v1/artists/${pickArtistMbid(rnd)}/similar`,
          {
            endpoint: "artist_similar",
            user,
            credential,
            cacheable: true,
            expect: [200, 404],
            phase,
          },
        );
        check(res, {
          "similar: 200 or 404": (r) => r.status === 200 || r.status === 404,
        });
        sleep(thinkTime(5, rnd));
        break;
      }

      case "track": {
        const res = apiRequest("GET", `/v1/tracks/${pickRecordingMbid(rnd)}`, {
          endpoint: "track",
          user,
          credential,
          cacheable: true,
          expect: [200, 404],
          phase,
        });
        check(res, {
          "track: 200 or 404": (r) => r.status === 200 || r.status === 404,
        });
        sleep(thinkTime(4, rnd));
        break;
      }

      case "album": {
        const res = apiRequest("GET", `/v1/albums/${pickRecordingMbid(rnd)}`, {
          endpoint: "album",
          user,
          credential,
          cacheable: true,
          expect: [200, 404],
          phase,
        });
        check(res, {
          "album: 200 or 404": (r) => r.status === 200 || r.status === 404,
        });
        sleep(thinkTime(6, rnd));
        break;
      }

      case "search": {
        const q = pickSearchTerm(rnd);
        const res = apiRequest("GET", `/v1/search?q=${encodeURIComponent(q)}`, {
          endpoint: "search",
          user,
          credential,
          cacheable: true,
          phase,
        });
        check(res, { "search: 200": (r) => r.status === 200 });
        sleep(thinkTime(5, rnd));
        break;
      }

      case "wishlist_read": {
        const res = apiRequest("GET", "/v1/wishlist", {
          endpoint: "wishlist_read",
          user,
          credential,
          phase,
        });
        check(res, { "wishlist read: 200": (r) => r.status === 200 });
        sleep(thinkTime(4, rnd));
        break;
      }

      case "wishlist_add": {
        const n = Math.floor(rnd() * 100000);
        const res = apiRequest("POST", "/v1/wishlist", {
          endpoint: "wishlist_add",
          user,
          credential,
          // The real schema: artistName and title are required, the mbids are
          // optional and must be canonical UUIDs when present.
          body: {
            artistName: `Load Artist ${n % 5000}`,
            title: `Load Title ${n}`,
            recordingMbid: pickRecordingMbid(rnd),
            source: "recommendation",
          },
          expect: [200, 201],
          phase,
        });
        check(res, {
          "wishlist add: 200 or 201": (r) =>
            r.status === 200 || r.status === 201,
        });
        const id = idOf(res);
        if (id) user.createdWishlistIds.push(id);
        sleep(thinkTime(2, rnd));
        break;
      }

      case "wishlist_delete": {
        // Only ever deletes something this session created. Deleting a random
        // id would generate 404s that are correct behavior but would pollute
        // the error rate the gate is measured on.
        const id = user.createdWishlistIds.pop();
        if (!id) break;
        const res = apiRequest("DELETE", `/v1/wishlist/${id}`, {
          endpoint: "wishlist_delete",
          user,
          credential,
          expect: [200, 204],
          phase,
        });
        check(res, {
          "wishlist delete: 204": (r) => r.status === 204 || r.status === 200,
        });
        sleep(thinkTime(2, rnd));
        break;
      }

      default:
        break;
    }
  }

  sessionsCompleted.add(1);
  sessionDuration.add(Date.now() - started);
}

function resolvePreview(user, rnd, feedItems, phase) {
  const mbid =
    CONFIG.previewSource === "feed" && feedItems.length > 0
      ? feedItems[Math.floor(rnd() * feedItems.length)]
      : pickRecordingMbid(rnd);

  const res = apiRequest("GET", `/v1/tracks/${mbid}/preview`, {
    endpoint: "track_preview",
    user,
    cacheable: true,
    // The preview route reads `track_previews`, which a background job fills.
    // An unfilled row is a 404 and is the documented behaviour, not an outage:
    // resolving inline would put iTunes' ~20 calls/minute on the request path.
    expect: [200, 404],
    phase,
  });
  check(res, {
    "preview: 200 or 404": (r) => r.status === 200 || r.status === 404,
  });

  if (CONFIG.verifyPreviewUrl && res.status === 200) {
    const url = jsonField(res, "previewUrl");
    if (url) playPreview(url, user);
  }
}

function inspectFeed(res) {
  const ok = check(res, { "feed: 200": (r) => r.status === 200 });
  if (!ok || res.status !== 200) {
    feedDegraded.add(true);
    return [];
  }
  let body;
  try {
    body = res.json();
  } catch {
    feedEmpty.add(1);
    feedDegraded.add(true);
    return [];
  }
  const sections = body && body.sections ? body.sections : [];
  check(res, {
    // Gate 7 wants 200 WITH sections. An empty 200 passes an availability probe
    // while serving nothing, which is the failure this check exists to catch.
    "feed: has at least one section": () => sections.length > 0,
  });
  if (sections.length === 0) feedEmpty.add(1);

  // `degraded` is a boolean and `unavailableProviders` is the list. The
  // previous revision tested `Array.isArray(body.degraded)`, which is false for
  // a boolean, so a fully degraded feed was recorded as healthy on every
  // single request of every run.
  feedDegraded.add(body.degraded === true);

  const items = [];
  for (const s of sections) {
    for (const item of s.items ?? []) {
      // Feed items key on `recordingMbid`. `item.mbid` does not exist.
      if (item && typeof item.recordingMbid === "string") {
        items.push(item.recordingMbid);
      }
    }
  }
  return items;
}

function stationIdsOf(res) {
  if (res.status !== 200) return [];
  let body;
  try {
    body = res.json();
  } catch {
    return [];
  }
  const ids = [];
  for (const s of body?.sections ?? []) {
    if (s && typeof s.id === "string") ids.push(s.id);
    for (const item of s?.items ?? []) {
      if (item && typeof item.stationId === "string") ids.push(item.stationId);
    }
  }
  return ids;
}

function jsonField(res, field) {
  try {
    const b = res.json();
    return b ? b[field] : null;
  } catch {
    return null;
  }
}

function idOf(res) {
  const v = jsonField(res, "id");
  return typeof v === "string" ? v : null;
}

export const TRAFFIC_MODEL = {
  mix: DEFAULT_MIX,
  credentials: Object.fromEntries(
    Object.entries(ACTIONS).map(([k, v]) => [k, v.credential]),
  ),
  actionsPerSession: CONFIG.actionsPerSession,
};
