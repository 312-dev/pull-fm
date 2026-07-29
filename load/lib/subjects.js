/**
 * The authenticated population, loaded from the manifest `seed-subjects.mjs`
 * wrote.
 *
 * WHY THERE IS A FILE HERE AT ALL
 * -------------------------------
 * Auth is magic-link only, so k6 cannot log in. It also cannot mint a JWT: the
 * k6 runtime has no RSA signing and no Postgres client. Provisioning therefore
 * happens once, out of band, in Node, and k6 reads the result.
 *
 * NOTHING IN THIS FILE IS EVER COMMITTED, AND NOTHING IS EVER PRINTED.
 * -------------------------------------------------------------------
 * The manifest holds live credentials. `.gitignore` covers it, the seeder
 * writes it 0600, and no code path here logs a credential: the summary records
 * how many subjects were loaded and which credential kinds were available,
 * never a value. The load record is an artifact people attach to tickets.
 *
 * TWO CREDENTIAL KINDS, BECAUSE THE API HAS TWO
 * ---------------------------------------------
 * `requireAuth` in `apps/bff/src/plugins/auth.ts` admits a personal API token
 * on seven routes and refuses it with 403 on the rest. The refused set is the
 * cache-backed one: search, the artist/track/album lookups, the preview route,
 * and every wishlist write. So each action declares which credential it needs
 * and this module hands out the right one, rather than one global token being
 * silently wrong for half the mix.
 */
import exec from "k6/execution";

import { CONFIG } from "./config.js";

/**
 * `open()` is init-context only, which is exactly the constraint that makes
 * this safe: the manifest is read once per k6 process, before any VU starts,
 * and never re-read from a VU.
 */
const MANIFEST = (() => {
  if (!CONFIG.subjectsFile) return null;
  let raw;
  try {
    raw = open(CONFIG.subjectsFile);
  } catch (e) {
    throw new Error(
      [
        "",
        `Cannot read SUBJECTS_FILE at ${CONFIG.subjectsFile}: ${e.message}`,
        "",
        "  The authenticated surface needs real credentials. Provision them:",
        "",
        "    node load/auth/idp.mjs &                     # local identity provider",
        "    node load/auth/seed-subjects.mjs --count 200 # users, sessions, API tokens",
        "",
        "  See docs/RUNBOOK-SCALE.md for how a runner obtains one against staging.",
        "",
      ].join("\n"),
    );
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.subjects) || parsed.subjects.length === 0) {
    throw new Error(`${CONFIG.subjectsFile} contains no subjects`);
  }
  return parsed;
})();

export const SUBJECT_COUNT = MANIFEST ? MANIFEST.subjects.length : 0;
export const TOKENS_AVAILABLE = MANIFEST
  ? MANIFEST.subjects.filter((s) => typeof s.token === "string" && s.token)
      .length
  : 0;

/**
 * What the run record says about the population. Counts and configuration only;
 * every credential value is deliberately absent.
 */
export const SUBJECT_SUMMARY = MANIFEST
  ? {
      count: SUBJECT_COUNT,
      withApiToken: TOKENS_AVAILABLE,
      tokenRateLimitPerMinute: MANIFEST.tokenRateLimitPerMinute ?? null,
      generatedAt: MANIFEST.generatedAt ?? null,
      seededAgainst: MANIFEST.baseUrl ?? null,
    }
  : { count: 0, withApiToken: 0, tokenRateLimitPerMinute: null };

/**
 * The subject this iteration acts as.
 *
 * Keyed off the global iteration counter rather than the VU id so a run with
 * 250 VUs still touches hundreds of distinct subjects. The odd multiplier
 * scrambles the order: consecutive iterations landing on adjacent subjects
 * would manufacture per-user cache locality that no real traffic has.
 */
export function subjectFor(iteration = exec.scenario.iterationInTest) {
  if (MANIFEST === null) return null;
  const i = Math.abs((iteration * 2654435761) % SUBJECT_COUNT);
  return MANIFEST.subjects[i];
}

/** A fixed subject, for scenarios that need every request on ONE identity. */
export function subjectAt(index) {
  if (MANIFEST === null) return null;
  return MANIFEST.subjects[Math.abs(index) % SUBJECT_COUNT];
}

/**
 * Picks the credential an action needs.
 *
 * `kind` is "token" when the route admits a personal API token and "session"
 * when it does not. Asking for a token the seeder could not mint falls back to
 * the session rather than sending nothing, and the fallback is counted so the
 * summary can say the token surface was under-exercised instead of the run
 * quietly measuring the session path twice.
 */
export function credentialFor(subject, kind) {
  if (subject === null || subject === undefined)
    return { value: null, kind: "none" };
  if (kind === "token" && typeof subject.token === "string" && subject.token) {
    return { value: subject.token, kind: "token" };
  }
  return { value: subject.session, kind: "session" };
}
