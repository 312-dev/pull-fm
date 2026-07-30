/**
 * The /v1 API surface.
 *
 * Assembly only. Each module owns its own routes, schemas, and the reasoning
 * for its authorization decisions, so the file that documents a rule is the
 * file that implements it.
 *
 * Split per docs/PLAN.md section 6 into a stable platform surface (identity,
 * connections, tokens, wishlist, deletion, export, config) and a volatile
 * product surface behind a stable envelope.
 */

import type { FastifyInstance } from "fastify";

import { annotate } from "../../lib/openapi.js";
import { problemResponses } from "../../lib/schemas.js";
import type { Services } from "../deps.js";
import { registerAuthRoutes } from "./auth.js";
import { registerConnectionRoutes } from "./connections.js";
import { registerConsentRoutes } from "./consent.js";
import { registerLegalRoutes } from "./legal.js";
import { registerMeRoutes } from "./me.js";
import { registerProductRoutes } from "./product.js";
import { registerTokenRoutes } from "./tokens.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerWishlistRoutes } from "./wishlist.js";

export interface V1Options {
  readonly services: Services;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function registerV1Routes(
  app: FastifyInstance,
  opts: V1Options,
): Promise<void> {
  const services = opts.services;

  /**
   * Client configuration.
   *
   * The highest-leverage endpoint for a client that cannot be force-upgraded,
   * and the one most often forgotten. docs/PLAN.md open decision 6 ships
   * through GitHub Releases rather than an app store, which means there is no
   * automatic update channel at all and `minSupportedBuild` enforcement matters
   * more, not less.
   *
   * It is also a reconnaissance endpoint (API9), so it returns coarse provider
   * health and nothing else: no internal hostnames, no versions, no indication
   * of which providers hold credentials.
   */
  app.get(
    "/config",
    {
      schema: {
        operationId: "getConfig",
        summary: "Client configuration and coarse provider health",
        tags: ["platform"],
        response: {
          200: {
            type: "object",
            properties: {
              minSupportedBuild: { type: "integer" },
              maintenance: { type: "boolean" },
              features: { type: "object", additionalProperties: true },
              providers: {
                type: "object",
                additionalProperties: {
                  type: "string",
                  enum: ["ok", "degraded", "disabled"],
                },
              },
            },
            required: [
              "minSupportedBuild",
              "maintenance",
              "features",
              "providers",
            ],
          },
          ...problemResponses(429),
        },
        ...annotate({ authz: "public", dast: "include" }),
      },
    },
    () => ({
      minSupportedBuild: 1,
      // The GATE, not the environment variable. A client that is told
      // `maintenance: false` while every other route is answering 503 has been
      // given the one piece of information it exists to receive, wrongly.
      maintenance: services.maintenance.active(),
      features: {
        personalApiTokens: true,
        wishlist: true,
        discovery: true,
        // A client hides the shelf rather than rendering an empty one. False
        // means no events provider is configured or the kill switch is thrown,
        // and the route answers 501 rather than an empty list.
        events: services.cfg.eventsEnabled,
      },
      // Read from the live clients rather than hard-coded, so an open circuit
      // breaker or a thrown kill switch is visible to a client within seconds
      // instead of at the next deploy. Coarse on purpose: this is a
      // reconnaissance endpoint (API9), so it says whether a shelf will render
      // and never which providers hold credentials.
      providers: services.upstream.status(),
    }),
  );

  registerAuthRoutes(app, services);
  registerMeRoutes(app, services);
  // Under /v1/me rather than /v1/legal, because both routes are about a
  // SUBJECT's standing rather than about the documents. See consent.ts.
  registerConsentRoutes(app, services);
  /**
   * The documents themselves.
   *
   * A SEPARATE PREFIX, AND A SEPARATE AUTHORIZATION CLASS, which is the whole
   * reason this is not folded into consent.ts. `/v1/me/consent` is user-scoped and
   * says what one person owes; these say what Pull.fm publishes and are reachable
   * with no credential at all, because a person has to be able to read the Terms
   * before they have an account to read them with.
   *
   * This comment used to record the opposite conclusion - that there was no
   * unauthenticated document route "and the documents are not in the deployed
   * image to serve". The second half was true and was the cause of the first:
   * `pnpm deploy --prod` ships JavaScript only, so `legal/` was absent from the
   * runtime image. That is fixed in apps/bff/Dockerfile, and the canonical text is
   * now stored in `legal_document_revisions` at publish time as well, so a
   * superseded version survives the file being edited. See legal.ts and migration
   * 0009.
   */
  registerLegalRoutes(app, services);
  registerTokenRoutes(app, services);
  registerConnectionRoutes(app, services);
  registerWishlistRoutes(app, services);
  registerProductRoutes(app, services);
  registerWebhookRoutes(app, services);
}
