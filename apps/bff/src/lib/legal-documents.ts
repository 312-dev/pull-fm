/**
 * The published legal documents, their versions, and what an acceptance of one
 * has to satisfy.
 *
 * WHAT WAS WRONG
 *
 * `legal/terms-of-service.md` section 1 asserted that using Pull.fm meant
 * agreeing to the Terms. Nothing presented them and nothing recorded assent, so
 * the sentence was a claim rather than a mechanism, and under Illinois law
 * (`Sgouros v. TransUnion Corp.`, 817 F.3d 1029 (7th Cir. 2016)) that is not a
 * paperwork gap: no contract forms, and the liability cap, the governing-law
 * clause, the third-party beneficiary grant to the SeatGeek Entities and the
 * US-only offering all fall with it. SeatGeek's own API Terms clause 4.3
 * separately requires that each End User be REQUIRED TO ACCEPT a EULA before
 * using the Application, so shipping without the gate breaches their agreement as
 * well as failing to form ours.
 *
 * The client half of a consent gate is a screen. The durable half is here, and it
 * could ship before any client existed.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE IDENTIFIERS PER DOCUMENT AND NOT ONE
 *
 * The requirement that decides the design is this: a MATERIAL revision must force
 * every user to accept again, and a corrected typo must not. A content hash alone
 * CANNOT make that distinction, because a fixed comma and a new arbitration
 * clause produce equally different hashes. A version number alone cannot detect
 * an undeclared edit, because a human can change the text and forget to bump it.
 * So there are three, and each answers exactly one question:
 *
 *   contentSha256   "Did the bytes change?" Mechanical, cannot judge materiality.
 *                   Its job is to make an undeclared edit a build failure.
 *   version         "Which publication is this?" Human-assigned, printed in the
 *                   document's own header, recorded on every consent row so the
 *                   evidence names a text rather than a number.
 *   consentEpoch    "Does an older acceptance still count?" Bumped ONLY for a
 *                   material revision. The ONLY field enforcement compares.
 *
 * The interlock is what makes the decision unskippable. `legal-versions.test.ts`
 * recomputes the digest of every document on disk and fails if it disagrees with
 * this table. To make it agree you have to edit this table, and to edit this table
 * you have to write down a version and either raise the epoch or not - which is
 * the materiality decision, made explicitly, in a reviewable diff. There is no
 * path where a document changes and nobody decides what the change means.
 *
 * `effectiveAt` is REPORTED AND NEVER ENFORCED. Section 17 of the Terms promises
 * notice in the application before a material change takes effect, so the obvious
 * design is to compare it to the clock inside the gate. That was rejected: a
 * deploy carrying a future-dated material revision would then enforce nothing,
 * silently, until a wall clock passed. The operator's control is WHEN THEY BUMP
 * THE EPOCH, which is one line in one diff, and it must not be bumped until the
 * notice period has run.
 * ---------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

export interface LegalDocument {
  /** Stable slug. Appears in the API, in the consent row, and in the receipt. */
  readonly id: string;
  /** Repo-relative path to the canonical source. Read only by the CI check. */
  readonly path: string;
  /** Publication version, identical to the document's own `**Version:**` line. */
  readonly version: string;
  /**
   * Raised for a material revision, held for a cosmetic one. The only field the
   * enforcement gate compares.
   */
  readonly consentEpoch: number;
  /** Whether THIS version raised the epoch. Checked by the database trigger. */
  readonly material: boolean;
  /** sha256 of `normalizeLegalText(source)`, lowercase hex. */
  readonly contentSha256: string;
  /**
   * The canonical, absolute, VERSIONED location of the bytes the digest covers.
   *
   * Derived by `consentDocument` from `id` and `version`, never written by hand.
   * Served by routes/v1/legal.ts.
   */
  readonly url: string;
  /** Recorded and shown to the user. Never consulted by the gate. */
  readonly effectiveAt: string | null;
  /** Why this version exists. Ends up in `legal_document_revisions.notes`. */
  readonly notes: string;
}

/**
 * The ONE media type the digest covers.
 *
 * WHY THERE IS EXACTLY ONE REPRESENTATION AND NOT TWO
 *
 * `POST /v1/me/consent` refuses an acceptance whose digest does not match the
 * published one. So a second representation is not a nicety that might be
 * inconsistent, it is a representation NOBODY CAN ACCEPT: a client that fetched
 * a prettified HTML rendering, hashed what it displayed, and posted the result
 * would get a 409 forever, with no way to tell that from a genuine mismatch.
 *
 * The canonical artefact is therefore the markdown source and only the markdown
 * source. A client that wants a rendered document renders it locally, from bytes
 * it has already verified. Rendering here would also mean running a markdown
 * engine over hand-edited text and returning HTML from an unauthenticated
 * endpoint whose CSP is `default-src 'none'` precisely because this API returns
 * no markup.
 */
export const LEGAL_CONTENT_TYPE = "text/markdown; charset=utf-8";

/**
 * The origin the canonical document URLs are published under.
 *
 * A CONSTANT RATHER THAN `PUBLIC_BASE_URL`, and the reason is what `url` is for.
 * It is written into `legal_document_revisions.url` at first publish and that row
 * is immutable, so the value has to be the location a third party can still
 * resolve years later when reading a consent record. A deployment-derived origin
 * would put `http://127.0.0.1:3000` in the evidence of a local run and the
 * staging hostname in the evidence of a staging run.
 *
 * A CLIENT SHOULD NOT FOLLOW `url` BLINDLY for that same reason: a client talking
 * to a staging deployment must fetch from the origin it is already talking to.
 * The path is fully determined by `documentId` and `version`, both of which the
 * client already holds, so `legalVersionPath` is the thing to build against and
 * `url` is the citation. docs/api/legal-agreements.md states this to clients.
 */
const CANONICAL_ORIGIN = "https://api.pull.fm";

/** Where a SPECIFIC version's canonical bytes live. Immutable once published. */
export function legalVersionPath(documentId: string, version: string): string {
  return `/v1/legal/${documentId}/versions/${version}`;
}

/** Where whatever is CURRENT lives. Moves when a new version is published. */
export function legalCurrentPath(documentId: string): string {
  return `/v1/legal/${documentId}`;
}

/** The absolute, citable form of `legalVersionPath`. */
export function legalVersionUrl(documentId: string, version: string): string {
  return `${CANONICAL_ORIGIN}${legalVersionPath(documentId, version)}`;
}

/**
 * Fills in `url` from `id` and `version` so the three cannot disagree.
 *
 * Written as a factory rather than three string literals because the failure it
 * removes is silent and expensive: bumping `version` while leaving a hand-written
 * `url` pointing at the previous one would hand every client a link to superseded
 * text alongside the digest of the current text, so every acceptance would 409
 * and the only clue would be a URL nobody looked at twice.
 *
 * `url` NAMES THE VERSION rather than the document. That is deliberate. If it
 * named the moving current-document endpoint, then a version published between a
 * client reading `GET /v1/me/consent` and fetching the text would produce a
 * digest mismatch, so the handshake would have a race in it. A versioned URL is
 * also immutable, which is what lets it be cached forever and what makes it a
 * usable citation on an evidence row.
 */
function consentDocument(entry: Omit<LegalDocument, "url">): LegalDocument {
  return { ...entry, url: legalVersionUrl(entry.id, entry.version) };
}

/**
 * Every document a user must accept.
 *
 * Adding one here makes it mandatory for every user immediately, including users
 * who have already accepted everything else, because a document with no
 * acceptance puts a subject in the `never-accepted` tier. That is the correct
 * behaviour and it is also a large blast radius, so a new entry is a deliberate
 * product decision and not a routine addition.
 *
 * The digests are of the NORMALIZED text (see `normalizeLegalText`), so a
 * prettier run or a line-ending change cannot look like a revision. Everything
 * else can, which is the point.
 *
 * `url` AND `notes` ARE RECORDED AT FIRST PUBLISH AND NEVER RE-COMPARED.
 * `ensureRevisions` refuses a build that disagrees with a published row about the
 * digest, the epoch or materiality, because those three decide what an
 * acceptance MEANS. It deliberately does not compare `url` or `notes`, because
 * those are descriptive and refusing to boot over an improved sentence would be
 * a self-inflicted outage. The consequence, stated so nobody is surprised by it:
 * a database that published a version BEFORE this file changed its `url` keeps
 * the old string on that row forever. Nothing reads it (the routes resolve from
 * the registry and from `content`), and on a fresh database the two agree from
 * the start.
 */
export const CONSENT_DOCUMENTS: readonly LegalDocument[] = [
  consentDocument({
    id: "terms-of-service",
    path: "legal/terms-of-service.md",
    version: "DRAFT-0",
    consentEpoch: 1,
    material: true,
    contentSha256:
      "cead3bec4b7fa6a8b2044cb83d50a00699f51935b3eda90c6aeccf8d02f0abeb",
    effectiveAt: null,
    notes:
      "First recorded revision. Epoch 1 is the baseline: every user must accept it and no earlier acceptance exists to carry over. The document is still DRAFT-0 and NOT YET EFFECTIVE (it has not been reviewed by a lawyer), which is why effectiveAt is null.",
  }),
  consentDocument({
    id: "privacy-policy",
    path: "legal/privacy-policy.md",
    version: "DRAFT-0",
    consentEpoch: 1,
    material: true,
    contentSha256:
      "32a9f74702261aa661391106407850ce62f06c3cf5b87788856d8e7ced122fc7",
    effectiveAt: null,
    notes:
      "First recorded revision. Presented alongside the Terms because section 18 makes the two the entire agreement, so accepting one without the other would leave the agreement incomplete on its own terms.",
  }),
];

/**
 * The files under `legal/` that are NOT consent documents.
 *
 * Enumerated so that adding a legal document is a decision rather than a file
 * appearing. `legal-versions.test.ts` reconciles the directory against this list
 * plus `CONSENT_DOCUMENTS` in both directions, so a new `legal/eula.md` that
 * nobody wired into the gate fails the build instead of sitting there
 * unpresented.
 */
export const NON_CONSENT_LEGAL_FILES: readonly string[] = [
  // Upstream attribution obligations. Facts about what clients must render, not
  // an agreement a user enters into.
  "attribution.md",
  // How to work on the documents in this directory.
  "README.md",
  // The placeholder scanner.
  "check-publication-blockers.mjs",
];

/**
 * Canonicalises a document before hashing it.
 *
 * Three normalisations, each earning its place by removing a change that is
 * provably not a revision:
 *
 *   CRLF -> LF              a checkout on Windows is not an amendment.
 *   trailing whitespace     prettier strips it; a formatter run is not an
 *                           amendment either, and a digest that moved every time
 *                           `pnpm format` ran would be ignored within a week.
 *   trailing newlines       an editor adding or removing the final newline is not
 *                           an amendment.
 *
 * Nothing else is touched. In particular leading whitespace, blank lines between
 * paragraphs and the wrapping of a sentence are all significant, because they
 * change what a reader sees and this digest exists to pin what a reader saw.
 */
export function normalizeLegalText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "\n");
}

/** sha256 of the normalized document, lowercase hex. */
export function legalDigest(raw: string): string {
  return createHash("sha256")
    .update(normalizeLegalText(raw), "utf8")
    .digest("hex");
}

/**
 * The `**Version:**` line a document declares about itself.
 *
 * Parsed rather than trusted so the registry above and the document a reader
 * opens cannot disagree. A document whose header says DRAFT-1 while the API
 * records acceptances of DRAFT-0 would make every consent row cite a version that
 * does not exist in the text it names.
 */
export function declaredVersion(raw: string): string | null {
  const match = /^\*\*Version:\*\*\s*(\S+)/m.exec(raw);
  return match?.[1] ?? null;
}

/** The highest epoch a subject has accepted, per document id. */
export type AcceptedEpochs = Readonly<Record<string, number>>;

export type ConsentGapReason =
  /**
   * The subject has accepted NOTHING for at least one required document. There
   * is no contract at all, so nothing they do is licensed.
   */
  | "never-accepted"
  /**
   * The subject accepted an earlier epoch of every required document and at
   * least one has since had a material revision. An earlier contract exists and
   * still governs; what is missing is assent to its replacement.
   */
  | "revision-pending";

export interface ConsentGap {
  readonly satisfied: boolean;
  readonly reason: ConsentGapReason | null;
  /** Documents whose current epoch this subject has not accepted. */
  readonly outstanding: readonly LegalDocument[];
}

const SATISFIED: ConsentGap = {
  satisfied: true,
  reason: null,
  outstanding: [],
};

/**
 * What a subject still owes.
 *
 * Pure, and takes the document set as a parameter rather than reading the module
 * constant, for one reason that matters more than testability in general: the
 * only way to prove "a material revision makes an existing user owe again, and a
 * typo fix does not" is to run the same subject against two different registries.
 * A function that closed over the real one could not be tested for the behaviour
 * it exists to provide.
 *
 * The two reasons are not interchangeable and the caller enforces them
 * differently; see the gate in plugins/auth.ts.
 */
export function consentGap(
  documents: readonly LegalDocument[],
  accepted: AcceptedEpochs,
): ConsentGap {
  const outstanding: LegalDocument[] = [];
  let anyNeverAccepted = false;

  for (const doc of documents) {
    const have = accepted[doc.id];
    if (have === undefined) {
      anyNeverAccepted = true;
      outstanding.push(doc);
      continue;
    }
    if (have < doc.consentEpoch) outstanding.push(doc);
  }

  if (outstanding.length === 0) return SATISFIED;
  return {
    satisfied: false,
    reason: anyNeverAccepted ? "never-accepted" : "revision-pending",
    outstanding,
  };
}

/** A published document as it appears on the wire. Matches `legalDocumentSchema`. */
export interface WireLegalDocument {
  readonly documentId: string;
  readonly version: string;
  readonly consentEpoch: number;
  readonly contentSha256: string;
  readonly url: string;
  readonly effectiveAt: string | null;
  readonly publishedAt: string | null;
}

/**
 * Projects a registry entry for a client.
 *
 * `path` and `notes` are deliberately absent: the first is a repository layout
 * detail and the second is written for a maintainer reading the revision table,
 * not for a user reading a consent screen. `publishedAt` comes from the database
 * rather than the registry, so it is a parameter; the refusal path does not have
 * it and does not need it.
 */
export function toWireDocument(
  doc: LegalDocument,
  publishedAt: string | null = null,
): WireLegalDocument {
  return {
    documentId: doc.id,
    version: doc.version,
    consentEpoch: doc.consentEpoch,
    contentSha256: doc.contentSha256,
    url: doc.url,
    effectiveAt: doc.effectiveAt,
    publishedAt,
  };
}

/** Looks a document up by id. Null rather than throwing; the route 422s. */
export function findLegalDocument(
  documents: readonly LegalDocument[],
  id: string,
): LegalDocument | null {
  return documents.find((d) => d.id === id) ?? null;
}
