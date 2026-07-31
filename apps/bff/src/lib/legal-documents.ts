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
    version: "DRAFT-1",
    consentEpoch: 1,
    material: true,
    contentSha256:
      "180d130e2d6f5e5d8bd66e89015588ce0692d858bc655d432ab15dfe25923963",
    effectiveAt: null,
    notes:
      "DRAFT-1 rewrites section 17 (Changes to these Terms). MATERIAL: it changes how an amendment binds, which is as substantive as a clause gets. DRAFT-0 said 'Continuing to use Pull.fm after a change takes effect means you accept it', which failed on two counts. It is the arrangement rejected in Sgouros v. TransUnion Corp., 817 F.3d 1029 (7th Cir. 2016), binding over Illinois and therefore over these Terms. And it described a WEAKER mechanism than the code implements: the consent epoch in this registry refuses writes until a material revision is affirmatively accepted, so the service never infers agreement from continued use. The clause simultaneously leaned on a rejected theory and understated the control that makes the theory unnecessary. EPOCH STAYS 1 because DRAFT-0 was never published: both live databases hold zero revisions and zero consents, so there is no acceptance to invalidate and no predecessor for this to supersede. The BEFORE INSERT guard in migration 0008 requires a document's first revision to be epoch 1 and material, which this is. Raising it to 2 would assert this supersedes a publication users accepted, and the guard would refuse. Still NOT YET EFFECTIVE pending legal review, hence effectiveAt null.",
  }),
  consentDocument({
    id: "privacy-policy",
    path: "legal/privacy-policy.md",
    version: "DRAFT-1",
    consentEpoch: 1,
    material: true,
    contentSha256:
      "f18244518ebddf6d0c2a45a7740835e92dfdce7a51d2c23ef6b6f9846843782b",
    effectiveAt: null,
    notes:
      "Residency and retention corrections after the 2026-07-29 cutover out of the European Union. THE CHANGE IS MATERIAL and is recorded as such: three factual disclosures about the user's own data moved. Backups went from an EU-pinned bucket to object storage pinned to NO jurisdiction, so the true claim is 'not EU-pinned' and never 'stored in the United States'; the point-in-time-recovery window went from 6 hours to 7 days, a 28-fold increase in how long deleted data stays restorable; and the four processor agreements became executed and dated. WHY THE EPOCH IS 1 AND NOT 2, since material normally means +1: DRAFT-0 was never published. It was checked rather than assumed - `legal_document_revisions` is empty on staging, the table does not yet exist on prod, and `legal_consents` holds zero rows in both - so there is no first publication for this to supersede and no acceptance anywhere for a raised epoch to invalidate. DRAFT-1 IS the first revision, which the epoch guard in migration 0008 requires to be epoch 1 and material, and epoch 2 is refused by that trigger for exactly this reason. Recording material: true is what keeps this from being a precedent that residency corrections are cosmetic; the epoch is 1 because nothing preceded it, not because the change was small. EDITED IN PLACE ON 2026-07-30, VERSION DELIBERATELY HELD, after an audit of section 10 against the United States state privacy statutes. What changed: Connecticut now has its own subsection, because Public Act 25-113 took effect on 2026-07-01 and removed the volume threshold from two of the CTDPA's three applicability triggers, which means the surrounding 'below the threshold' reasoning does not reach it and the real reason Pull.fm is outside it is the absence of sensitive data. That subsection carries an [OPEN] marker for the question counsel has to answer, whether listening history is data 'revealing' religious belief or sexual orientation within that definition, which section 3.6 already concedes is arguable. Also added: a 'Checked, and deliberately not implemented' subsection recording that Global Privacy Control, ADMT disclosure and the CCPA disclosure set were each examined and each correctly omitted, so a later reader does not re-open them; Rhode Island named as the lowest numeric bar in the country and therefore the first threshold growth would cross; and the current CPI-adjusted CCPA revenue figure quoted for orientation only, with the statutory figure kept as the operative one because the adjustment is automatic. HELD AT DRAFT-1 RATHER THAN BUMPED, on the precedent recorded under consent-presentation: editing an unpublished draft in place is not a revision, ensureRevisions only refuses REDEFINING a published version, DRAFT-1 has existed in a single commit since 2026-07-29, and both live databases hold zero revisions. The stronger reason not to bump is that DRAFT-2 would be the FIRST row in legal_document_revisions, which the epoch guard in migration 0008 requires to be epoch 1 AND material, and this change is cosmetic under this document's own rubric because it moves no factual disclosure about a user's own data - it is legal analysis about which statutes reach the operator. Bumping would therefore have forced a material: true label invented to satisfy a guard rather than because the change was material. NOTE THE GAP THIS EXPOSES, which is recorded rather than worked around: the 'Highlights checked against' interlock pins id@version, so an in-place edit of an unpublished draft does not turn the consent screen red the way a version bump would. Here that is harmless, because section 3.1 of consent-presentation quotes the Terms and no section number in this document moved, but the interlock is weaker than it reads and should be digest-pinned rather than version-pinned.",
  }),
];

/**
 * The copy of the consent screen itself: what a person is shown and asked.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A THIRD CATEGORY AND NOT ONE OF THE TWO THAT ALREADY EXISTED
 *
 * `Sgouros v. TransUnion Corp.`, 817 F.3d 1029 (7th Cir. 2016) found no contract
 * formed under Illinois law - the law section 16 of the Terms selects - for a PAID
 * purchase on a page that DISPLAYED the terms, because the interface did not
 * communicate that proceeding was assent. So the sentence above the button and the
 * label on the button are the evidence that assent was communicated, and
 * "Continue" and "I agree to the Terms" are not legally equivalent. A change to
 * that copy can therefore be as material as a change to a clause, and it has to be
 * versioned, digest-locked and recorded on the same terms rather than living in a
 * client's string table where nobody would ever decide what a change meant.
 *
 * Neither existing shape does that:
 *
 *   CONSENT_DOCUMENTS        Circular. Asking a person to accept the words with
 *                            which they are being asked to accept needs its own
 *                            presentation, which needs its own acceptance. It
 *                            would also put every existing user into an
 *                            outstanding state and make the screen list itself
 *                            among the documents it was presenting.
 *   NON_CONSENT_LEGAL_FILES  An escape hatch meaning "not part of the gate, ignore
 *                            it". It records no version, no digest and no epoch,
 *                            so the copy could change with nobody deciding what
 *                            the change meant. That is the failure to avoid, not a
 *                            way of avoiding it.
 *
 * So: PUBLISHED AND RECORDED LIKE A DOCUMENT, NEVER ACCEPTED LIKE ONE. It is
 * absent from `CONSENT_DOCUMENTS`, so `consentGap` never counts it and no subject
 * can ever owe it; it is present in `PUBLISHED_DOCUMENTS`, so `ensureRevisions`
 * writes it into `legal_document_revisions` and it inherits the append-only
 * trigger, the epoch guard, and the digest CHECK from migration 0009. It is served
 * at its own versioned URL forever, which is what lets a third party read the
 * exact words that were live on a given date without repository access and without
 * trusting us about them.
 *
 * FIRST REVISION, SO EPOCH 1 AND MATERIAL, which the epoch guard requires of any
 * document's first row and which is also just true: there is no earlier
 * publication of this copy for an acceptance to carry over from. The epoch is
 * recorded and is deliberately never compared, because nothing is gated on it; it
 * exists so that the NEXT revision has something to be material relative to.
 * ---------------------------------------------------------------------------
 */
export const CONSENT_PRESENTATION: LegalDocument = consentDocument({
  id: "consent-presentation",
  path: "legal/consent-presentation.md",
  version: "DRAFT-0",
  consentEpoch: 1,
  material: true,
  contentSha256:
    "a1973cb393e34433ac4c0b04e02686749cb2d22f2db0e17337c4ea88eda5e80f",
  effectiveAt: null,
  notes:
    "First recorded revision of the consent screen copy: what is displayed, what the affirmative act is, what the button says, what a decline does, and what a returning user is told after a material revision. Epoch 1 and material because it is the first revision of this document, which the epoch guard in migration 0008 requires and which is also the fact - nothing preceded it. NOT A DOCUMENT ANYBODY ACCEPTS: it is published and recorded so that a change to the words around the button is a versioned, reviewable decision rather than a client string edit, and so that the words live on a given date are retrievable afterwards. The materiality rubric for THIS document is in its own section 2 and is narrower than the other two: the question is whether the change alters whether, or to what, assent was communicated. HELD AT DRAFT-0 THROUGH THE 2026-07-30 TERMS REVISION, and the asymmetry with terms-of-service is deliberate. Section 3.1 quotes the liability caps, so the 'Highlights checked against' line had to advance from terms-of-service@DRAFT-0 to DRAFT-1, which moved this file's digest. That edit is COSMETIC under this document's own rubric: it records that a human re-read the highlights and found the quoted figures unchanged, and it alters neither what a user is shown nor what they are asked, which is the only question that makes a change to this document material. The version is held rather than bumped because DRAFT-0 has never been published anywhere: it was written on 2026-07-30, both live databases hold zero revisions, and ensureRevisions only refuses REDEFINING a published version. Editing an unpublished draft in place is not a revision. terms-of-service was bumped to DRAFT-1 instead because its DRAFT-0 has existed across many commits and may sit in a developer database, where redefining it would fail. Note also that a cosmetic bump here would be REFUSED by the epoch guard: the first revision of any document must be epoch 1 AND material, so a DRAFT-1 marked cosmetic could not be the first row.",
});

/**
 * Every document this deployment publishes, whether or not it must be accepted.
 *
 * The set `ensureRevisions` writes and the document routes serve. It is a
 * SUPERSET of `CONSENT_DOCUMENTS`, and keeping the two separate is what makes
 * "published" and "must be accepted" different properties rather than the same
 * one by accident. `consentGap` is only ever given `CONSENT_DOCUMENTS`, so a
 * document added here cannot make a subject owe anything.
 */
export const PUBLISHED_DOCUMENTS: readonly LegalDocument[] = [
  ...CONSENT_DOCUMENTS,
  CONSENT_PRESENTATION,
];

/**
 * The files under `legal/` that are NOT published documents at all.
 *
 * Enumerated so that adding a legal document is a decision rather than a file
 * appearing. `legal-versions.test.ts` reconciles the directory against this list
 * plus `PUBLISHED_DOCUMENTS` in both directions, so a new `legal/eula.md` that
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

/**
 * The `**Highlights checked against:**` line, parsed into `id@version` pairs.
 *
 * WHY THIS EXISTS AND WHY IT IS PARSED RATHER THAN TRUSTED
 *
 * `legal/consent-presentation.md` section 3.1 quotes specific figures and specific
 * section numbers out of the Terms: the USD 100 and USD 50 caps from section 13,
 * the beneficiary grant in section 9, the venue in section 16, the territory in
 * section 2. That makes it the one document in `legal/` that is DERIVATIVE OF A
 * SPECIFIC VERSION OF ANOTHER ONE, and it introduces a failure the digest lock
 * cannot see: a Terms revision that moved the cap or renumbered a section leaves
 * this file byte-identical, so its digest still matches, while the copy it
 * specifies now states a false figure to every new user at the moment of
 * formation.
 *
 * So the file declares which versions its highlights were read against, and
 * `legal-versions.test.ts` compares that declaration to the registry. Bumping the
 * Terms turns this document red until somebody has re-read section 3.1 against the
 * new text, which is the same interlock the digest provides, applied to a
 * dependency the digest cannot reach.
 *
 * Returns null when the line is absent, so the test can say so specifically rather
 * than failing on an empty comparison.
 */
/**
 * THE PIN CARRIES A DIGEST BECAUSE A VERSION WAS NOT ENOUGH.
 *
 * This declared `id@version` until 2026-07-30, and a version only moves when
 * somebody decides to move it. An UNPUBLISHED draft is edited in place: the
 * documented precedent in this repository is that redefining a version nobody
 * has ever been served is not a revision, so `DRAFT-1` can mean different bytes
 * on two different days. Both consent documents were rewritten twice that day
 * without their versions changing, and this interlock stayed green through all
 * of it, certifying as re-read a set of figures sitting in text nobody had
 * re-read.
 *
 * That is the defect the digest lock exists to prevent, reintroduced one layer
 * up: a check that reports success because the thing it compares did not happen
 * to be the thing that changed.
 *
 * So the pin is `id@version#digest`, where the digest is a prefix of the
 * content hash the registry holds. A prefix rather than all 64 characters
 * because this line is read by people and a wrapped hash is a line nobody
 * checks; twelve hex characters is 48 bits, far past coincidence for a drift
 * check and not defending against a crafted collision. The registry keeps the
 * full digest either way.
 *
 * An entry written in the old `id@version` form is returned with
 * `digest: null`, which the test rejects by name: silently accepting it would
 * restore exactly the hole this closes.
 */
export interface HighlightSource {
  readonly version: string;
  /** Prefix of the source document's content digest, or null in the old form. */
  readonly digest: string | null;
}

export function declaredHighlightSources(
  raw: string,
): Readonly<Record<string, HighlightSource>> | null {
  const line = /^\*\*Highlights checked against:\*\*\s*(.+)$/m.exec(raw);
  if (line === null) return null;
  const out: Record<string, HighlightSource> = {};
  for (const [, id, version, digest] of line[1]?.matchAll(
    /`([a-z][a-z0-9-]{2,63})@([A-Za-z0-9][A-Za-z0-9._-]{0,63}?)(?:#([0-9a-f]{8,64}))?`/g,
  ) ?? []) {
    if (id === undefined || version === undefined) continue;
    out[id] = { version, digest: digest ?? null };
  }
  return out;
}

/**
 * How much of a content digest the `Highlights checked against` line carries.
 *
 * Twelve is a floor rather than a format: a longer prefix in the document is
 * accepted and compared at this length, so writing a more careful line later
 * does not invalidate it.
 */
export const HIGHLIGHT_DIGEST_PREFIX = 12;

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
