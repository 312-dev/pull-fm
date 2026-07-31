/**
 * Tests that the published legal documents are still true of this system.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 *
 * `legal-versions.test.ts` asserts things about the documents: that they exist,
 * that digests are well-formed, that a formatter run is not an amendment. It
 * protects them from drifting.
 *
 * `legal-triggers.test.ts` asserts that a capability is not switched on before
 * its legal preconditions hold. It protects the moment of enabling.
 *
 * Neither notices ordinary development. Somebody adds an analytics dependency
 * on a Tuesday and privacy policy section 3.6 becomes a false statement of fact
 * under section 5 of the FTC Act, with every gate still green. This file is the
 * third leg: the claims the documents make about what the system does and does
 * not do, asserted against the system.
 *
 * ---------------------------------------------------------------------------
 * WHY SECTION F IS TESTED RATHER THAN TRUSTED
 *
 * Until 2026-07-30 the privacy policy named database tables and columns in
 * prose. That made every claim checkable and made the document read as a schema
 * description, so the names moved to section F of the publication checklist.
 *
 * The names were the coupling. A developer renaming `users.email` used to at
 * least meet the policy in a grep. Section F on its own is inert prose with
 * nothing asserting it is current, which trades a misrepresentation risk for a
 * drift risk. That trade is only correct if the drift risk is closed, so this
 * file closes it: every identifier section F names must exist.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

const read = (relative: string): string =>
  readFileSync(join(REPO, relative), "utf8");

const CHECKLIST = "docs/compliance/publication-checklist.md";
const PRIVACY = "legal/privacy-policy.md";

const MIGRATIONS = join(REPO, "packages", "db", "migrations");
const schemaCorpus = (): string =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");

const packageJsonCorpus = (): string =>
  ["package.json", "apps/bff/package.json", "packages/db/package.json"]
    .filter((p) => existsSync(join(REPO, p)))
    .map(read)
    .join("\n");

// ---------------------------------------------------------------------------

/** Everything inside backticks in section F of the checklist. */
function sectionFTokens(): string[] {
  const doc = read(CHECKLIST);
  const start = doc.indexOf("## F.");
  expect(start, "section F is missing from the checklist").toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...new Set([...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]!))];
}

type Classified =
  | { kind: "file"; token: string }
  | { kind: "env"; token: string }
  | { kind: "script"; token: string }
  | { kind: "schema"; token: string; parts: string[] }
  | { kind: "prose"; token: string };

function classify(token: string): Classified {
  if (/^[\w./-]+\.(ts|mjs|js|tf|sql|md)$/.test(token)) {
    return { kind: "file", token };
  }
  if (/^[A-Z][A-Z0-9_]{4,}$/.test(token)) return { kind: "env", token };
  if (/^[a-z]+:[a-z]+$/.test(token)) return { kind: "script", token };
  if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(token)) {
    return { kind: "schema", token, parts: token.split(".") };
  }
  // Routes, SQL fragments, CIDR suffixes, provider region names and settings
  // written as `key = value`. Real content, but not an identifier this file can
  // resolve, so it is skipped rather than guessed at.
  return { kind: "prose", token };
}

describe("section F of the checklist names things that exist", () => {
  const tokens = sectionFTokens();
  const classified = tokens.map(classify);

  test("the parser actually found something to check", () => {
    // Without this, a classifier that silently stops matching turns every
    // assertion below into a loop over an empty list, which is the exact shape
    // of a check that reports success while checking nothing.
    const resolvable = classified.filter((c) => c.kind !== "prose");
    expect(
      resolvable.length,
      `only ${String(resolvable.length)} of ${String(tokens.length)} section F tokens were ` +
        `resolvable. Either section F was emptied or the classifier stopped ` +
        `matching; both make this suite vacuous.`,
    ).toBeGreaterThanOrEqual(15);
  });

  test("every file it names exists", () => {
    for (const c of classified) {
      if (c.kind !== "file") continue;
      expect(
        existsSync(join(REPO, c.token)),
        `section F names ${c.token}, which does not exist`,
      ).toBe(true);
    }
  });

  test("every environment variable it names is declared in config", () => {
    const config = read("apps/bff/src/config.ts");
    for (const c of classified) {
      if (c.kind !== "env") continue;
      expect(
        config.includes(c.token),
        `section F names ${c.token}, which config.ts no longer declares`,
      ).toBe(true);
    }
  });

  test("every script it names is defined in a package", () => {
    const packages = packageJsonCorpus();
    for (const c of classified) {
      if (c.kind !== "script") continue;
      expect(
        packages.includes(`"${c.token}"`),
        `section F names the script ${c.token}, which no package defines`,
      ).toBe(true);
    }
  });

  test("every table and column it names is in the schema", () => {
    // Tables and columns are not distinguished. Asserting that the identifier
    // appears somewhere in the migrations catches the rename, which is the
    // failure this exists for, without this file having to model the schema.
    const schema = schemaCorpus();
    for (const c of classified) {
      if (c.kind !== "schema") continue;
      for (const part of c.parts) {
        expect(
          schema.includes(part),
          `section F names ${c.token}, but "${part}" appears in no migration. ` +
            `If it was renamed, the privacy policy sentence mapped to it may no ` +
            `longer describe anything.`,
        ).toBe(true);
      }
    }
  });
});

describe("the negatives in privacy policy section 3.6 are true", () => {
  // These are the highest-consequence claims in the document and the cheapest
  // to violate, because each is one dependency away. They are also the claims a
  // reader is least able to verify and most likely to rely on.

  test("no analytics, telemetry or error-reporting dependency exists", () => {
    const forbidden = [
      "@google-analytics",
      "gtag",
      "react-ga",
      "@segment/",
      "analytics-node",
      "posthog",
      "mixpanel",
      "@amplitude/",
      "amplitude-js",
      "@sentry/",
      "bugsnag",
      "rollbar",
      "datadog",
      "dd-trace",
      "newrelic",
      "logrocket",
      "fullstory",
      "hotjar",
      "@vercel/analytics",
      "plausible",
      "fathom-client",
    ];
    const manifests = readdirSync(REPO, { withFileTypes: true });
    expect(manifests.length).toBeGreaterThan(0);

    const corpus = packageJsonCorpus();
    const found = forbidden.filter((dep) => corpus.includes(dep));
    expect(
      found,
      `privacy policy section 3.6 states there is no analytics, tracking or ` +
        `third-party error reporting of any kind. These dependencies contradict ` +
        `it: ${found.join(", ")}. A privacy policy is a representation under ` +
        `section 5 of the FTC Act; the claim has to be removed before the ` +
        `dependency is added.`,
    ).toEqual([]);
  });

  test("no payment dependency exists", () => {
    const corpus = packageJsonCorpus();
    const found = ["stripe", "@paypal", "braintree", "square"].filter((dep) =>
      corpus.includes(`"${dep}`),
    );
    expect(
      found,
      `privacy policy section 3.6 states Pull.fm is free and accepts no ` +
        `payments. Found: ${found.join(", ")}`,
    ).toEqual([]);
  });

  test("no schema column stores precise location", () => {
    const schema = schemaCorpus();
    const forbidden = [
      "latitude",
      "longitude",
      "\\blat\\b",
      "\\blng\\b",
      "\\blon\\b",
      "coordinates",
      "geolocation",
      "gps",
    ];
    const found = forbidden.filter((p) => new RegExp(p, "i").test(schema));
    expect(
      found,
      `privacy policy section 3.6 states no precise location is collected and ` +
        `that the events feature accepts a city name only. These schema ` +
        `identifiers contradict it: ${found.join(", ")}. SeatGeek's terms ` +
        `separately forbid personal data reaching their API.`,
    ).toEqual([]);
  });

  test("no schema column stores biometric data or a password", () => {
    // BIPA (740 ILCS 14) applies to a private entity of any size and is
    // enforced by private plaintiffs, so this claim carries more exposure than
    // anything else in section 3.6.
    const schema = schemaCorpus();
    const forbidden = [
      "biometric",
      "voiceprint",
      "fingerprint",
      "faceprint",
      "face_geometry",
      "iris_scan",
      "retina",
      "password_hash",
      "password_digest",
    ];
    const found = forbidden.filter((p) => new RegExp(p, "i").test(schema));
    expect(
      found,
      `privacy policy section 3.6 disclaims biometric information absolutely ` +
        `and states there is no password field. Found: ${found.join(", ")}`,
    ).toEqual([]);
  });

  test("the claims these tests defend are still the ones in the document", () => {
    // If somebody softens section 3.6, the assertions above keep passing while
    // defending sentences that no longer exist. This pins them to the text.
    const privacy = read(PRIVACY);
    for (const phrase of [
      "No advertising or analytics of any kind",
      "No third-party crash or error reporting",
      "No precise location",
      "No biometric identifiers and no biometric information of any kind",
      "No passwords",
      "No payment information",
    ]) {
      expect(
        privacy.includes(phrase),
        `privacy policy section 3.6 no longer contains "${phrase}", so the ` +
          `test defending it is now guarding a claim the document does not make.`,
      ).toBe(true);
    }
  });
});

/**
 * Foreign keys to `users(id)` that do not cascade on delete.
 *
 * Extracted so it can be run against synthetic schemas below. A detector only
 * ever exercised on a schema that satisfies it is indistinguishable from one
 * that returns an empty array.
 */
export function nonCascadingUserReferences(sql: string): string[] {
  const pattern =
    /references\s+users\s*\(\s*id\s*\)((?:(?!,\n|\n\s*\)|;)[\s\S]){0,120}?)(?=,\n|\n\s*\)|;)/gi;
  const offenders: string[] = [];
  for (const match of sql.matchAll(pattern)) {
    if (!/on\s+delete\s+cascade/i.test(match[1] ?? "")) {
      offenders.push(match[0].replace(/\s+/g, " ").slice(0, 90));
    }
  }
  return offenders;
}

describe("the cascade detector can fail", () => {
  // Run against schemas this repository does not contain, so the assertion on
  // the real schema means "everything cascades" rather than "nothing matched".

  test("a cascading reference is not reported", () => {
    expect(
      nonCascadingUserReferences(
        "create table a (\n  user_id uuid not null references users(id) on delete cascade,\n  x text\n);",
      ),
    ).toEqual([]);
  });

  test("a bare reference is caught", () => {
    expect(
      nonCascadingUserReferences(
        "create table b (\n  user_id uuid not null references users(id),\n  x text\n);",
      ),
    ).toHaveLength(1);
  });

  test("ON DELETE SET NULL is caught, not mistaken for a cascade", () => {
    // The case a substring search for "on delete" would wave through, and the
    // one that would silently orphan personal information after an erasure.
    expect(
      nonCascadingUserReferences(
        "create table c (\n  user_id uuid not null references users(id) on delete set null,\n  x text\n);",
      ),
    ).toHaveLength(1);
  });
});

describe("no user-owned table escapes the deletion claim", () => {
  test("every table referencing users declares ON DELETE CASCADE", () => {
    // Privacy policy section 7 states that deleting an account removes
    // everything linked to it "together, in a single step that either completes
    // or does not happen at all". That is only true while every table holding
    // user rows cascades. A new table without one makes the sentence false and
    // leaves orphaned personal information behind.
    //
    // packages/db/scripts/verify-migrations.mjs asserts the cascade against a
    // real database in CI. This is the cheap static half, so the failure is
    // visible without a database and names the legal consequence.
    const offenders = nonCascadingUserReferences(schemaCorpus());
    expect(
      offenders,
      `these foreign keys to users do not cascade on delete, which makes the ` +
        `deletion claim in privacy policy section 7 false:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  test("the cascade check is not vacuous", () => {
    // Proves the pattern above matches real references, so an empty offender
    // list means "all cascade" rather than "matched nothing".
    const schema = schemaCorpus();
    const references = [
      ...schema.matchAll(/references\s+users\s*\(\s*id\s*\)/gi),
    ];
    expect(
      references.length,
      "no foreign key to users(id) was found in any migration, so the cascade " +
        "assertion above is checking nothing",
    ).toBeGreaterThan(3);
  });
});
