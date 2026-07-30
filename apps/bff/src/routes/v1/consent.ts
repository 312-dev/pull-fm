/**
 * The consent gate's two endpoints: what do I owe, and here is my acceptance.
 *
 * These are the only two routes in the API that a subject who has accepted
 * nothing may reach, besides reading their own account, signing out, and the
 * export and deletion rights. Gating them would deadlock the gate, which is why
 * both carry `consent: "exempt-consent-flow"` rather than relying on anybody
 * noticing.
 *
 * WHAT A CLIENT IS EXPECTED TO DO, since this is the contract the missing screen
 * has to satisfy:
 *
 *   1. Sign in. GET /v1/me/consent (or make any other authenticated call and read
 *      the `consent` extension member off the 403).
 *   2. For each outstanding document, fetch `url`, and compute sha256 over the
 *      text with CRLF folded to LF, trailing whitespace stripped per line, and
 *      trailing newlines collapsed to one. Compare it to `contentSha256`. A
 *      mismatch means the copy fetched is not the copy we published and the user
 *      must not be asked to accept it.
 *   3. DISPLAY IT, and require an affirmative act that says what it means. This
 *      step is the one no server can perform and the one `Sgouros` turns on. A
 *      pre-ticked box or a "by continuing you agree" footer is the arrangement
 *      that lost in Sgouros.
 *   4. POST /v1/me/consent echoing `documentId`, `version` and `contentSha256`
 *      for each document, plus the client build and platform.
 *   5. On 409, go back to step 1: the document moved underneath the client.
 */

import type { FastifyInstance } from "fastify";

import { errors } from "../../lib/errors.js";
import { toWireDocument } from "../../lib/legal-documents.js";
import { annotate } from "../../lib/openapi.js";
import { legalDocumentSchema, problemResponses } from "../../lib/schemas.js";
import { subjectOf } from "../../plugins/auth.js";
import type { AcceptanceRequest } from "../../services/legal-consent.js";
import type { Services } from "../deps.js";

/** One recorded acceptance on the wire. */
const acceptanceSchema = {
  type: "object",
  properties: {
    documentId: { type: "string" },
    version: { type: "string" },
    consentEpoch: { type: "integer" },
    contentSha256: { type: "string" },
    acceptedAt: { type: "string", format: "date-time" },
    gate: {
      type: "string",
      enum: ["first-launch", "revision"],
      description:
        "Which screen presented the document. Derived from the subject's own history, never from the request, so a client cannot claim it showed a first-launch gate to a user who was being shown a revision notice.",
    },
  },
  required: [
    "documentId",
    "version",
    "consentEpoch",
    "contentSha256",
    "acceptedAt",
    "gate",
  ],
} as const;

/** A required document plus this subject's standing on it. */
const documentStatusSchema = {
  type: "object",
  properties: {
    ...legalDocumentSchema.properties,
    outstanding: {
      type: "boolean",
      description: "True when this subject has not accepted the current epoch.",
    },
    accepted: {
      type: ["object", "null"],
      description:
        "The subject's highest acceptance of this document, or null if they have never accepted it.",
      properties: acceptanceSchema.properties,
    },
  },
  required: [...legalDocumentSchema.required, "outstanding"],
} as const;

const statusResponseSchema = {
  type: "object",
  properties: {
    satisfied: { type: "boolean" },
    reason: {
      type: ["string", "null"],
      enum: ["never-accepted", "revision-pending", null],
      description:
        "never-accepted means no contract exists and everything except this endpoint, sign-out, reading your own account, and the export and deletion rights is refused. revision-pending means an earlier version was accepted, so reads continue and writes are refused.",
    },
    documents: { type: "array", items: documentStatusSchema },
    history: {
      type: "array",
      description:
        "Every acceptance ever recorded for this subject, newest first. Append-only: a later acceptance never overwrites an earlier one, because the question a dispute asks is what was agreed at a past date.",
      items: acceptanceSchema,
    },
  },
  required: ["satisfied", "reason", "documents", "history"],
} as const;

export function registerConsentRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  /**
   * What this subject still owes.
   *
   * Readable with a personal API token holding `read:me`, deliberately, even
   * though a token cannot ACCEPT anything. A script whose calls started failing
   * with 403 needs to be able to find out why, and "you owe consent, and a human
   * has to give it in the app" is a far better failure than a 403 a script author
   * has to guess at. It discloses nothing a session could not read.
   */
  app.get(
    "/me/consent",
    {
      preValidation: app.requireAuth({
        allow: ["session", "token"],
        scope: "read:me",
      }),
      schema: {
        operationId: "getConsent",
        summary: "The legal documents you must accept, and what you accepted",
        description:
          "Reports the current version, consent epoch and content digest of every document Pull.fm requires, this subject's standing on each, and the full append-only acceptance history. Never gated by the consent requirement it reports on.",
        tags: ["me"],
        response: {
          200: statusResponseSchema,
          ...problemResponses(400, 401, 403, 429, 503),
        },
        ...annotate({
          authz: "user-scoped",
          dast: "include",
          consent: "exempt-consent-flow",
          tokenScope: "read:me",
          bola: {
            strategy: "implicit-subject",
            objectType: "subject",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      await services.legal.ensureRevisions();
      const [accepted, history, published] = await Promise.all([
        services.legal.acceptedEpochs(subject.userId),
        services.legal.history(subject.userId),
        services.legal.publishedAt(),
      ]);
      const gap = services.legal.gapFor(accepted);
      const outstanding = new Set(gap.outstanding.map((d) => d.id));

      return {
        satisfied: gap.satisfied,
        reason: gap.reason,
        documents: services.legal.documents.map((doc) => ({
          ...toWireDocument(doc, published[`${doc.id}@${doc.version}`] ?? null),
          outstanding: outstanding.has(doc.id),
          // The subject's own highest acceptance of this document, which is not
          // necessarily of the CURRENT version: a user who accepted epoch 2 and
          // now faces epoch 3 needs to see what they did agree to, not a null
          // that reads as "you have never accepted anything".
          accepted:
            history
              .filter((h) => h.documentId === doc.id)
              .sort((a, b) => b.consentEpoch - a.consentEpoch)[0] ?? null,
        })),
        history,
      };
    },
  );

  /**
   * Records acceptance.
   *
   * SESSION ONLY, and this is the one route where that restriction is not the
   * usual "tokens are read-only" argument. A personal API token is a long-lived
   * script credential whose holder we cannot see, and a script accepting a
   * contract on a person's behalf is precisely the defect `Sgouros` describes:
   * there is no human act, so there is no assent, so recording one would
   * manufacture evidence of a contract that did not form. The CHECK constraint
   * `legal_consents_auth_method_chk` says the same thing in the schema, so
   * widening this route would need a migration as well as a diff.
   *
   * No `Idempotency-Key`. Unlike `POST /v1/wishlist` this route is naturally
   * idempotent: `UNIQUE (user_id, document_id, document_version)` plus
   * `ON CONFLICT DO NOTHING` means a retry records nothing new, does not move the
   * original `accepted_at`, and returns the same 200. An idempotency record would
   * add a table write to protect against a duplicate the schema already forbids.
   */
  app.post(
    "/me/consent",
    {
      preValidation: app.requireAuth({ allow: ["session"] }),
      schema: {
        operationId: "recordConsent",
        summary: "Accept the current legal documents",
        description:
          "Records that this subject accepted the named versions. The client must echo the version AND the content digest it displayed; an acceptance whose digest does not match the published document is refused with 409, so a stale bundled copy cannot be recorded as assent to the current text. Retrying is safe and records nothing new. Session only: a personal API token cannot accept a contract on a person's behalf.",
        tags: ["me"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["accept"],
          properties: {
            accept: {
              type: "array",
              minItems: 1,
              // One entry per required document, and a small ceiling because the
              // required set is a product decision of about two items rather
              // than a list a caller supplies the length of.
              maxItems: 16,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["documentId", "version", "contentSha256"],
                properties: {
                  documentId: { type: "string", maxLength: 64 },
                  version: { type: "string", maxLength: 64 },
                  contentSha256: {
                    type: "string",
                    pattern: "^[0-9a-f]{64}$",
                    description:
                      "sha256 of the normalised document the client displayed. Must equal the published digest for that version.",
                  },
                },
              },
            },
            client: {
              type: "object",
              additionalProperties: false,
              description:
                "Which build presented the screen. Untrusted by construction and recorded anyway: if a formation challenge is ever made about what a particular release displayed, this is what names the release.",
              properties: {
                build: { type: "string", maxLength: 64 },
                platform: { type: "string", maxLength: 32 },
              },
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              satisfied: { type: "boolean" },
              reason: {
                type: ["string", "null"],
                enum: ["never-accepted", "revision-pending", null],
              },
              recorded: {
                type: "array",
                description:
                  "The acceptances this call stored. EMPTY when every version supplied had already been accepted, which is the idempotent case rather than a failure.",
                items: acceptanceSchema,
              },
              outstanding: {
                type: "array",
                description:
                  "Documents still not accepted after this call, so a client that submitted only one of two knows to continue.",
                items: legalDocumentSchema,
              },
            },
            required: ["satisfied", "reason", "recorded", "outstanding"],
          },
          // 409 is the version-or-digest mismatch and it is retryable after
          // re-reading GET /v1/me/consent. 422 is an unknown document id, which
          // is not.
          ...problemResponses(400, 401, 403, 409, 422, 429, 503),
        },
        ...annotate({
          authz: "user-scoped",
          // Excluded from active scanning. Not because it is destructive - it is
          // not - but because a scanner cannot produce a valid digest and so can
          // only ever exercise the refusal paths, while a fuzzer that DID get
          // through would be writing rows into the table whose whole value is
          // that every row in it corresponds to a real human act.
          dast: "exclude",
          consent: "exempt-consent-flow",
          bola: {
            strategy: "implicit-subject",
            objectType: "subject",
            deny: [401],
          },
        }),
      },
    },
    async (request) => {
      const subject = subjectOf(request);
      const body = request.body as {
        accept: readonly AcceptanceRequest[];
        client?: { build?: string; platform?: string };
      };

      // Defence in depth behind the route's `allow: ["session"]`. The CHECK
      // constraint would refuse a token-authenticated insert anyway, but a 500
      // from a constraint violation is a worse answer than a 403 that says why.
      if (subject.method !== "session") {
        throw errors.forbidden(
          "Accepting the Terms requires an interactive session. A personal API token cannot " +
            "accept a contract on your behalf.",
        );
      }

      const recorded = await services.legal.record(
        {
          userId: subject.userId,
          authMethod: subject.method,
          sessionId: subject.sessionId,
          ip: request.ip,
          userAgent: headerValue(request.headers["user-agent"]),
          clientBuild: body.client?.build ?? null,
          clientPlatform: body.client?.platform ?? null,
        },
        body.accept,
      );

      // Re-read rather than reasoning from `recorded`. The subject on this
      // request was resolved before the insert, so anything derived from it is
      // stale by construction, and "did that satisfy the gate" is the one answer
      // the client acts on.
      const gap = services.legal.gapFor(
        await services.legal.acceptedEpochs(subject.userId),
      );

      for (const record of recorded) {
        await services.audit.record({
          userId: subject.userId,
          action: "account.terms_accepted",
          subjectRef: `${record.documentId}@${record.version}`,
          outcome: "ok",
          detail: {
            consentEpoch: record.consentEpoch,
            contentSha256: record.contentSha256,
            gate: record.gate,
            clientBuild: body.client?.build ?? null,
            clientPlatform: body.client?.platform ?? null,
          },
          ip: request.ip,
        });
      }

      return {
        satisfied: gap.satisfied,
        reason: gap.reason,
        recorded,
        outstanding: gap.outstanding.map((doc) => toWireDocument(doc)),
      };
    },
  );
}

/** A header may arrive as an array. Take the first and cap its length. */
function headerValue(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.length === 0) return null;
  return value.slice(0, 512);
}
