/**
 * Recorded assent to the published legal documents.
 *
 * The gate itself lives in `plugins/auth.ts`, because it has to apply to every
 * authenticated route and the only way to guarantee that is to put it in the one
 * funnel every authenticated route already passes through. This service owns the
 * three things the gate cannot do for itself: publishing a revision, reading a
 * subject's history, and recording an acceptance.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REVISIONS ARE WRITTEN TO THE DATABASE AT ALL
 *
 * The registry in `lib/legal-documents.ts` is already under version control, so
 * the git log is a revision history. `ensureRevisions` copies it into
 * `legal_document_revisions` anyway, for three reasons that git does not cover:
 *
 *   1. THE OPERATOR ASKED FOR REVISIONS TO BE STORED. A consent record that
 *      references a version is only as good as our ability to say what that
 *      version WAS. "Check out the commit that was deployed in March" is not an
 *      answer anybody can rely on years later, and it is not an answer available
 *      at all from a container image with no `.git` in it. Since migration 0009
 *      the row carries the TEXT as well as the digest, which is what turns
 *      `textFor` below into a real answer instead of a lookup that can only ever
 *      succeed for whatever version happens to be current.
 *   2. IT CATCHES A DEPLOY THAT DISAGREES WITH HISTORY. If the deployed code
 *      declares a different digest or a different epoch for a version this
 *      database has already published, `ensureRevisions` REFUSES rather than
 *      inserting a second truth. That is an app rolled back past a legal
 *      revision, or two environments pointed at one database with different
 *      builds, and both are conditions where recording consent would produce
 *      evidence nobody can interpret.
 *   3. THE DATABASE ENFORCES WHAT THE REGISTRY ONLY DECLARES. The epoch guard
 *      trigger in migration 0008 refuses a regressed epoch, a skipped epoch, and
 *      either direction of materiality lie. A registry is a comment until
 *      something rejects a bad one.
 *
 * It is lazy and memoized rather than run at boot. Boot does not currently
 * require a writable database and making it require one would trade a real
 * availability property for a cosmetic ordering preference; the first consent
 * read or write is early enough, and it is the only point at which the rows
 * matter.
 * ---------------------------------------------------------------------------
 */

import type { Database } from "../lib/db.js";
import { errors } from "../lib/errors.js";
import {
  consentGap,
  findLegalDocument,
  legalDigest,
  type AcceptedEpochs,
  type ConsentGap,
  type LegalDocument,
} from "../lib/legal-documents.js";
import {
  noLegalTextSource,
  type LegalTextSource,
} from "../lib/legal-source.js";

/** One recorded acceptance, as it appears on the wire and in the receipt. */
export interface ConsentRecord {
  readonly documentId: string;
  readonly version: string;
  readonly consentEpoch: number;
  readonly contentSha256: string;
  readonly acceptedAt: string;
  readonly gate: "first-launch" | "revision";
}

/** What the client is asked to echo back for each document it displayed. */
export interface AcceptanceRequest {
  readonly documentId: string;
  readonly version: string;
  readonly contentSha256: string;
}

export interface AcceptanceContext {
  readonly userId: string;
  /** Verified from the credential. Never from the body. */
  readonly authMethod: string;
  readonly sessionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly clientBuild: string | null;
  readonly clientPlatform: string | null;
}

interface ConsentRow {
  document_id: string;
  document_version: string;
  consent_epoch: number;
  content_sha256: string;
  accepted_at: Date;
  gate: string;
}

interface RevisionRow {
  consent_epoch: number;
  content_sha256: string;
  is_material: boolean;
  published_at: Date;
  effective_at: Date | null;
  content: string | null;
}

/**
 * The canonical text of one published revision, and where it came from.
 *
 * A discriminated result rather than `string | null`, because the three outcomes
 * are answered with three different status codes and collapsing them would make
 * "we have never published that version" indistinguishable from "we published it
 * and cannot produce it", which are a 422 and a 503.
 */
export type RevisionText =
  | { readonly status: "ok"; readonly text: string; readonly digest: string }
  /** No such document, or no such version of it. Nothing was ever published. */
  | { readonly status: "unknown" }
  /**
   * The revision exists and this deployment cannot produce its bytes. Only
   * reachable for a version published by a build that predates migration 0009 and
   * whose text is no longer on disk. See the migration for why it cannot be
   * healed automatically from inside the database.
   */
  | { readonly status: "unavailable"; readonly reason: string };

export class LegalConsentService {
  readonly #db: Database;
  readonly #documents: readonly LegalDocument[];
  readonly #publishedDocuments: readonly LegalDocument[];
  readonly #source: LegalTextSource;
  #published: Promise<void> | null = null;

  constructor(
    db: Database,
    documents: readonly LegalDocument[],
    /**
     * Where the canonical bytes come from at publish time.
     *
     * Defaults to producing nothing, so a test registry of synthetic documents
     * that point at files which do not exist publishes exactly as it did before
     * this parameter existed. A deployment passes the filesystem source; see
     * wiring.ts.
     */
    source: LegalTextSource = noLegalTextSource,
    /**
     * Documents this deployment PUBLISHES but does not require acceptance of.
     *
     * Exactly one thing is in here today: `CONSENT_PRESENTATION`, the copy of the
     * consent screen. See `lib/legal-documents.ts` for why it is published and
     * recorded like a document and never accepted like one.
     *
     * A SEPARATE LIST RATHER THAN A FLAG ON `LegalDocument`, and the reason is
     * that `documents` is read by `gapFor`, by the gate in plugins/auth.ts, by
     * `GET /v1/me/consent` and by most of the consent suite, all of which mean
     * "the set a subject can owe". A boolean on the entries would leave every one
     * of those call sites correct only as long as each remembered to filter. An
     * additive second list cannot be forgotten, because forgetting it means the
     * document is not published at all, which is loud.
     *
     * Defaults to empty, so a test registry publishes precisely what it declares.
     */
    alsoPublished: readonly LegalDocument[] = [],
  ) {
    this.#db = db;
    this.#documents = documents;
    this.#publishedDocuments = [...documents, ...alsoPublished];
    this.#source = source;
  }

  /**
   * The documents this deployment requires ACCEPTANCE of.
   *
   * Read by the gate, by `gapFor`, and by `GET /v1/me/consent`. Deliberately
   * narrower than `publishedDocuments`: a document in the wider set can never put
   * a subject into an outstanding state, because this is the only list
   * `consentGap` is ever given.
   */
  get documents(): readonly LegalDocument[] {
    return this.#documents;
  }

  /**
   * Every document this deployment PUBLISHES, accepted or not.
   *
   * What the document routes resolve a slug against, and what `ensureRevisions`
   * writes. A superset of `documents`.
   */
  get publishedDocuments(): readonly LegalDocument[] {
    return this.#publishedDocuments;
  }

  /**
   * Publishes every registry entry that this database has not seen, and refuses
   * to proceed if one it HAS seen no longer agrees.
   *
   * Memoized on success only. A failure clears the memo so the next request
   * retries: a transient database error must not permanently poison the consent
   * surface of a running process.
   */
  async ensureRevisions(): Promise<void> {
    this.#published ??= this.#publish().catch((err: unknown) => {
      this.#published = null;
      throw err;
    });
    await this.#published;
  }

  async #publish(): Promise<void> {
    for (const doc of this.#publishedDocuments) {
      // The canonical bytes, if this deployment can produce them. Null is not a
      // failure: the digest is what the gate enforces and it comes from the
      // registry, so a deployment with no `legal/` directory still refuses
      // un-accepted subjects correctly. What it cannot do is SERVE the document,
      // which routes/v1/legal.ts reports as a 503 rather than hiding.
      const text = this.#source(doc);

      // Insert first, then read back, rather than read-then-insert. Two
      // processes starting together would both see "absent" and both insert;
      // ON CONFLICT DO NOTHING makes the loser a no-op instead of a 500, and
      // the read-back below is what verifies agreement either way.
      await this.#db.query(
        `INSERT INTO legal_document_revisions
           (document_id, version, consent_epoch, content_sha256, is_material,
            url, effective_at, notes, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (document_id, version) DO NOTHING`,
        [
          doc.id,
          doc.version,
          doc.consentEpoch,
          doc.contentSha256,
          doc.material,
          doc.url,
          doc.effectiveAt,
          doc.notes,
          text,
        ],
      );

      const { rows } = await this.#db.query<RevisionRow>(
        `SELECT consent_epoch, content_sha256, is_material, published_at,
                effective_at, content
           FROM legal_document_revisions
          WHERE document_id = $1 AND version = $2`,
        [doc.id, doc.version],
      );
      const stored = rows[0];
      /* c8 ignore next 3 -- the INSERT above guarantees a row */
      if (stored === undefined) {
        throw new Error(`legal revision ${doc.id}@${doc.version} vanished`);
      }

      // THE BACKFILL, and it is the only UPDATE this table permits.
      //
      // Reachable in one situation: this version was published by a build from
      // before migration 0009, so the row carries a digest and no text. Without
      // this the text of that version would be irrecoverable for the lifetime of
      // the database, even on a deployment that is holding it in memory right
      // now, because `ON CONFLICT DO NOTHING` above declines to touch an existing
      // row and there is no other write path.
      //
      // Safe because the trigger in migration 0009 permits ONLY null -> non-null
      // on `content` with every other column compared for equality, and the CHECK
      // on the same row permits only text whose sha256 equals the digest that was
      // fixed at insert. Supplying the wrong text is a preimage collision, not a
      // mistake. Not conditional on the digest matching in JavaScript first: the
      // source already verified it and the database verifies it again, and a
      // belt-and-braces check in between would only add a branch nothing tests.
      if (stored.content === null && text !== null) {
        await this.#db.query(
          `UPDATE legal_document_revisions SET content = $3
            WHERE document_id = $1 AND version = $2 AND content IS NULL`,
          [doc.id, doc.version, text],
        );
      }

      // THE DISAGREEMENT CHECK. Loud, and deliberately not self-healing: an
      // UPDATE here would rewrite what every consent row referencing this
      // version means, which is the one edit migration 0008's immutability
      // trigger exists to forbid.
      if (
        stored.content_sha256 !== doc.contentSha256 ||
        stored.consent_epoch !== doc.consentEpoch ||
        stored.is_material !== doc.material
      ) {
        throw new Error(
          `legal revision ${doc.id}@${doc.version} was published with digest ` +
            `${stored.content_sha256} epoch ${String(stored.consent_epoch)} material ` +
            `${String(stored.is_material)}, but this build declares digest ` +
            `${doc.contentSha256} epoch ${String(doc.consentEpoch)} material ` +
            `${String(doc.material)}. A published revision is immutable; give the ` +
            `changed document a NEW version in lib/legal-documents.ts instead of ` +
            `redefining this one.`,
        );
      }
    }
  }

  /**
   * When each registry version was first recorded by THIS database, keyed
   * `id@version`.
   *
   * Read from `legal_document_revisions` rather than from the registry on
   * purpose: the registry says what this build believes, and the point of the
   * table is to say what the system actually published and when. On a fresh
   * database the two are the same; after a rollback they are not, and the one a
   * client is shown should be the durable one.
   */
  async publishedAt(): Promise<Readonly<Record<string, string>>> {
    const { rows } = await this.#db.query<{
      document_id: string;
      version: string;
      published_at: Date;
    }>(
      `SELECT document_id, version, published_at FROM legal_document_revisions`,
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[`${row.document_id}@${row.version}`] = row.published_at.toISOString();
    }
    return out;
  }

  /**
   * The canonical text of one published version.
   *
   * THE READ IS DIGEST-VERIFIED EVEN THOUGH TWO WRITE-SIDE CONTROLS ALREADY ARE.
   * The CHECK constraint in migration 0009 and the source's own verification both
   * run before a byte is stored, so this comparison should be impossible to fail.
   * It is here because of what a failure would cost if it ever were possible: the
   * bytes this method returns are hashed by a client and echoed to
   * `POST /v1/me/consent`, which refuses a mismatch. So bytes that do not hash to
   * the recorded digest are not "slightly wrong output", they are output that
   * makes acceptance permanently impossible while looking completely normal, and
   * the 409 surfaces two calls away from the cause. One comparison converts that
   * into one specific refusal at the source.
   *
   * The database is asked first and the filesystem second, deliberately in that
   * order. `legal_document_revisions` is what this system PUBLISHED; the working
   * tree is what somebody is currently editing. For the current version the two
   * agree or the build is already failing; for a superseded version only the
   * database has it, and preferring the file would mean a mounted revision of
   * `legal/` could answer for a version it is not.
   */
  async textFor(documentId: string, version: string): Promise<RevisionText> {
    await this.ensureRevisions();

    const { rows } = await this.#db.query<{
      content: string | null;
      content_sha256: string;
    }>(
      `SELECT content, content_sha256 FROM legal_document_revisions
        WHERE document_id = $1 AND version = $2`,
      [documentId, version],
    );
    const row = rows[0];
    if (row === undefined) return { status: "unknown" };

    // Not published with its text, so fall back to the working tree, but ONLY for
    // the version the registry currently declares: the file holds one revision and
    // it is that one. `fileSystemLegalSource` compares its digest to the
    // registry's before returning anything, so this cannot serve a mounted copy of
    // `legal/` in place of a version it is not.
    const current = findLegalDocument(this.#publishedDocuments, documentId);
    const text =
      row.content ??
      (current?.version === version ? this.#source(current) : null);

    if (text === null) {
      return {
        status: "unavailable",
        reason:
          `${documentId} ${version} was published with digest ${row.content_sha256} ` +
          `but its text is not stored on this deployment and is not the version on disk`,
      };
    }

    const digest = legalDigest(text);
    if (digest !== row.content_sha256) {
      /* c8 ignore next 5 -- excluded by the CHECK constraint and by the source */
      return {
        status: "unavailable",
        reason:
          `${documentId} ${version} resolved to text hashing to ${digest}, but the ` +
          `published revision records ${row.content_sha256}`,
      };
    }

    return { status: "ok", text, digest };
  }

  /** The highest epoch this subject has accepted, per document. */
  async acceptedEpochs(userId: string): Promise<AcceptedEpochs> {
    const { rows } = await this.#db.query<{
      document_id: string;
      epoch: string;
    }>(
      `SELECT document_id, max(consent_epoch)::text AS epoch
         FROM legal_consents
        WHERE user_id = $1
        GROUP BY document_id`,
      [userId],
    );
    const accepted: Record<string, number> = {};
    for (const row of rows) accepted[row.document_id] = Number(row.epoch);
    return accepted;
  }

  /** Every acceptance this subject has ever recorded, newest first. */
  async history(userId: string): Promise<readonly ConsentRecord[]> {
    const { rows } = await this.#db.query<ConsentRow>(
      `SELECT document_id, document_version, consent_epoch, content_sha256,
              accepted_at, gate
         FROM legal_consents
        WHERE user_id = $1
        ORDER BY accepted_at DESC, document_id ASC`,
      [userId],
    );
    return rows.map(toRecord);
  }

  /** What this subject still owes, computed against this deployment's registry. */
  gapFor(accepted: AcceptedEpochs): ConsentGap {
    return consentGap(this.#documents, accepted);
  }

  /**
   * Records acceptance of one or more documents.
   *
   * THREE THINGS ARE VALIDATED BEFORE ANYTHING IS WRITTEN, and each one refuses a
   * different way of recording evidence that would not survive being read.
   *
   *   Unknown document      422. A slug we do not publish cannot have been shown.
   *   Wrong version         409. The client is holding a copy we have superseded.
   *                         Retryable after it re-reads GET /v1/me/consent, which
   *                         is why it is a conflict rather than a validation
   *                         error.
   *   Wrong digest          409. THE ONE THAT EARNS ITS KEEP. The client must echo
   *                         the digest of the bytes it displayed, and it must
   *                         match the bytes we publish for that version.
   *
   * What the digest check does NOT do, stated plainly so nobody relies on it for
   * more: it cannot prove a human read anything, and a client that wanted to lie
   * could fetch the document, hash it, and never render it. No server-side control
   * can close that, which is exactly why section 1 of the Terms keeps its `[OPEN]`
   * marker until a client presents the screen. What it DOES close is the realistic
   * failure: a client shipping a stale bundled copy of the Terms and having its
   * acceptances recorded against text the user never saw. That would produce a
   * table full of records asserting assent to the current version from users who
   * were shown the previous one, which is worse than no record at all because it
   * is confidently wrong.
   *
   * `gate` is derived from the subject's own history rather than taken from the
   * body, so a client cannot claim it presented a first-launch screen to a user
   * who was really being shown a revision notice.
   */
  async record(
    ctx: AcceptanceContext,
    requested: readonly AcceptanceRequest[],
  ): Promise<readonly ConsentRecord[]> {
    await this.ensureRevisions();

    const resolved = requested.map((req) => {
      const doc = findLegalDocument(this.#documents, req.documentId);
      if (doc === null) {
        throw errors.unprocessable(
          `"${req.documentId}" is not a document Pull.fm asks you to accept.`,
          [{ field: "accept.documentId", message: "unknown document" }],
        );
      }
      if (req.version !== doc.version) {
        throw errors.conflict(
          `The current version of ${doc.id} is ${doc.version}, not ${req.version}. ` +
            `Fetch GET /v1/me/consent, display the current document, and accept that.`,
        );
      }
      if (req.contentSha256 !== doc.contentSha256) {
        throw errors.conflict(
          `The digest supplied for ${doc.id} ${doc.version} does not match the document ` +
            `Pull.fm publishes at that version, so the text displayed was not the text ` +
            `this acceptance would have been recorded against. Re-fetch the document ` +
            `from ${doc.url} and accept the copy you displayed.`,
        );
      }
      return doc;
    });

    const priorEpochs = await this.acceptedEpochs(ctx.userId);

    const recorded: ConsentRecord[] = [];
    for (const doc of resolved) {
      // Per document, not per request: a user accepting the Terms for the first
      // time and re-accepting a revised privacy policy in one call is being
      // shown two different screens, and the row should say which.
      const gate: ConsentRecord["gate"] =
        priorEpochs[doc.id] === undefined ? "first-launch" : "revision";

      // DO NOTHING, never DO UPDATE. A second acceptance of a version already
      // accepted must not move `accepted_at` forward: the first acceptance is
      // when the contract formed, and overwriting it would replace the answer to
      // the only question the row exists to answer.
      const { rows } = await this.#db.query<ConsentRow>(
        `INSERT INTO legal_consents
           (user_id, document_id, document_version, consent_epoch, content_sha256,
            gate, client_build, client_platform, user_agent, ip, auth_method, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (user_id, document_id, document_version) DO NOTHING
         RETURNING document_id, document_version, consent_epoch, content_sha256,
                   accepted_at, gate`,
        [
          ctx.userId,
          doc.id,
          doc.version,
          doc.consentEpoch,
          doc.contentSha256,
          gate,
          ctx.clientBuild,
          ctx.clientPlatform,
          ctx.userAgent,
          ctx.ip,
          ctx.authMethod,
          ctx.sessionId,
        ],
      );
      const row = rows[0];
      if (row !== undefined) recorded.push(toRecord(row));
    }

    return recorded;
  }

  /**
   * The receipt that outlives the account.
   *
   * Read by the deletion cascade before it destroys the rows, and stored in
   * `deletion_log.consents`. Deliberately narrower than `history`: no IP, no user
   * agent, no session id, no client build. Migration 0008 argues why the full row
   * cascades away and this summary does not.
   */
  async receiptFor(userId: string): Promise<readonly ConsentRecord[]> {
    const { rows } = await this.#db.query<ConsentRow>(
      `SELECT document_id, document_version, consent_epoch, content_sha256,
              accepted_at, gate
         FROM legal_consents
        WHERE user_id = $1
        ORDER BY accepted_at ASC`,
      [userId],
    );
    return rows.map(toRecord);
  }
}

function toRecord(row: ConsentRow): ConsentRecord {
  return {
    documentId: row.document_id,
    version: row.document_version,
    consentEpoch: row.consent_epoch,
    contentSha256: row.content_sha256,
    acceptedAt: row.accepted_at.toISOString(),
    gate: row.gate === "first-launch" ? "first-launch" : "revision",
  };
}
