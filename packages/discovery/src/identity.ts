/**
 * Dedup identity for blended results.
 *
 * DELIBERATE DUPLICATION. These rules mirror `normalizeKey` / `normalizeTitle`
 * in @pull-fm/upstream (packages/upstream/src/normalize.ts), which is the
 * source of truth because it also produces `mbid_crosswalk.normalized_key`.
 * They are copied rather than imported so this package has no build-order
 * dependency: CI runs `pnpm typecheck` before `pnpm build`, so importing a
 * sibling package's built types would fail the typecheck step.
 *
 * The shared fixtures in identity.test.ts are duplicated in the upstream tests
 * for exactly this reason: if the two implementations drift, one of the two
 * suites goes red.
 */

const CONJUNCTIONS: readonly [RegExp, string][] = [
  [/\s*&\s*/g, " and "],
  [/\s*\+\s*/g, " and "],
];

const TITLE_NOISE =
  /\s*[([]\s*(?:remaster(?:ed)?|re-?master(?:ed)?|\d{4}\s+remaster(?:ed)?|live|mono|stereo|deluxe|bonus track|radio edit|album version|single version|explicit|clean)[^)\]]*[)\]]\s*/gi;

const TITLE_DASH_NOISE =
  /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|re-?master(?:ed)?|live|mono|stereo|radio edit|single version|album version)\b.*$/i;

export function normalizeKey(input: string): string {
  let s = input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  for (const [re, to] of CONJUNCTIONS) s = s.replace(re, to);
  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(input: string): string {
  return normalizeKey(
    input.replace(TITLE_NOISE, " ").replace(TITLE_DASH_NOISE, ""),
  );
}

/**
 * The dedup key for a track.
 *
 * Deliberately NOT the MBID. Sources disagree about MBIDs far more often than
 * they disagree about spelling: ListenBrainz returns a recording MBID, Last.fm
 * frequently returns none, and a normalised (artist, title) pair is the only
 * identity all of them can produce. Deduping on MBID would leave the same
 * track appearing twice in one shelf, which is the single most visible
 * possible defect in a discovery feed.
 */
export const KEY_SEPARATOR = "\u001f";

export function trackIdentity(artistName: string, title: string): string {
  const artist = normalizeKey(artistName);
  const track = normalizeTitle(title);
  // Both halves empty means there is nothing to identify. A separator rather
  // than a space, so artist "a b" + title "c" cannot collide with artist "a"
  // + title "b c".
  if (artist === "" && track === "") return "";
  return `${artist}${KEY_SEPARATOR}${track}`;
}

export function artistIdentity(artistName: string): string {
  return normalizeKey(artistName);
}
