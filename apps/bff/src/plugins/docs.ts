/**
 * The OpenAPI document and the reference browser, both self-hosted.
 *
 * Gate 2 makes the spec the source of truth, so it is generated from the
 * Fastify route schemas by `@fastify/swagger` rather than hand-maintained. The
 * practical consequence is the one that matters: a route cannot exist without
 * appearing in the document, and a documented route cannot fail to exist,
 * which is what turns the document from a description into an inventory
 * (API9:2023).
 *
 * The browser is Scalar, served from the package's own bundle. NO CDN, at all:
 *
 *   - The Content-Security-Policy for this application is `default-src 'none'`
 *     and an external script host would simply be blocked, so a CDN-based
 *     reference would render a blank page in production and work perfectly in
 *     development, which is the worst kind of bug.
 *   - A documentation page that loads executable code from a third party at
 *     request time is a supply-chain dependency evaluated in the reader's
 *     browser, on a page that sits on the same origin as the API. That is a
 *     free XSS foothold in exchange for saving 3 MB of disk.
 *
 * `@scalar/fastify-api-reference` inlines the reference bundle in its own dist
 * and serves it from `<prefix>/js/scalar.js`, so nothing is fetched off-origin.
 *
 * The CSP carve-out below is deliberately scoped to the documentation prefix
 * and nowhere else. It is written explicitly rather than by disabling helmet,
 * so what is being relaxed is visible.
 */

import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";

import { applyAnnotations, collectAnnotations } from "../lib/openapi.js";
import type { Config } from "../config.js";

export interface DocsOptions {
  readonly cfg: Config;
  readonly enableBrowser: boolean;
}

/** Where the reference browser and the raw document are served. */
export const DOCS_PREFIX = "/docs";
export const OPENAPI_PATH = "/openapi.json";

/**
 * Registers spec generation. Must run BEFORE any route is registered, because
 * annotation collection and `@fastify/swagger` both work by `onRoute` hooks.
 */
export async function registerOpenApi(
  app: FastifyInstance,
  opts: DocsOptions,
): Promise<void> {
  const collected = collectAnnotations(app);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Pull.fm API",
        version: "1.0.0",
        description: DESCRIPTION,
        license: {
          name: "Apache-2.0",
          url: "https://www.apache.org/licenses/LICENSE-2.0",
        },
      },
      servers: [
        { url: opts.cfg.PUBLIC_BASE_URL, description: opts.cfg.DEPLOY_ENV },
      ],
      tags: [
        { name: "platform", description: "Configuration and health." },
        { name: "auth", description: "Sign-in, refresh, and revocation." },
        {
          name: "me",
          description: "The account, its erasure, and its export.",
        },
        {
          name: "tokens",
          description:
            "Personal API tokens for scripted read-only access to your own data.",
        },
        { name: "connections", description: "Linked music services." },
        { name: "wishlist", description: "Records to acquire." },
        {
          name: "discovery",
          description:
            "Recommendations and the feed, behind a stable sections envelope.",
        },
        {
          name: "catalogue",
          description: "Shared catalogue data, owned by nobody.",
        },
        { name: "webhooks", description: "Signed inbound events." },
      ],
      components: {
        securitySchemes: {
          workosBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "A WorkOS AuthKit access token, obtained from GET /v1/auth/callback. Grants full account authority.",
          },
          pullfmToken: {
            type: "http",
            scheme: "bearer",
            description:
              "A personal API token, `pfm_live_...` or `pfm_test_...`, created with POST /v1/tokens. Read-only and scoped. Cannot create or revoke tokens, cannot manage connections, and cannot delete the account.",
          },
        },
      },
      security: [{ workosBearer: [] }, { pullfmToken: [] }],
    },
    // Annotations are injected into the finished document, and emission FAILS
    // if any operation is unclassified. That failure is Gate 3's "failing CI if
    // any route lacks a test" clause, raised before the enumerator even runs so
    // the error can name the Fastify route.
    transformObject: (documentObject) => {
      if (!("openapiObject" in documentObject))
        return documentObject.swaggerObject;
      return applyAnnotations(documentObject.openapiObject, collected);
    },
  });
}

/** Registers the JSON document route and the reference browser. */
export async function registerDocs(
  app: FastifyInstance,
  opts: DocsOptions,
): Promise<void> {
  app.get(OPENAPI_PATH, { schema: { hide: true }, logLevel: "warn" }, () =>
    app.swagger(),
  );

  if (!opts.enableBrowser) return;

  /**
   * The scoped CSP.
   *
   * Registered inside its own encapsulation context so the relaxation applies
   * to the documentation prefix and the document route only. Everything else in
   * this application keeps `default-src 'none'`.
   *
   * `unsafe-inline` and `unsafe-eval` are required by the reference renderer's
   * bootstrap. They are acceptable HERE and nowhere else, because this page
   * serves no user data, reads no credential, and loads nothing off-origin:
   * every source below is `'self'` or a data URI.
   */
  await app.register(async (scope) => {
    scope.addHook("onSend", async (_request, reply) => {
      void reply.header(
        "content-security-policy",
        [
          "default-src 'none'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      );
    });

    // The Scalar plugin ships its own Fastify typings against Fastify 4, so
    // the plugin signature does not line up with Fastify 5's. It works at
    // runtime (it bundles fastify-plugin and declares no version constraint);
    // only the type is stale.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await scope.register(scalar, {
      routePrefix: DOCS_PREFIX,
      configuration: {
        // No `url`: the plugin reads the document straight from
        // `@fastify/swagger`, so the browser and the spec can never disagree
        // about what the API is. Pointing it at a URL would also break the
        // plugin's own `<prefix>/openapi.json` endpoint.
        pageTitle: "Pull.fm API",
        // Off-origin fonts would be blocked by the CSP above and would be an
        // off-origin request from a page documenting a credential API.
        withDefaultFonts: false,
        hideDownloadButton: false,
      },
    });
  });
}

const DESCRIPTION = `
Pull.fm is a **non-commercial** music discovery service. This document is generated from the
Fastify route schemas and is the source of truth for the API: a route that is not here does not
exist, and a route that is here is contract-tested.

## Authenticating

Two credential types, deliberately not interchangeable.

**Session** - a WorkOS AuthKit access token. Full account authority, including irreversible
operations. Obtained from \`GET /v1/auth/callback\`.

**Personal API token** - a \`pfm_live_...\` string you create yourself with \`POST /v1/tokens\`.
Read-only, scoped, rate limited per token, and shown exactly once. Pull.fm stores only a SHA-256
digest, so a lost token is rotated rather than recovered.

A personal token deliberately **cannot** create or revoke tokens, manage connections, or delete
the account. If it could, a leaked read-only token would be a persistence mechanism rather than a
credential.

\`\`\`bash
# Create a token (interactive session required)
curl -sS -X POST https://api.pull.fm/v1/tokens \\
  -H "Authorization: Bearer $PULLFM_SESSION_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"laptop script","scopes":["read:me","read:recommendations"]}'

# Use it
curl -sS https://api.pull.fm/v1/recommendations \\
  -H "Authorization: Bearer pfm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
\`\`\`

## What this API will not do

Recommendations are served as Pull.fm's own derived output, with the attribution the upstream
terms require. There is no endpoint that returns raw Last.fm or MusicBrainz payloads in bulk,
and there will not be one: those providers licence their data for use, not for redistribution.
See \`docs/api/data-portability.md\` in the repository for the full reasoning.

## Errors

Every error is an RFC 9457 \`application/problem+json\` document. Objects belonging to another
account return **404, not 403**, so identifiers cannot be enumerated by observing which ones exist.
`.trim();
