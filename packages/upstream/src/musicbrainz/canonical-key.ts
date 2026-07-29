/**
 * Reproduces the MusicBrainz canonical dump's `combined_lookup` key.
 *
 * `mb.canonical.combined_lookup` is a PRE-NORMALISED column: the dump computes
 * it once, upstream, and every row carries the result. A local lookup is
 * therefore an equality test against a key WE have to compute the same way they
 * did, and "the same way" is not negotiable or approximable at the edges - a key
 * we build differently simply never matches, and the whole point of the local
 * table quietly evaporates while every test still passes.
 *
 * ---------------------------------------------------------------------------
 * THE UPSTREAM RULE, DERIVED FROM THE DATA
 *
 * The published rule is, in Python:
 *
 *     unidecode(re.sub(r'[^\w]+', '', artist_credit_name + recording_name).lower())
 *
 * Three operations, IN THIS ORDER, and the order is observable in the dump:
 *
 *   1. strip every non-word character (Python `\w` is Unicode-aware: letters,
 *      digits, underscore, and combining marks). Spaces go. Punctuation goes.
 *   2. lowercase
 *   3. transliterate to ASCII with `unidecode`
 *
 * Row 1 of the 2026-07-17 dump is `Various Artists` + `Pot Pourri Sega` ->
 * `variousartistspotpourrisega`, which is consistent with any order. Row 2 is
 * the one that pins it down: `Various Artists` + the CJK title `乡愁四韵` ->
 * `variousartistsXiang Chou Si Yun `, WITH capitals and a trailing space. Those
 * can only survive if `unidecode` ran AFTER `lower()` and after the strip -
 * unidecode emits `Xiang ` for `乡`, and nothing downstream removes the space or
 * the capital. Getting this order wrong produces `variousartistsxiangchousiyun`,
 * which matches no row in the table.
 *
 * ---------------------------------------------------------------------------
 * WHAT WE CAN AND CANNOT REPRODUCE, AND WHY THAT IS SAFE
 *
 * `unidecode` is a 100k-entry transliteration table. It is not in this package
 * and will not be: this package has NO RUNTIME DEPENDENCIES, and a dependency
 * added to reproduce a lookup key would be on the request path of every
 * resolution.
 *
 * What is implemented here is the Latin-script subset, which is the part that
 * decides real lookups: Unicode NFKD plus combining-mark removal handles every
 * precomposed accent (`Björk` -> `bjork`, `Sigur Rós` -> `sigurros`), and an
 * explicit table covers the Latin letters NFKD does NOT decompose because they
 * are atomic rather than accented (`ø`, `æ`, `ß`, `ł`, `đ`, `þ`).
 *
 * Non-Latin scripts are NOT transliterated. `乡愁四韵` stays `乡愁四韵` here and
 * is `Xiang Chou Si Yun ` in the table, so that row is unreachable locally.
 *
 * THAT IS THE SAFE DIRECTION AND IT IS THE REASON THIS DESIGN IS ACCEPTABLE. A
 * key we cannot reproduce produces NO local match, and no local match means the
 * caller falls through to the existing rate-limited MusicBrainz search, which is
 * exactly the behaviour that shipped before this table existed. The failure mode
 * is "the optimisation did not apply", never "the wrong MBID was returned". A
 * resolution is recorded permanently in `mbid_crosswalk`, so a wrong answer is
 * close to unrecoverable and a missed optimisation costs one upstream call.
 *
 * `canonicalCoverage` exists so that the gap is measurable rather than assumed:
 * a caller can ask whether a key is fully transliterable before spending a query
 * on it, and the refresh job reports the rate.
 */

/**
 * Latin letters `unidecode` maps that NFKD does not decompose.
 *
 * NFKD only splits a character into a base plus combining marks. These are
 * atomic Latin letters with no decomposition at all, so NFKD leaves them
 * untouched and they would survive into a key that the dump spells in ASCII.
 * Every entry here is `unidecode`'s own output for that character, and the test
 * suite pins each one.
 *
 * Uppercase forms are absent on purpose: `lowercase()` runs before this table is
 * consulted, so only the lowercase forms can be present by then. `ß` is the one
 * that would be easy to get wrong (`ẞ`.toLowerCase() is `ß`, so it arrives here
 * either way) and it maps to two characters, which is why this is a string
 * table and not a character map.
 */
const ATOMIC_LATIN: ReadonlyMap<string, string> = new Map([
  ["ø", "o"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ß", "ss"],
  ["đ", "d"],
  ["ð", "d"],
  ["þ", "th"],
  ["ł", "l"],
  ["ħ", "h"],
  ["ı", "i"],
  ["ŋ", "ng"],
  ["ĸ", "k"],
  ["ŧ", "t"],
  ["µ", "u"],
  ["ſ", "s"],
]);

/**
 * Characters Python's `\w` keeps. Everything else is deleted outright, with NO
 * replacement character - the dump concatenates, it does not join.
 *
 * `\p{M}` (combining marks) is included because Python's `\w` keeps them, and
 * dropping them here instead would change the key for any name written in
 * decomposed form: `Björk` and `Björk` must produce the same key, and they
 * only do if the mark survives the strip and is removed later by the NFKD pass.
 */
const NON_WORD = /[^\p{L}\p{N}\p{M}_]+/gu;

/** Combining marks, removed after NFKD has split precomposed characters. */
const COMBINING = /\p{M}+/gu;

/** Anything outside printable ASCII, which is what `unidecode` never emits. */
const NON_ASCII = /[^ -~]/u;

/**
 * The dump's normalisation, applied to one string.
 *
 * Exported separately from {@link canonicalKey} because the dump's key has a
 * property worth relying on: it is built by CONCATENATING the two names and then
 * normalising, and every step (strip, lowercase, transliterate) is per
 * character. Normalisation therefore distributes over concatenation -
 * `f(a + b) === f(a) + f(b)` - which is what makes an artist-prefix lookup
 * against `combined_lookup` well defined rather than a guess.
 */
export function canonicalFold(input: string): string {
  const stripped = input.replace(NON_WORD, "");
  const lowered = stripped.toLowerCase();
  // NFKD first so precomposed accents become base + mark, then drop the marks.
  // NFKD rather than NFD because unidecode also folds compatibility forms:
  // a full-width `ａ` is `a` to unidecode, and to NFKD.
  const folded = lowered.normalize("NFKD").replace(COMBINING, "");
  let out = "";
  for (const ch of folded) out += ATOMIC_LATIN.get(ch) ?? ch;
  return out;
}

/**
 * The key for one (artist credit, recording) pair.
 *
 * Compare against `mb.canonical.combined_lookup` with `=`. Returns "" for input
 * that normalises away entirely; a caller must treat "" as unresolvable rather
 * than querying with it, or every punctuation-only name collides on whatever
 * rows happen to have an empty key.
 */
export function canonicalKey(artistCredit: string, recording: string): string {
  return canonicalFold(`${artistCredit}${recording}`);
}

/**
 * Release-variant noise that the dump's `recording_name` does not carry.
 *
 * MIRRORS `TITLE_NOISE` and `TITLE_DASH_NOISE` in ../normalize.ts, and the
 * duplication is deliberate rather than an oversight. `normalizeTitle` there
 * applies these AND its own lowercase/unaccent/space-collapsing rules in one
 * step, and those rules produce a DIFFERENT string to `canonicalFold` - spaces
 * survive `normalizeKey` and do not survive the dump's fold. Importing it would
 * silently produce keys that match no row. What is needed here is only the noise
 * strip, applied before this file's own fold.
 *
 * If the list in normalize.ts grows, this one should grow with it; the test
 * suite pins the shared cases so the divergence is at least visible.
 */
const TITLE_NOISE =
  /\s*[([]\s*(?:remaster(?:ed)?|re-?master(?:ed)?|\d{4}\s+remaster(?:ed)?|live|mono|stereo|deluxe|bonus track|radio edit|album version|single version|explicit|clean)[^)\]]*[)\]]\s*/gi;

const TITLE_DASH_NOISE =
  /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|re-?master(?:ed)?|live|mono|stereo|radio edit|single version|album version)\b.*$/i;

/**
 * Every key worth trying for one (artist, title) pair, best first.
 *
 * Two, because the caller's title and the dump's `recording_name` come from
 * different places. ListenBrainz and Last.fm report what a scrobbling client
 * sent, which is usually a store's title and carries the store's decorations:
 * "Wish You Were Here - 2011 Remaster". MusicBrainz records the recording, which
 * does not. The first key is the caller's string folded verbatim, which is
 * correct when the two agree; the second strips the decorations first.
 *
 * Both are exact, indexed lookups against a local table, so trying two costs a
 * second index probe and no upstream call at all. Attempting the stripped form
 * FIRST would be wrong: a recording genuinely titled "Live" exists, and
 * preferring the stripped key would resolve it to a studio take.
 *
 * De-duplicated, so the common case where nothing was stripped is one lookup.
 */
export function canonicalKeyVariants(
  artistCredit: string,
  title: string,
): string[] {
  const out: string[] = [];
  const raw = canonicalKey(artistCredit, title);
  if (raw !== "") out.push(raw);
  const stripped = canonicalKey(
    artistCredit,
    title.replace(TITLE_NOISE, " ").replace(TITLE_DASH_NOISE, ""),
  );
  if (stripped !== "" && stripped !== raw) out.push(stripped);
  return out;
}

/**
 * Whether a key is fully transliterated, i.e. whether it can match at all.
 *
 * `unidecode` emits ASCII and nothing else. A key that still contains a
 * non-ASCII character is one this implementation could not finish folding, so no
 * row in the table can equal it, and querying with it spends a database round
 * trip to learn something that was decidable for free.
 *
 * Reported rather than merely acted on. The rate at which this returns false is
 * the honest measure of how much of the catalogue the local path cannot serve,
 * and it is a number that should be watched rather than assumed small.
 */
export function canonicalCoverage(key: string): boolean {
  return key !== "" && !NON_ASCII.test(key);
}
