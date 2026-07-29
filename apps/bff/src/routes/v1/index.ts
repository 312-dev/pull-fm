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
      maintenance: services.cfg.MAINTENANCE_MODE,
      features: {
        personalApiTokens: true,
        wishlist: true,
        // False until packages/discovery lands; the client hides the shelf
        // rather than rendering an empty one.
        discovery: false,
      },
      providers: {
        listenbrainz: "ok",
        lastfm: "ok",
        musicbrainz: "ok",
        previews: "ok",
        events: "disabled",
      },
    }),
  );

  registerAuthRoutes(app, services);
  registerMeRoutes(app, services);
  registerTokenRoutes(app, services);
  registerConnectionRoutes(app, services);
  registerWishlistRoutes(app, services);
  registerProductRoutes(app, services);
  registerWebhookRoutes(app, services);
}
