/**
 * Deterministic synthetic music catalog.
 *
 * This module is imported by BOTH sides of the load harness:
 *   - the k6 scenarios, which pick MBIDs to request from the BFF
 *   - the mock upstream server, which must answer for whatever MBID it is given
 *
 * Neither side ships a fixture file and neither side needs to agree on one:
 * every fact is derived from a hash of the identifier itself, so the same MBID
 * always produces the same artist, title and duration in both processes and
 * across runs. That property is what makes cache-correctness assertions
 * meaningful. If the mock returned random data, a stale-cache bug and a fresh
 * fetch would be indistinguishable.
 *
 * Constraints: pure ES module, no Node builtins, no k6 builtins. It has to load
 * unchanged in the k6 JS runtime and in Node 22.
 */

/** Size of the synthetic universe. Larger than any single run will touch, so
 *  cold-cache runs can carve out an untouched slice (see COLD_OFFSET). */
export const CATALOG_SIZE = 2_000_000;

/** FNV-1a, 32 bit. Chosen because it is 6 lines, dependency free and stable
 *  across JS engines. Not a security primitive and never used as one here. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, seedable PRNG with adequate distribution. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(n, width) {
  return n.toString(16).padStart(width, "0").slice(-width);
}

/** Build a v4-shaped UUID from a seed. Shaped like a real MBID (version nibble
 *  4, variant bits 10) so anything validating the format accepts it. */
export function uuidFrom(seed) {
  const rnd = mulberry32(seed);
  const w = [];
  for (let i = 0; i < 4; i++) w.push(Math.floor(rnd() * 0xffffffff) >>> 0);
  const a = hex(w[0], 8);
  const b = hex(w[1] >>> 16, 4);
  const c = `4${hex(w[1] & 0x0fff, 3)}`;
  const d = hex((0x8000 | (w[2] >>> 18)) & 0xffff, 4);
  const e = hex(w[2] & 0xffff, 4) + hex(w[3], 8);
  return `${a}-${b}-${c}-${d}-${e}`;
}

export const recordingMbid = (i) => uuidFrom(fnv1a(`recording:${i}`));
export const artistMbid = (i) => uuidFrom(fnv1a(`artist:${i}`));
export const releaseMbid = (i) => uuidFrom(fnv1a(`release:${i}`));

const ADJECTIVES = [
  "Velvet",
  "Hollow",
  "Golden",
  "Quiet",
  "Electric",
  "Northern",
  "Slow",
  "Broken",
  "Midnight",
  "Paper",
  "Crimson",
  "Distant",
  "Silver",
  "Wild",
  "Patient",
  "Neon",
];
const NOUNS = [
  "Harbour",
  "Machine",
  "Cassette",
  "Orchard",
  "Signal",
  "Lantern",
  "Hotel",
  "Rivers",
  "Circuit",
  "Meridian",
  "Static",
  "Chapel",
  "Foxes",
  "Atlas",
  "Tide",
];
const SUFFIXES = [
  "",
  " Club",
  " Society",
  " Trio",
  " Collective",
  " Band",
  " Ensemble",
];
const TITLE_HEADS = [
  "Falling",
  "Coming Home",
  "Long Way",
  "Blue Hour",
  "Everything Nice",
  "No Reply",
  "Cold Open",
  "Second Language",
  "Paper Weight",
  "Half Light",
  "Slow Burn",
  "Radio Silence",
];
const TITLE_TAILS = [
  "",
  " (Reprise)",
  " - Live",
  " (Demo)",
  " II",
  " (Remastered)",
];
const COUNTRIES = ["US", "GB", "DE", "SE", "CA", "AU", "JP", "FR"];
const GENRES = [
  "indie rock",
  "ambient",
  "post-punk",
  "soul",
  "techno",
  "folk",
  "jazz",
  "shoegaze",
];
const LABELS = [
  "Merge",
  "Warp",
  "Sub Pop",
  "4AD",
  "Domino",
  "Ninja Tune",
  "Numero Group",
];

function pick(list, rnd) {
  return list[Math.floor(rnd() * list.length) % list.length];
}

/** Stable artist facts for any MBID-shaped string. */
export function artistFor(mbid) {
  const rnd = mulberry32(fnv1a(`a:${mbid}`));
  const name = `${pick(ADJECTIVES, rnd)} ${pick(NOUNS, rnd)}${pick(SUFFIXES, rnd)}`;
  return {
    mbid,
    name,
    sortName: name,
    country: pick(COUNTRIES, rnd),
    genre: pick(GENRES, rnd),
    beganYear: 1968 + Math.floor(rnd() * 55),
    listeners: 500 + Math.floor(rnd() * 900_000),
  };
}

/** Stable recording facts for any MBID-shaped string. */
export function recordingFor(mbid) {
  const rnd = mulberry32(fnv1a(`r:${mbid}`));
  const artistIndex = Math.floor(rnd() * CATALOG_SIZE);
  const artist = artistFor(artistMbid(artistIndex));
  return {
    mbid,
    title: `${pick(TITLE_HEADS, rnd)}${pick(TITLE_TAILS, rnd)}`,
    lengthMs: 95_000 + Math.floor(rnd() * 300_000),
    artist,
    releaseMbid: releaseMbid(Math.floor(rnd() * CATALOG_SIZE)),
    releaseTitle: `${pick(ADJECTIVES, rnd)} ${pick(NOUNS, rnd)}`,
    label: pick(LABELS, rnd),
    year: 1972 + Math.floor(rnd() * 53),
    // Numeric ids for the stores that do not speak MBID. Derived from the MBID
    // so the crosswalk is stable in both directions.
    itunesTrackId: 100_000_000 + (fnv1a(`itunes:${mbid}`) % 900_000_000),
    deezerTrackId: 1_000_000 + (fnv1a(`deezer:${mbid}`) % 900_000_000),
    spotifyId:
      hex(fnv1a(`spotify:${mbid}`), 8) +
      hex(fnv1a(`spotify2:${mbid}`), 8) +
      "abcdef",
  };
}

/** Search terms that look like what a human types, drawn from the same pools so
 *  a search result can plausibly reference real catalog entries. */
export function searchTerm(i) {
  const rnd = mulberry32(fnv1a(`q:${i}`));
  const style = rnd();
  if (style < 0.45) return pick(NOUNS, rnd).toLowerCase();
  if (style < 0.8)
    return `${pick(ADJECTIVES, rnd)} ${pick(NOUNS, rnd)}`.toLowerCase();
  return pick(TITLE_HEADS, rnd).toLowerCase();
}
