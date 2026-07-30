/**
 * The published legal documents, served as the exact bytes their digests cover.
 *
 * WHAT WAS WRONG
 *
 * The consent gate landed complete except for the door. `GET /v1/me/consent`
 * reported, per document, a `version`, a `contentSha256` and a `url`, and
 * `POST /v1/me/consent` required the client to echo the version AND the digest,
 * answering 409 on a mismatch so a stale bundled copy could not be recorded as
 * assent to text the user never saw. NOTHING SERVED THE DOCUMENTS. There was no
 * endpoint behind `url`.
 *
 * So the agreements process was unusable in both directions at once. A client
 * could not display what it was asking a person to agree to, which is the half of
 * `Sgouros v. TransUnion Corp.` (817 F.3d 1029, 7th Cir. 2016) that no server can
 * perform on its own; and it could not produce a digest the API would accept, so
 * even a client that had the text bundled could not record anything. A gate that
 * refuses everybody is not a control, it is an outage with a legal justification.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BYTES ARE MARKDOWN AND WHY THERE IS NO SECOND REPRESENTATION
 *
 * `POST /v1/me/consent` compares the digest the client echoes to the digest of the
 * published text. That single fact removes rendering as an option rather than
 * making it merely inconsistent: a client that fetched a prettified HTML page,
 * hashed what it displayed and posted the result would be refused with a 409 every
 * time, with nothing distinguishing that from a genuinely stale copy. A second
 * representation of a hashed document is a representation NOBODY CAN ACCEPT.
 *
 * So exactly one representation exists, it is `text/markdown`, and it is the
 * markdown source. A client that wants a rendered document renders it locally from
 * bytes it has already verified. That is also the only side rendering belongs on:
 * this API sets `default-src 'none'` because it returns no markup, and returning
 * HTML generated from hand-edited text on an unauthenticated endpoint would give
 * up that property for a convenience the client does not need.
 *
 * ---------------------------------------------------------------------------
 * THE BYTES ARE SERVED PRE-NORMALISED, WHICH IS THE POINT OF THE WHOLE FILE
 *
 * The registry digest is sha256 over `normalizeLegalText(source)`: CRLF folded to
 * LF, trailing whitespace stripped per line, trailing newlines collapsed to one.
 * A server that returned the raw file would be correct - normalisation is
 * idempotent, so the raw file and its normalised form hash the same - but it would
 * push the normalisation onto every client, in every language, and a client that
 * got any one of the three rules wrong would compute a digest that is refused with
 * a message about a stale copy. That is a bug report nobody can diagnose.
 *
 * What is served instead is the NORMALISED text, which is a fixed point of the
 * normalisation. The consequence is the contract a client actually wants:
 *
 *     sha256(response body as received) == contentSha256
 *
 * with no preprocessing at all. Both properties are asserted in
 * test/integration/legal-documents.test.ts, iterating the registry rather than a
 * hard-coded list, so a newly registered document cannot be silently unserved.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ROUTES ARE UNAUTHENTICATED
 *
 * Because a person has to read the Terms BEFORE they have an account. Section 1
 * of the Terms and SeatGeek API Terms clause 4.3 both require acceptance before
 * use, so the document has to be reachable by a caller with no credential; an
 * authenticated-only document endpoint would mean the only way to see what you are
 * agreeing to is to agree to it first.
 *
 * Weighed against `GET /v1/config` being deliberately coarse for reconnaissance
 * reasons (API9), the answer is still public, and easily. What these routes
 * disclose is a published contract and a published privacy notice - documents
 * whose entire purpose is to be read by strangers, which name no user, no
 * identifier and no internal component, and which say nothing about this
 * deployment that the documents themselves do not already say in prose. There is
 * no version of "keep the terms of service confidential" that is either coherent
 * or defensible.
 *
 * `ensureRevisions()` runs on these routes, which means an anonymous request can
 * trigger the lazy publish. That is bounded and deliberate: it is memoized per
 * process, it is `ON CONFLICT DO NOTHING` over the two rows of the compiled
 * registry, and the alternative is a public endpoint that reports a
 * `publishedAt` the publication table has not recorded yet.
 *
 * ---------------------------------------------------------------------------
 * CACHING, WHICH IS UNUSUALLY EASY HERE AND WORTH GETTING RIGHT
 *
 * A version is immutable by construction: a changed document gets a new version,
 * because that is the only way to make `ensureRevisions` accept it. So the two
 * shapes get opposite policies, and the difference is not a tuning preference:
 *
 *   /v1/legal/{id}/versions/{version}   immutable. `max-age` of a year plus
 *                                       `immutable`. The bytes behind this URL
 *                                       cannot change, so a revalidation could
 *                                       only ever return 304.
 *   /v1/legal/{id}  and  /v1/legal      a MOVING POINTER. `no-cache`, so a shared
 *                                       cache may store it but must revalidate
 *                                       before reuse. A stale answer here hands a
 *                                       client superseded text alongside a stale
 *                                       version number, and while the 409 on
 *                                       acceptance makes that recoverable, it is
 *                                       recoverable by confusing somebody.
 *
 * The ETag IS THE CONTENT DIGEST, which is the strongest validator available and
 * one we already hold: it is not a timestamp, not a weak hash of a serialisation,
 * and not an opaque counter, but the same value the client is about to compare
 * against `contentSha256`. `public` accompanies both because none of this is
 * per-subject, which is also why these are the only routes in the API that
 * deliberately step around the `private, no-store` default in server.ts.
 * ---------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";

import { ApiError } from "../../lib/errors.js";
import {
  findLegalDocument,
  legalVersionPath,
  LEGAL_CONTENT_TYPE,
  toWireDocument,
  type LegalDocument,
} from "../../lib/legal-documents.js";
import { annotate } from "../../lib/openapi.js";
import { legalDocumentSchema, problemResponses } from "../../lib/schemas.js";
import type { RevisionText } from "../../services/legal-consent.js";
import type { Services } from "../deps.js";

/**
 * A year, plus `immutable`.
 *
 * Safe only because the URL names a version. `ensureRevisions` refuses a build
 * that redefines a published version's digest, so "the bytes at this URL never
 * change" is enforced rather than promised.
 */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/**
 * Storable, but revalidate before reuse.
 *
 * `no-cache` rather than `no-store`: there is nothing private here, so throwing
 * the body away entirely would spend bandwidth on every read of a document that
 * changes a handful of times in a product's life. The conditional request costs
 * one round trip and the ETag makes the answer a 304.
 */
const REVALIDATE_CACHE = "public, no-cache";

/** Shape-constrained to match `legal_document_revisions_id_shape_chk`. */
const documentIdParam = {
  type: "string",
  maxLength: 64,
  pattern: "^[a-z][a-z0-9-]{2,63}$",
  description: "Document slug, as reported by GET /v1/legal.",
} as const;

/** Shape-constrained to match `legal_document_revisions_version_shape_chk`. */
const versionParam = {
  type: "string",
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
  description:
    "A publication version. Any version ever published remains retrievable, which is what makes a consent row citing it checkable.",
} as const;

/**
 * The document body, declared as a `text/markdown` response.
 *
 * Declared rather than omitted, and the trade is worth recording because the
 * alternative was tempting. `/metrics` declares no response schema at all and
 * sets its content type on the reply, which works; but an operation with no
 * declared 200 appears in the OpenAPI document as a route that returns nothing,
 * and this is the one route in the API whose response body is the entire product
 * of the feature. Declaring it under a `content` map rather than as a bare schema
 * is what keeps `fast-json-stringify` out of the way: Fastify selects a serialiser
 * per content type, so a `text/markdown` body is passed through as the string it
 * is rather than being JSON-encoded into `"# Pull.fm..."`. Verified against
 * Fastify 5 before this shape was chosen.
 */
const markdownResponse = {
  description:
    "The canonical document, pre-normalised, as the exact bytes contentSha256 covers. sha256 over this body as received equals contentSha256 with no preprocessing.",
  content: {
    "text/markdown": {
      schema: {
        type: "string",
        description: "CommonMark source. The only canonical representation.",
      },
    },
  },
} as const;

/**
 * `304 Not Modified` carries no body and no schema.
 *
 * Declared so a client generating from the document knows the conditional request
 * is supported, rather than discovering it from a response it did not expect.
 */
const notModifiedResponse = {
  description:
    "The If-None-Match value matches the current content digest. No body.",
  type: "null",
} as const;

export function registerLegalRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  /**
   * What Pull.fm publishes, and how to verify it.
   *
   * The unauthenticated counterpart to the `documents` array of
   * `GET /v1/me/consent`, minus any notion of a subject. A client at first launch
   * needs this before it has an account: it cannot ask what it owes until somebody
   * has signed in, and it must not ask somebody to sign in before showing them
   * what signing in commits them to.
   *
   * `digest` is on the wire rather than only in the documentation on purpose. A
   * client has to reproduce the digest rule in whatever language it is written in,
   * and a rule that is only in prose in `docs/api/` is a rule that gets
   * reimplemented from memory. Stating the algorithm, the encoding, and the fact
   * that the served bytes are already normalised makes the endpoint answer the
   * question it exists to raise.
   */
  app.get(
    "/legal",
    {
      schema: {
        operationId: "listLegalDocuments",
        summary: "The legal documents Pull.fm publishes",
        description:
          "Public and unauthenticated: a person has to be able to read the Terms before they have an account. Reports the current version, consent epoch and content digest of every document acceptance is required for, and the URL of the exact bytes each digest covers. Cacheable but revalidated, because this is a pointer to whatever is current.",
        tags: ["legal"],
        response: {
          200: {
            type: "object",
            properties: {
              canonicalMediaType: {
                type: "string",
                description:
                  "The one representation the digests cover. There is no rendered form; render locally from bytes you have verified.",
              },
              digest: {
                type: "object",
                description:
                  "How to reproduce contentSha256 from a document you fetched.",
                properties: {
                  algorithm: { type: "string" },
                  encoding: { type: "string" },
                  normalization: { type: "string" },
                },
                required: ["algorithm", "encoding", "normalization"],
              },
              documents: {
                type: "array",
                description:
                  "The documents acceptance is REQUIRED of. Every one of these must be accepted before Pull.fm can be used; GET /v1/me/consent says which of them a given subject still owes.",
                items: legalDocumentSchema,
              },
              presentation: {
                ...legalDocumentSchema,
                description:
                  "The copy of the consent screen itself: what is displayed, what the affirmative act is, what the button says, what a decline does, and what a returning user is told after a material revision. PUBLISHED AND VERSIONED LIKE A DOCUMENT AND NOT ACCEPTED LIKE ONE, so it is a separate member rather than an entry in `documents`: nothing is ever owed for it and POST /v1/me/consent refuses it as an unknown document. A client fetches it, verifies the digest the same way, and renders it, so that the words a person was asked are a published fact rather than a claim about which build they had installed.",
              },
            },
            required: [
              "canonicalMediaType",
              "digest",
              "documents",
              "presentation",
            ],
          },
          304: notModifiedResponse,
          ...problemResponses(429, 503),
        },
        ...annotate({ authz: "public", dast: "include" }),
      },
    },
    async (request, reply) => {
      await services.legal.ensureRevisions();
      const published = await services.legal.publishedAt();
      const presentation = requirePresentation(services);

      const body = {
        canonicalMediaType: LEGAL_CONTENT_TYPE,
        digest: {
          algorithm: "sha256",
          encoding: "hex",
          normalization:
            "The bytes served at each url are ALREADY normalised, so sha256 over the response " +
            "body exactly as received equals contentSha256 and no preprocessing is needed. The " +
            "normalisation the digest is defined over, for anyone hashing a copy obtained some " +
            "other way: CR and CRLF folded to LF, spaces and tabs stripped from the end of every " +
            "line, and trailing newlines collapsed to exactly one.",
        },
        documents: services.legal.documents.map((doc) =>
          toWireDocument(doc, published[`${doc.id}@${doc.version}`] ?? null),
        ),
        // A member of its own rather than a third entry in `documents`, and the
        // distinction is load-bearing in both directions: a client that iterated
        // `documents` and asked a person to accept all of them would ask for
        // assent to the words with which it was asking, and POST /v1/me/consent
        // would answer 422 because the gate has never heard of this slug.
        presentation: toWireDocument(
          presentation,
          published[`${presentation.id}@${presentation.version}`] ?? null,
        ),
      };

      // Over the serialised body rather than over the registry, so any change a
      // client would actually observe - including a `publishedAt` appearing after
      // a fresh database publishes - moves the validator.
      const etag = quotedDigest(JSON.stringify(body));
      if (conditionalHit(request.headers["if-none-match"], etag)) {
        return notModified(reply, etag, REVALIDATE_CACHE);
      }

      return reply
        .header("cache-control", REVALIDATE_CACHE)
        .header("etag", etag)
        .send(body);
    },
  );

  /**
   * The current version of one document.
   *
   * A MOVING POINTER, and the reason it exists alongside the versioned route is
   * that something has to answer "what are the terms today" for a reader who is
   * not in the middle of a consent handshake: a link in a client's settings
   * screen, a support agent, a person who wants to reread what they agreed to.
   *
   * A client performing the handshake should NOT use this route. It should follow
   * the `url` from `GET /v1/legal` or `GET /v1/me/consent`, which names a version,
   * because a publication landing between the two calls would otherwise produce a
   * digest that does not match the one the client was told to expect. That
   * mismatch is recoverable - the 409 tells it to re-read - but it is recoverable
   * by confusing somebody, and the versioned URL has no such window.
   */
  app.get(
    "/legal/:documentId",
    {
      schema: {
        operationId: "getCurrentLegalDocument",
        summary: "The current text of a legal document",
        description:
          "Serves whatever version is current, as text/markdown. The ETag is the content digest. Use the versioned URL for a consent handshake: this one moves when a new version is published.",
        tags: ["legal"],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["documentId"],
          properties: { documentId: documentIdParam },
        },
        response: {
          200: markdownResponse,
          304: notModifiedResponse,
          // 422 rather than 404 for an unknown slug, and the reasoning is the
          // mirror image of why a wishlist item answers 404. A 404 in this API
          // means "no such object, or an object belonging to somebody else, and
          // the two are deliberately indistinguishable" - a rule that exists so
          // identifiers cannot be enumerated. There is nothing here to enumerate:
          // the complete set of documents is published, unauthenticated, at
          // GET /v1/legal. So the honest reading of an unrecognised slug is the
          // one POST /v1/me/consent already gives it - the request was understood
          // and its contents are not acceptable - and it matches, so a client sees
          // one code for "no such document" across the whole flow.
          ...problemResponses(400, 422, 429, 503),
        },
        ...annotate({ authz: "public", dast: "include" }),
      },
    },
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };
      const doc = requireDocument(
        services.legal.publishedDocuments,
        documentId,
      );
      const resolved = await services.legal.textFor(doc.id, doc.version);
      return sendDocument(reply, request.headers["if-none-match"], resolved, {
        cacheControl: REVALIDATE_CACHE,
        // Where the immutable copy of what was just served lives. A client that
        // followed the moving pointer can pin the answer without a second lookup,
        // and a log or a bug report quoting this header names an exact text.
        contentLocation: legalVersionPath(doc.id, doc.version),
      });
    },
  );

  /**
   * One specific version, forever.
   *
   * THIS IS THE ROUTE THAT MAKES A CONSENT ROW MEAN SOMETHING. `legal_consents`
   * records a `document_id`, a `document_version` and a `content_sha256`. Before
   * this existed, a row saying "this person accepted DRAFT-0, which hashed to
   * cead3bec..." became uncheckable the moment DRAFT-0 was superseded: it named a
   * text, asserted a digest over it, and nothing in the system could produce the
   * text the assertion was about. A digest with no retrievable preimage is not
   * evidence, and it reads like evidence, which is worse than nothing.
   *
   * The text comes from `legal_document_revisions.content`, written at publish
   * time by migration 0009. Git was the obvious alternative and is not available:
   * the deployed artefact is a container image with no `.git` and no git binary,
   * and an earlier attempt to read a build sha out of git at runtime returned
   * "unknown" for exactly that reason. The migration argues the trade in full,
   * including what breaks when the repository is absent.
   */
  app.get(
    "/legal/:documentId/versions/:version",
    {
      schema: {
        operationId: "getLegalDocumentVersion",
        summary: "The exact text of one published version",
        description:
          "Immutable and cacheable for a year: a changed document is published as a NEW version, never as different bytes under the same one. Every version ever published stays retrievable, including superseded ones, so an acceptance recorded against a version can still be checked against the text it names. The ETag is the content digest.",
        tags: ["legal"],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["documentId", "version"],
          properties: { documentId: documentIdParam, version: versionParam },
        },
        response: {
          200: markdownResponse,
          304: notModifiedResponse,
          ...problemResponses(400, 422, 429, 503),
        },
        ...annotate({ authz: "public", dast: "include" }),
      },
    },
    async (request, reply) => {
      const { documentId, version } = request.params as {
        documentId: string;
        version: string;
      };
      const resolved = await services.legal.textFor(documentId, version);
      return sendDocument(reply, request.headers["if-none-match"], resolved, {
        cacheControl: IMMUTABLE_CACHE,
      });
    },
  );
}

/**
 * Looks a document up, or refuses.
 *
 * Against the REGISTRY rather than the revision table, because the question this
 * route asks is "is this a document Pull.fm currently publishes", and a document
 * withdrawn from the registry should stop having a current version even though its
 * revisions remain retrievable by version.
 *
 * Given `publishedDocuments` and not `documents`, so the consent screen copy is
 * reachable at its own URL. That is the whole point of publishing it: a third
 * party reading a consent row dated in March needs the words that were live in
 * March, and "ask the operator which build was deployed" is not an answer.
 */
function requireDocument(
  documents: readonly LegalDocument[],
  documentId: string,
): LegalDocument {
  const doc = findLegalDocument(documents, documentId);
  if (doc === null) {
    throw new ApiError(
      422,
      "unprocessable",
      "Unprocessable Content",
      `"${documentId}" is not a document Pull.fm publishes. GET /v1/legal lists every one.`,
      [{ field: "documentId", message: "unknown document" }],
    );
  }
  return doc;
}

/**
 * The consent screen copy, or a 503 that says the screen cannot be presented.
 *
 * WHY THIS REFUSES RATHER THAN OMITTING THE MEMBER. `GET /v1/legal` is the one
 * call a client makes before it has an account, and the answer it needs is "here
 * are the documents, and here are the words to ask with". A response that silently
 * dropped `presentation` would leave a client with two documents and no
 * instruction, and the most likely thing a client would then do is fall back to
 * copy of its own - which is the failure this document exists to prevent, arriving
 * as a graceful degradation.
 *
 * Only reachable if a deployment constructs the service without the presentation
 * document at all, which wiring.ts does not do. It is a wiring fault, so it reads
 * as one.
 */
function requirePresentation(services: Services): LegalDocument {
  const accepted = new Set(services.legal.documents.map((doc) => doc.id));
  const presentation = services.legal.publishedDocuments.find(
    (doc) => !accepted.has(doc.id),
  );
  /* c8 ignore next 8 -- wiring.ts always supplies CONSENT_PRESENTATION */
  if (presentation === undefined) {
    throw new ApiError(
      503,
      "legal-text-unavailable",
      "Service Unavailable",
      "This deployment publishes no consent screen copy, so a client cannot be told " +
        "what to ask. The documents themselves are unaffected and every recorded " +
        "acceptance remains valid. This is a wiring fault, not a missing document.",
    );
  }
  return presentation;
}

interface SendOptions {
  readonly cacheControl: string;
  readonly contentLocation?: string;
}

/**
 * Turns a resolution into a response, or into the right refusal.
 *
 * The three outcomes are three status codes on purpose. Collapsing "we never
 * published that" into "we cannot produce it" would tell an operator holding a
 * consent row that the version on it does not exist, which is the opposite of
 * true and the opposite of actionable.
 */
function sendDocument(
  reply: FastifyReply,
  ifNoneMatch: string | string[] | undefined,
  resolved: RevisionText,
  options: SendOptions,
): FastifyReply {
  if (resolved.status === "unknown") {
    throw new ApiError(
      422,
      "unprocessable",
      "Unprocessable Content",
      "That document and version pair has never been published by Pull.fm. " +
        "GET /v1/legal lists the current version of every document.",
      [{ field: "version", message: "unknown version" }],
    );
  }

  if (resolved.status === "unavailable") {
    // 503 RATHER THAN 404 OR 500, and the distinction is the whole point of
    // carrying a reason through from the service. The revision exists, its digest
    // is on record, and consent rows may cite it; what is missing is this
    // deployment's copy of the bytes. A 404 would assert the version was never
    // published, which is false and would send somebody looking for a
    // record-keeping failure instead of a deployment one. A 500 would say we do
    // not know what happened, and we do.
    //
    // Constructed here rather than added to `lib/errors.ts`: that file is shared
    // and another change is in flight in it, and this problem class belongs to
    // exactly one route. The `detail` is safe to echo - it names a document, a
    // version and a digest, all of which are published facts.
    throw new ApiError(
      503,
      "legal-text-unavailable",
      "Service Unavailable",
      `Pull.fm published this version and cannot serve its text from this deployment ` +
        `(${resolved.reason}). This is a deployment fault, not a missing document. ` +
        `The version, its digest and every acceptance of it are unaffected.`,
    );
  }

  const etag = `"${resolved.digest}"`;
  if (conditionalHit(ifNoneMatch, etag)) {
    return notModified(
      reply,
      etag,
      options.cacheControl,
      options.contentLocation,
    );
  }

  let out = reply
    .header("cache-control", options.cacheControl)
    .header("etag", etag);
  if (options.contentLocation !== undefined) {
    out = out.header("content-location", options.contentLocation);
  }
  return out.type(LEGAL_CONTENT_TYPE).send(resolved.text);
}

/** A 304 must repeat the validator and the caching policy, and carry no body. */
function notModified(
  reply: FastifyReply,
  etag: string,
  cacheControl: string,
  contentLocation?: string,
): FastifyReply {
  let out = reply
    .code(304)
    .header("cache-control", cacheControl)
    .header("etag", etag);
  if (contentLocation !== undefined) {
    out = out.header("content-location", contentLocation);
  }
  return out.send();
}

/** sha256 of a string, as a quoted strong ETag. */
function quotedDigest(value: string): string {
  return `"${createHash("sha256").update(value, "utf8").digest("hex")}"`;
}

/**
 * RFC 9110 `If-None-Match`, to the extent this route can be asked for.
 *
 * A list, `*`, and a `W/` prefix are all handled. The weak prefix is accepted
 * even though our own validator is strong, because RFC 9110 section 13.1.2
 * specifies WEAK comparison for `If-None-Match` and a cache is entitled to send
 * back what it was given however it chose to store it. Rejecting `W/"<digest>"`
 * would turn a legitimate revalidation into a full body transfer, silently.
 */
function conditionalHit(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw === undefined || raw === "") return false;
  return raw
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}
