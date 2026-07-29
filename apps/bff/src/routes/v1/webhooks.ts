/**
 * The WorkOS webhook receiver.
 *
 * THREAT-MODEL T20, rated Critical, and the reasoning is short enough to
 * repeat in full: this route is unauthenticated by definition, it is published
 * in the public API surface, and it handles `user.deleted`, which cascades
 * through `ON DELETE CASCADE` into the credential vault. Without signature
 * verification it is an unauthenticated mass-deletion endpoint.
 *
 * Four properties make it safe, and all four are load-bearing:
 *
 *   1. **HMAC-SHA256 over the RAW body.** Not over a re-serialised object.
 *      `JSON.parse` followed by `JSON.stringify` reorders keys, changes
 *      whitespace, and normalises number and unicode escapes, so a signature
 *      computed over the round-tripped body verifies almost-but-not-always.
 *      Almost-always is the worst possible outcome: it works in testing and
 *      fails in production on the one payload whose float formatting differs.
 *
 *   2. **Constant-time comparison.** `===` on a MAC leaks the position of the
 *      first differing byte through timing, which is a forgery oracle given
 *      enough samples. `secretsEqual` from `@pull-fm/crypto` wraps
 *      `timingSafeEqual` so no call site has to remember.
 *
 *   3. **A five minute replay window.** The timestamp is inside the signed
 *      message, so an attacker cannot change it, and rejecting old timestamps
 *      means a captured-and-replayed delivery stops working. Without this a
 *      single legitimate `user.deleted` body, once observed, is replayable
 *      forever.
 *
 *   4. **Fail closed when unconfigured.** If no signing secret is present the
 *      route returns 503 and processes nothing. Production refuses to start at
 *      all (see config.ts). There is no code path in which an unverified body
 *      reaches the handler.
 *
 * The handler always answers 200 for a VERIFIED delivery, including for event
 * types it does not handle. A webhook provider retries non-2xx, and retrying an
 * event we deliberately ignore is a queue that never drains.
 */

import { createHmac } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { secretsEqual } from "@pull-fm/crypto";

import { annotate } from "../../lib/openapi.js";
import { problemResponses } from "../../lib/schemas.js";
import type { Services } from "../deps.js";

/** Deliveries older than this are rejected as replays. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export interface SignatureParts {
  readonly timestampMs: number;
  readonly signature: string;
}

/**
 * Parses `WorkOS-Signature: t=<timestamp>, v1=<hex>`.
 *
 * WorkOS issues the timestamp in milliseconds. Values small enough to be
 * seconds are upconverted rather than rejected, because a provider changing
 * units would otherwise present as "every webhook is a replay" at 3am, and the
 * window check is what provides the security property either way.
 */
export function parseSignatureHeader(header: string): SignatureParts | null {
  let timestampMs: number | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name === "t") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      timestampMs = parsed < 1e11 ? parsed * 1000 : parsed;
    } else if (name === "v1") {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      signature = value.toLowerCase();
    }
  }

  if (timestampMs === null || signature === null) return null;
  return { timestampMs, signature };
}

/**
 * Verifies a delivery.
 *
 * Returns a reason string on failure rather than a boolean, so the reason can
 * be audited without being returned to the caller. The HTTP response is a
 * uniform 401 in every case: telling an attacker which check failed turns the
 * endpoint into an oracle for constructing a valid one.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (typeof header !== "string" || header.length === 0) {
    return { ok: false, reason: "missing signature header" };
  }
  const parts = parseSignatureHeader(header);
  if (parts === null) {
    return { ok: false, reason: "malformed signature header" };
  }

  // The window is checked BEFORE the MAC. Both orders are secure, and this one
  // avoids spending a hash on obviously stale deliveries during a replay flood.
  const age = Math.abs(now - parts.timestampMs);
  if (age > REPLAY_WINDOW_MS) {
    return { ok: false, reason: "timestamp outside the replay window" };
  }

  // Signed message is `timestamp.rawBody`, concatenated as bytes. The body is
  // never decoded to a string and re-encoded on the way in.
  const expected = createHmac("sha256", secret)
    .update(`${String(parts.timestampMs)}.`, "utf8")
    .update(rawBody)
    .digest("hex");

  if (!secretsEqual(expected, parts.signature)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

interface WorkOsEvent {
  id?: unknown;
  event?: unknown;
  data?: { id?: unknown };
}

/** Reads the raw body captured by the content type parser in server.ts. */
function rawBodyOf(request: FastifyRequest): Buffer | null {
  const raw = (request as FastifyRequest & { rawBody?: unknown }).rawBody;
  return Buffer.isBuffer(raw) ? raw : null;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  app.post(
    "/webhooks/workos",
    {
      // Marks the route so the JSON parser retains the exact bytes. Without
      // this the signature is computed over a re-serialised body, which is
      // property 1 above and the one most often lost in a refactor.
      config: { rawBody: true },
      schema: {
        operationId: "workosWebhook",
        summary: "INTERNAL. Receive a signed identity event",
        description:
          "Internal integration surface, not part of the public client contract. Accepts signed identity-lifecycle events from the configured identity provider and rejects anything it cannot verify. It exists so that an identity deleted upstream does not leave data orphaned here, which is a GDPR obligation as much as a correctness one.",
        tags: ["internal"],
        headers: {
          type: "object",
          properties: {
            "workos-signature": { type: "string", maxLength: 512 },
          },
        },
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            event: { type: "string" },
            data: { type: "object", additionalProperties: true },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              received: { type: "boolean" },
              handled: { type: "boolean" },
            },
            required: ["received", "handled"],
          },
          ...problemResponses(400, 401, 429, 503),
        },
        ...annotate({ authz: "webhook", dast: "include" }),
      },
    },
    async (request, reply) => {
      const secret = services.cfg.WORKOS_WEBHOOK_SECRET;
      if (secret === undefined) {
        // Fail closed. An unverifiable delivery is discarded, never trusted.
        request.log.error(
          "WORKOS_WEBHOOK_SECRET is not configured; refusing to process a webhook",
        );
        return reply.code(503).send({
          type: "https://pull.fm/problems/misconfigured",
          title: "Service Unavailable",
          status: 503,
          detail: "Webhook verification is not configured on this deployment.",
        });
      }

      const raw = rawBodyOf(request);
      if (raw === null) {
        // Only reachable if the parser wiring is removed, in which case the
        // signature cannot be verified and the request must not be processed.
        request.log.error("raw body unavailable; refusing to verify webhook");
        return reply.code(503).send({
          type: "https://pull.fm/problems/misconfigured",
          title: "Service Unavailable",
          status: 503,
          detail: "Webhook verification is not available on this deployment.",
        });
      }

      const verified = verifySignature(
        raw,
        request.headers["workos-signature"] as string | undefined,
        secret,
      );
      if (!verified.ok) {
        await services.audit.record({
          userId: null,
          action: "webhook.rejected",
          outcome: "denied",
          detail: { reason: verified.reason },
          ip: request.ip,
        });
        // Uniform 401. The reason is in the audit trail, not in the response.
        return reply.code(401).send({
          type: "https://pull.fm/problems/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "The webhook signature could not be verified.",
        });
      }

      const event = (request.body ?? {}) as WorkOsEvent;
      const type = typeof event.event === "string" ? event.event : "";
      const workosUserId =
        typeof event.data?.id === "string" ? event.data.id : null;

      if (type === "user.deleted" && workosUserId !== null) {
        const outcome = await services.deletion.deleteByWorkOsId(workosUserId);
        await services.audit.record({
          userId: outcome?.userId ?? null,
          action: "webhook.user_deleted",
          subjectRef: workosUserId,
          outcome: "ok",
          detail: { matched: outcome !== null },
        });
        return { received: true, handled: true };
      }

      // Verified but not acted on. Still 200: a provider retries non-2xx, and
      // retrying an event we deliberately ignore is a queue that never drains.
      return { received: true, handled: false };
    },
  );
}
