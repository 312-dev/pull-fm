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
  CONSENT_PRESENTATION,
  NON_CONSENT_LEGAL_FILES,
  PUBLISHED_DOCUMENTS,
  declaredHighlightSources,
  HIGHLIGHT_DIGEST_PREFIX,
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
    for (const doc of PUBLISHED_DOCUMENTS) {
      expect(
        existsSync(join(REPO, doc.path)),
        `${doc.id} points at ${doc.path}, which does not exist`,
      ).toBe(true);
    }
  });

  test.each(PUBLISHED_DOCUMENTS)(
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

  test.each(PUBLISHED_DOCUMENTS)(
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
    for (const doc of PUBLISHED_DOCUMENTS) {
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
    for (const doc of PUBLISHED_DOCUMENTS) {
      expect(doc.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.id).toMatch(/^[a-z][a-z0-9-]{2,63}$/);
      expect(doc.version).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    }
  });

  test("the url a client is told to fetch is an absolute https URL", () => {
    // The client hashes what it fetches from here and the API refuses an
    // acceptance whose digest does not match, so a relative path or an http URL
    // would make consent unrecordable rather than merely untidy.
    for (const doc of PUBLISHED_DOCUMENTS) {
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
    // PUBLISHED_DOCUMENTS rather than CONSENT_DOCUMENTS, so the consent screen
    // copy counts as declared. It is the third category: published, versioned and
    // digest-locked, and never accepted.
    const publishedPaths = new Set(
      PUBLISHED_DOCUMENTS.map((d) => d.path.replace(/^legal\//, "")),
    );
    const declared = new Set([...publishedPaths, ...NON_CONSENT_LEGAL_FILES]);

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

/**
 * The consent screen copy is the third category, and it is only worth having if
 * both halves of that hold: versioned like a document, never accepted like one.
 */
describe("the consent screen copy", () => {
  test("is published but is NOT a document anybody is asked to accept", () => {
    // The circularity, asserted rather than trusted to the comment that argues
    // it. A person cannot be asked to accept the words with which they are being
    // asked to accept, and if this entry ever reached CONSENT_DOCUMENTS every
    // existing user would owe an acceptance of the consent screen and the screen
    // would list itself among the documents it was presenting.
    expect(PUBLISHED_DOCUMENTS).toContain(CONSENT_PRESENTATION);
    expect(
      CONSENT_DOCUMENTS.map((d) => d.id),
      "the consent screen copy must never be in the set the gate compares against",
    ).not.toContain(CONSENT_PRESENTATION.id);
  });

  test("declares which versions of the other documents its highlights quote", () => {
    // THE INTERLOCK THE DIGEST CANNOT PROVIDE. Section 3.1 of the copy quotes the
    // USD 100 and USD 50 liability caps out of Terms section 13, and names
    // sections 2, 9, 13 and 16 by number. A Terms revision that moved either
    // figure or renumbered either section leaves this file byte-identical, so its
    // digest still matches, while the screen it specifies now states a false
    // figure to every new user at the moment a contract forms.
    //
    // So the file declares what it read, and this compares the declaration to the
    // registry. Bumping the Terms turns the copy red until somebody has re-read
    // section 3.1 against the new text.
    const declared = declaredHighlightSources(read(CONSENT_PRESENTATION.path));
    expect(
      declared,
      `${CONSENT_PRESENTATION.path} has no "**Highlights checked against:**" line. ` +
        `It must name every document its highlights quote, as \`id@version\`.`,
    ).not.toBeNull();

    // Every entry must carry a digest. The old `id@version` form parses to
    // `digest: null`, and accepting it would restore the hole this closes.
    const missingDigest = Object.entries(declared!)
      .filter(([, v]) => v.digest === null)
      .map(([id]) => id);
    expect(
      missingDigest,
      `these entries pin only a version: ${missingDigest.join(", ")}. Write ` +
        `them as \`id@version#digest\`, where digest is at least ` +
        `${HIGHLIGHT_DIGEST_PREFIX} hex characters of the source document's ` +
        `content hash. A version alone does not move when an unpublished draft ` +
        `is edited in place, which is how this interlock stayed green through ` +
        `two rewrites of both source documents on 2026-07-30.`,
    ).toEqual([]);

    const expected = Object.fromEntries(
      CONSENT_DOCUMENTS.map((doc) => [
        doc.id,
        {
          version: doc.version,
          digest: doc.contentSha256.slice(0, HIGHLIGHT_DIGEST_PREFIX),
        },
      ]),
    );
    // Compare the declared prefix against the same length of the real digest,
    // so a line written with a longer prefix is still accepted.
    const normalised = Object.fromEntries(
      Object.entries(declared!).map(([id, v]) => [
        id,
        {
          version: v.version,
          digest: (v.digest ?? "").slice(0, HIGHLIGHT_DIGEST_PREFIX),
        },
      ]),
    );
    expect(
      normalised,
      `\n\n${CONSENT_PRESENTATION.path} quotes figures and section numbers out of ` +
        `the documents below, and the versions it was checked against are no longer ` +
        `the current ones.\n\n` +
        `  declared: ${JSON.stringify(normalised)}\n` +
        `  current:  ${JSON.stringify(expected)}\n\n` +
        `Do NOT just update the line. Re-read section 3.1 of ` +
        `${CONSENT_PRESENTATION.path} against the new text, then decide:\n\n` +
        `  A renumbered section or a reworded citation is COSMETIC here: bump this ` +
        `document's version, keep consentEpoch, set material: false.\n` +
        `  A changed figure, a changed protection, or a highlight that is now ` +
        `wrong is MATERIAL: bump the version, raise consentEpoch, set ` +
        `material: true, because the words a person is shown at the moment of ` +
        `formation would otherwise be false.\n`,
    ).toEqual(expected);
  });

  test("says out loud that no client presents it yet", () => {
    // The `[OPEN]` marker is the document declining to claim something the system
    // does not do, and `make legal` counts it. Asserted here so that deleting it
    // to make the publication check quieter fails a test as well, which is the
    // rule legal/README.md states and the one that is easiest to break by
    // accident.
    expect(read(CONSENT_PRESENTATION.path)).toContain(
      "No Pull.fm client presents this screen",
    );
  });
});

describe("the highlight pin parser", () => {
  // The interlock above passes against the real file, which proves only that it
  // does not fail a correct repository. These prove it can fail, which is the
  // half that makes it worth having.
  const pin = (body: string): string =>
    `# X\n\n**Highlights checked against:** ${body}\n\nbody\n`;

  test("extracts the digest from the id@version#digest form", () => {
    const got = declaredHighlightSources(
      pin("`terms-of-service@DRAFT-1#180d130e2d6f`"),
    );
    expect(got).toEqual({
      "terms-of-service": { version: "DRAFT-1", digest: "180d130e2d6f" },
    });
  });

  test("reports a digest-less entry as such rather than accepting it", () => {
    // The old form. Parsing it to `digest: null` is what lets the interlock
    // reject it by name; silently treating it as satisfied would reopen the
    // hole, because an unpublished draft edited in place keeps its version.
    const got = declaredHighlightSources(pin("`terms-of-service@DRAFT-1`"));
    expect(got).toEqual({
      "terms-of-service": { version: "DRAFT-1", digest: null },
    });
  });

  test("the version stops at the hash, so neither field absorbs the other", () => {
    const got = declaredHighlightSources(
      pin("`privacy-policy@DRAFT-1#f18244518ebd`"),
    );
    expect(got!["privacy-policy"]!.version).toBe("DRAFT-1");
    expect(got!["privacy-policy"]!.digest).toBe("f18244518ebd");
  });

  test("a stale digest is distinguishable from a current one", () => {
    // The exact scenario this closes: same version, different bytes.
    const current = CONSENT_DOCUMENTS.find((d) => d.id === "terms-of-service")!;
    const stale = declaredHighlightSources(
      pin("`terms-of-service@DRAFT-1#000000000000`"),
    );
    expect(stale!["terms-of-service"]!.version).toBe(current.version);
    expect(stale!["terms-of-service"]!.digest).not.toBe(
      current.contentSha256.slice(0, HIGHLIGHT_DIGEST_PREFIX),
    );
  });

  test("the declared prefix is long enough to mean something", () => {
    // A two-character prefix would collide constantly and the interlock would
    // pass through most real edits.
    expect(HIGHLIGHT_DIGEST_PREFIX).toBeGreaterThanOrEqual(8);
    const declared = declaredHighlightSources(read(CONSENT_PRESENTATION.path))!;
    for (const [id, v] of Object.entries(declared)) {
      expect(v.digest, `${id} pins no digest`).not.toBeNull();
      expect(v.digest!.length).toBeGreaterThanOrEqual(HIGHLIGHT_DIGEST_PREFIX);
    }
  });

  test("absent line is null, not an empty object", () => {
    // An empty object would compare equal to nothing and make the interlock
    // silently vacuous; null lets the test say the line is missing.
    expect(declaredHighlightSources("# X\n\nno pin here\n")).toBeNull();
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
