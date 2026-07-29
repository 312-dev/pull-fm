/**
 * Name normalisation for the MBID crosswalk.
 *
 * `mbid_crosswalk.normalized_key` is UNIQUE, so these rules define what counts
 * as "the same artist" across providers that disagree about spelling. The
 * schema comment names the contract - lowercased, unaccented,
 * punctuation-stripped - and it is implemented here rather than in SQL so that
 * one tested function produces every key that is ever written or looked up.
 *
 * The rules are deliberately conservative. Aggressive normalisation collapses
 * genuinely distinct artists ("Xiu Xiu" and "XX" are not the same band), and a
 * false merge in a UNIQUE-keyed crosswalk is close to unrecoverable because it
 * poisons every future lookup that hits the row.
 */

/** Ampersand-style conjunctions that providers spell inconsistently. */
const CONJUNCTIONS: readonly [RegExp, string][] = [
  [/\s*&\s*/g, " and "],
  [/\s*\+\s*/g, " and "],
];

/**
 * Suffixes that describe a *rendering* of a recording rather than a different
 * recording. Stripped only by `normalizeTitle`, never by `normalizeKey`, since
 * the crosswalk must not merge a studio take with a live one.
 */
const TITLE_NOISE =
  /\s*[([]\s*(?:remaster(?:ed)?|re-?master(?:ed)?|\d{4}\s+remaster(?:ed)?|live|mono|stereo|deluxe|bonus track|radio edit|album version|single version|explicit|clean)[^)\]]*[)\]]\s*/gi;

/** Trailing "- 2011 Remaster" style suffixes, which use a dash not a bracket. */
const TITLE_DASH_NOISE =
  /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|re-?master(?:ed)?|live|mono|stereo|radio edit|single version|album version)\b.*$/i;

function stripDiacritics(input: string): string {
  // NFKD then drop combining marks: "Björk" -> "bjork", matching the unaccent
  // extension the trigram index is built over.
  return input.normalize("NFKD").replace(/\p{M}+/gu, "");
}

/**
 * The canonical crosswalk key. Stable, lossy, and never shown to a user.
 *
 * Returns "" for input that normalises away entirely; callers must treat an
 * empty key as unresolvable rather than writing it, or every punctuation-only
 * name would collide on one crosswalk row.
 */
export function normalizeKey(input: string): string {
  let s = stripDiacritics(input.trim().toLowerCase());
  for (const [re, to] of CONJUNCTIONS) s = s.replace(re, to);
  s = s
    // Keep letters, digits, and spaces in any script; drop everything else.
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/** Crosswalk key for a track title, additionally stripping release-variant noise. */
export function normalizeTitle(input: string): string {
  const withoutNoise = input
    .replace(TITLE_NOISE, " ")
    .replace(TITLE_DASH_NOISE, "");
  return normalizeKey(withoutNoise);
}

/**
 * Composite-key separator.
 *
 * A control byte rather than a space, because a space can occur inside either
 * half: artist "a b" + title "c" and artist "a" + title "b c" would otherwise
 * produce the same key.
 */
export const KEY_SEPARATOR = "\u001f";

/** The dedup identity for discovery: one string per (artist, title) pair. */
export function trackIdentity(artist: string, title: string): string {
  const a = normalizeKey(artist);
  const t = normalizeTitle(title);
  // Both halves empty means there is nothing to identify; callers must treat
  // an empty identity as "drop this candidate", never as a bucket to group by.
  if (a === "" && t === "") return "";
  return `${a}${KEY_SEPARATOR}${t}`;
}

/**
 * pg_trgm-compatible trigram similarity.
 *
 * Postgres is the authority - the trigram index on `normalized_key` is what
 * actually runs fuzzy lookups in production. This JS implementation mirrors
 * pg_trgm's algorithm (pad with two leading spaces and one trailing space, then
 * Jaccard over the trigram sets) so the in-memory store and the tests behave
 * like the real thing rather than approximately like it.
 */
export function trigrams(input: string): Set<string> {
  const out = new Set<string>();
  for (const word of input.split(/\s+/).filter((w) => w !== "")) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      out.add(padded.slice(i, i + 3));
    }
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return a === "" ? 0 : 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}
