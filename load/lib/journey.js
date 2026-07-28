/**
 * The user journey: one iteration of any scenario is one full session.
 *
 * TRAFFIC MODEL (PLAN.md section 3, restated as code)
 * --------------------------------------------------
 *   10,000 registered users, 2,000 DAU, ~1.5 sessions/day  ->  ~3,000 sessions/day
 *   per session: 1 config fetch, 1 feed load, ~15 preview resolves,
 *                a couple of artist views, a search or two, a few wishlist ops
 *
 * The mix below is expressed as weights rather than a fixed script so the shape
 * can be retuned from the environment when real usage data exists, without
 * touching any scenario. Weights are drawn WITH replacement
 * ACTIONS_PER_SESSION times, so the expected composition of a session is the
 * weight vector scaled to that count.
 *
 * Why a session-shaped iteration rather than a flat endpoint mix: a flat mix
 * gets the request ratios right and the CONCURRENCY wrong. Real load arrives as
 * bursts of correlated requests from one user against one cache key space, and
 * that is what fills connection pools.
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

/** Expected actions per session, from the plan's model. Override with
 *  MIX='{"preview":10,"search":4}' to reshape without editing this file. */
const DEFAULT_MIX = {
  preview: 15,
  artist: 2,
  search: 1.5,
  wishlist_read: 1,
  wishlist_add: 0.6,
  wishlist_delete: 0.15,
};

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
  // maintenance state. It is on the critical path of every cold start.
  // Not counted toward the cache gate: /v1/config is a static document served
  // from memory, so including it would inflate the hit rate with a trivial win.
  const config = apiRequest("GET", "/v1/config", {
    endpoint: "config",
    user,
    phase,
  });
  check(config, { "config: 200": (r) => r.status === 200 });

  // --- feed ----------------------------------------------------------------
  // Also not counted toward the cache gate. PLAN.md gate 2's "warm cache hit
  // >=90%" is about the MBID-keyed crosswalk (the thing that spends upstream
  // quota), not about per-user feed assembly. A feed is composed for one user
  // at one moment and legitimately misses on almost every session; folding that
  // into the same ratio would make a correct system look broken, and padding
  // the ratio with /v1/config would hide it again. The gate is measured on the
  // three crosswalk-backed reads below: preview, artist, search.
  const feed = apiRequest("GET", "/v1/feed", {
    endpoint: "feed",
    user,
    phase,
  });
  const feedItems = inspectFeed(feed);

  sleep(thinkTime(4, rnd));

  // --- browse --------------------------------------------------------------
  for (let i = 0; i < CONFIG.actionsPerSession; i++) {
    const action = pickAction(rnd);
    switch (action) {
      case "preview":
        resolvePreview(user, rnd, feedItems, phase);
        // A preview is 30 seconds long and users skip early and often. This is
        // the dominant think time in the whole model.
        sleep(thinkTime(3, rnd));
        break;

      case "artist": {
        const mbid = pickArtistMbid(rnd);
        const res = apiRequest("GET", `/v1/artists/${mbid}`, {
          endpoint: "artist",
          user,
          cacheable: true,
          phase,
        });
        check(res, { "artist: 200": (r) => r.status === 200 });
        sleep(thinkTime(6, rnd));
        break;
      }

      case "search": {
        const q = pickSearchTerm(rnd);
        const res = apiRequest("GET", `/v1/search?q=${encodeURIComponent(q)}`, {
          endpoint: "search",
          user,
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
          phase,
        });
        check(res, { "wishlist read: 200": (r) => r.status === 200 });
        sleep(thinkTime(4, rnd));
        break;
      }

      case "wishlist_add": {
        const res = apiRequest("POST", "/v1/wishlist", {
          endpoint: "wishlist_add",
          user,
          body: { mbid: pickRecordingMbid(rnd), source: "loadtest" },
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
    phase,
  });
  check(res, { "preview: 200": (r) => r.status === 200 });

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

  const degraded =
    (Array.isArray(body.degraded) && body.degraded.length > 0) ||
    sections.some((s) => s && s.degraded === true);
  feedDegraded.add(Boolean(degraded));

  const items = [];
  for (const s of sections) {
    for (const item of s.items ?? []) {
      if (item && typeof item.mbid === "string") items.push(item.mbid);
    }
  }
  return items;
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
  actionsPerSession: CONFIG.actionsPerSession,
};
