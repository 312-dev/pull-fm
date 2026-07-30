/**
 * The document registry must describe the documents that exist.
 *
 * WHY THIS RUNS IN CI
 *
 * `lib/legal-documents.ts` records, per document, a version, a consent epoch and
 * a content digest. Enforcement compares the EPOCH and nothing else, which is
 * what lets a corrected typo ship without logging every user out. The cost of
 * that design is that the epoch is a human judgement, and a human judgement that
 * nothing checks is a judgement somebody skips.
 *
 * So this is the interlock. It recomputes the digest of every document on disk
 * and fails if it disagrees with the registry. To make it agree you have to edit
 * the registry, and to edit the registry you have to write down a version and
 * decide whether to raise the epoch - which IS the materiality decision, made
 * explicitly, in a diff somebody reviews. There is no path where a legal document
 * changes and nobody says what the change means.
 *
 * THE FAILURE THIS PREVENTS is specific and quiet: someone edits the Terms,
 * ships, and every consent row recorded afterwards cites a version whose text no
 * longer matches the digest stored alongside it. The records look fine. They are
 * evidence of assent to a document nobody can produce.
 *
 * WHEN THIS TEST FAILS, the fix is never to paste the new digest in and move on
 * without thinking. Decide first:
 *
 *   COSMETIC   typo, wording, formatting, a comment, a link. Bump `version`, keep
 *              `consentEpoch`, set `material: false`. Nobody re-accepts.
 *   MATERIAL   anything that changes what a user is agreeing to: liability,
 *              venue, data use, a new third-party beneficiary, a new obligation.
 *              Bump `version`, RAISE `consentEpoch` by exactly one, set
 *              `material: true`. Every user accepts again, and section 17 of the
 *              Terms requires in-app notice BEFORE the epoch is raised.
 *
 * Then paste the digest this test prints.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  CONSENT_DOCUMENTS,
  NON_CONSENT_LEGAL_FILES,
  declaredVersion,
  legalDigest,
  normalizeLegalText,
} from "../../src/lib/legal-documents.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

const read = (relative: string): string =>
  readFileSync(join(REPO, relative), "utf8");

describe("the legal document registry", () => {
  test("every registered document exists on disk", () => {
    for (const doc of CONSENT_DOCUMENTS) {
      expect(
        existsSync(join(REPO, doc.path)),
        `${doc.id} points at ${doc.path}, which does not exist`,
      ).toBe(true);
    }
  });

  test.each(CONSENT_DOCUMENTS)(
    "$id has not changed without a version decision",
    (doc) => {
      const actual = legalDigest(read(doc.path));
      expect(
        actual,
        `\n\n${doc.path} HAS CHANGED and the registry was not updated.\n\n` +
          `  recorded digest: ${doc.contentSha256}\n` +
          `  actual digest:   ${actual}\n\n` +
          `Do NOT just paste the new digest. Decide what the change was, in ` +
          `apps/bff/src/lib/legal-documents.ts:\n\n` +
          `  COSMETIC (typo, wording, formatting): bump version, KEEP ` +
          `consentEpoch at ${String(doc.consentEpoch)}, set material: false. ` +
          `Nobody re-accepts.\n` +
          `  MATERIAL (changes what a user agrees to): bump version, raise ` +
          `consentEpoch to ${String(doc.consentEpoch + 1)}, set material: true. ` +
          `EVERY user must accept again, and section 17 of the Terms requires ` +
          `in-app notice before you raise it.\n\n` +
          `Then set contentSha256 to the actual digest above.\n`,
      ).toBe(doc.contentSha256);
    },
  );

  test.each(CONSENT_DOCUMENTS)(
    "$id declares the same version in its own header",
    (doc) => {
      // The registry and the document a reader opens must not disagree. A
      // document whose header says DRAFT-1 while every consent row cites DRAFT-0
      // makes the rows reference a version that does not exist in the text they
      // name.
      expect(
        declaredVersion(read(doc.path)),
        `${doc.path} does not declare version ${doc.version} in a "**Version:**" line`,
      ).toBe(doc.version);
    },
  );

  test("epochs are positive integers and a first revision is material", () => {
    for (const doc of CONSENT_DOCUMENTS) {
      expect(Number.isInteger(doc.consentEpoch)).toBe(true);
      // Epoch 0 would mean "no acceptance required", which is not a state a
      // required document may be in; the database CHECK says the same thing.
      expect(doc.consentEpoch).toBeGreaterThanOrEqual(1);
      if (doc.consentEpoch === 1) {
        expect(
          doc.material,
          `${doc.id} is at epoch 1, which is the first revision and is material by definition`,
        ).toBe(true);
      }
    }
  });

  test("digests are lowercase hex sha256, so the schema will accept them", () => {
    // `legal_document_revisions_digest_shape_chk` and
    // `legal_consents_digest_shape_chk` both require exactly this, and a
    // registry entry that fails them would 500 at first publish rather than at
    // review.
    for (const doc of CONSENT_DOCUMENTS) {
      expect(doc.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.id).toMatch(/^[a-z][a-z0-9-]{2,63}$/);
      expect(doc.version).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    }
  });

  test("the url a client is told to fetch is an absolute https URL", () => {
    // The client hashes what it fetches from here and the API refuses an
    // acceptance whose digest does not match, so a relative path or an http URL
    // would make consent unrecordable rather than merely untidy.
    for (const doc of CONSENT_DOCUMENTS) {
      expect(doc.url.startsWith("https://"), `${doc.id} url is not https`).toBe(
        true,
      );
      expect(() => new URL(doc.url)).not.toThrow();
    }
  });

  test("every file under legal/ is either a consent document or declared not to be", () => {
    // Reconciled in BOTH directions, like security/zap/upstream-scope.tsv. A new
    // legal/eula.md that nobody wired into the gate fails here instead of sitting
    // in the repository unpresented, and a registry entry for a deleted file
    // fails too.
    const onDisk = readdirSync(join(REPO, "legal")).sort();
    const consentPaths = new Set(
      CONSENT_DOCUMENTS.map((d) => d.path.replace(/^legal\//, "")),
    );
    const declared = new Set([...consentPaths, ...NON_CONSENT_LEGAL_FILES]);

    const unclassified = onDisk.filter((f) => !declared.has(f));
    expect(
      unclassified,
      `file(s) in legal/ that are neither a consent document nor listed in ` +
        `NON_CONSENT_LEGAL_FILES: ${unclassified.join(", ")}. Decide which, in ` +
        `apps/bff/src/lib/legal-documents.ts. Adding a consent document makes it ` +
        `mandatory for every existing user immediately.`,
    ).toEqual([]);

    const missing = [...declared].filter((f) => !onDisk.includes(f));
    expect(
      missing,
      `declared legal file(s) that no longer exist: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("normalisation", () => {
  const sample = "# Title\n\nA line with trailing space   \nAnother line\n";

  test("a formatter run is not an amendment", () => {
    // The three changes normalisation absorbs, because none of them changes what
    // a reader sees and a digest that moved for them would be ignored inside a
    // week.
    const crlf = sample.replace(/\n/g, "\r\n");
    const extraNewlines = `${sample}\n\n\n`;
    const trailingTabs = sample.replace("Another line", "Another line\t\t");

    expect(legalDigest(crlf)).toBe(legalDigest(sample));
    expect(legalDigest(extraNewlines)).toBe(legalDigest(sample));
    expect(legalDigest(trailingTabs)).toBe(legalDigest(sample));
  });

  test("a real edit IS an amendment, so the check is not vacuous", () => {
    // The assertion above passes for a normalisation that returns a constant.
    // This is the one that proves it does not.
    expect(legalDigest(sample.replace("Another", "A different"))).not.toBe(
      legalDigest(sample),
    );
    // Leading whitespace and blank lines are significant: both change what a
    // reader sees, and this digest exists to pin what a reader saw.
    expect(legalDigest(sample.replace("Another", "  Another"))).not.toBe(
      legalDigest(sample),
    );
    expect(legalDigest(sample.replace("\n\nA line", "\nA line"))).not.toBe(
      legalDigest(sample),
    );
  });

  test("normalisation is idempotent", () => {
    const once = normalizeLegalText(sample);
    expect(normalizeLegalText(once)).toBe(once);
  });

  test("the digest is a plain sha256 of the normalised text", () => {
    // Stated as an assertion rather than left implicit, because a client has to
    // reproduce it in another language from the description in the API docs.
    expect(legalDigest(sample)).toBe(
      createHash("sha256")
        .update(normalizeLegalText(sample), "utf8")
        .digest("hex"),
    );
  });
});
