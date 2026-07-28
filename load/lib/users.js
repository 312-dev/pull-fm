/**
 * Synthetic users and content selection.
 *
 * Two modeling decisions live here and both change the numbers materially.
 *
 * 1. WHICH USER a session belongs to. Sessions are spread across the daily
 *    active population, not across all registered users, because a warm cache
 *    is warmed by the people who actually show up. Modeling 10,000 distinct
 *    users per run would understate per-user cache locality and overstate
 *    upstream pressure.
 *
 * 2. WHICH TRACKS get requested. Music consumption is extreme power law: a few
 *    thousand recordings account for most plays. Sampling uniformly across a
 *    two million row catalog would drive the cache hit rate toward zero no
 *    matter how correct the cache is, and the ">90% warm hit" gate would be
 *    unreachable by construction. HOT_SET_SHARE of requests come from a head
 *    of HOT_SET_SIZE recordings; the rest come from the tail.
 */
import exec from "k6/execution";

import { CONFIG } from "./config.js";
import {
  CATALOG_SIZE,
  recordingMbid,
  artistMbid,
  searchTerm,
  mulberry32,
  fnv1a,
} from "./catalog.js";

/** Share of registered users active on a given day. PLAN.md section 3 works
 *  from 2,000 DAU against the 10,000 user target, so 20%. */
const DAU_SHARE = Number(__ENV.DAU_SHARE ?? 0.2);

const activeUserCount = Math.max(1, Math.round(CONFIG.userPool * DAU_SHARE));

/**
 * The user this iteration acts as.
 *
 * Derived from the global iteration counter rather than the VU id, so that a
 * run with 250 VUs still exercises thousands of distinct subjects. The
 * multiplication by a large odd constant scrambles the order: consecutive
 * iterations landing on adjacent user ids would create cache locality that no
 * real traffic has.
 */
export function currentUser() {
  const iter = exec.scenario.iterationInTest;
  const index = Math.abs((iter * 2654435761) % activeUserCount);
  return userAt(index);
}

export function userAt(index) {
  const rnd = mulberry32(fnv1a(`user:${index}`));
  return {
    index,
    // Shaped like the WorkOS subject the real BFF will see.
    id: `user_loadtest_${String(index).padStart(6, "0")}`,
    listenBrainzName: `lt_user_${index}`,
    /** Seeded per user so the same user browses the same neighbourhood of the
     *  catalog across sessions, which is what makes a per-user cache useful. */
    rnd,
    /** Wishlist ids created during this session, so a DELETE targets something
     *  that exists. Session scoped by design: cross-session state would need
     *  coordination k6 does not have. */
    createdWishlistIds: [],
  };
}

/**
 * Pick a catalog index with a realistic popularity distribution.
 * COLD_OFFSET shifts the whole window into unresolved territory for the
 * cold-cache scenario.
 */
export function pickTrackIndex(rnd = Math.random) {
  const hot = rnd() < CONFIG.hotSetShare;
  // The tail is drawn from tailSetSize, not from the whole catalog. In a warm
  // scenario that models a permanent crosswalk that has already seen this
  // material; cold-cache raises tailSetSize to CATALOG_SIZE so nothing repeats.
  const tailSpan = Math.max(
    1,
    Math.min(CONFIG.tailSetSize, CATALOG_SIZE) - CONFIG.hotSetSize,
  );
  const raw = hot
    ? Math.floor(rnd() * CONFIG.hotSetSize)
    : CONFIG.hotSetSize + Math.floor(rnd() * tailSpan);
  return (raw + CONFIG.coldOffset) % CATALOG_SIZE;
}

export function pickRecordingMbid(rnd = Math.random) {
  return recordingMbid(pickTrackIndex(rnd));
}

export function pickArtistMbid(rnd = Math.random) {
  return artistMbid(pickTrackIndex(rnd));
}

export function pickSearchTerm(rnd = Math.random) {
  // Search queries are head-heavy too, and a search cache is only worth having
  // if the same handful of terms recur.
  const hot = rnd() < CONFIG.hotSetShare;
  const i = hot ? Math.floor(rnd() * 500) : Math.floor(rnd() * 50_000);
  return searchTerm(i + CONFIG.coldOffset);
}

/**
 * Human pacing.
 *
 * Log-normal-ish rather than uniform: most gaps are short, a few are long
 * because the user got distracted. Uniform think time produces an unnaturally
 * regular arrival pattern that is easier on a server than real traffic.
 *
 * @param {number} medianSeconds
 */
export function thinkTime(medianSeconds, rnd = Math.random) {
  if (CONFIG.thinkScale === 0) return 0;
  const u = rnd();
  // Rough inverse-CDF for a right-skewed distribution: median at 1x, p95 near
  // 3x, occasional 6x outlier.
  const factor = u < 0.5 ? 0.4 + u * 1.2 : 1 + (u - 0.5) * 6;
  return medianSeconds * factor * CONFIG.thinkScale;
}
