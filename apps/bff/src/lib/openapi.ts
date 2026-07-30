/**
 * OpenAPI 3.1 emission, and the annotations the security tooling reads.
 *
 * Gate 2 makes the spec the source of truth. That is only true if the spec
 * cannot lag the router, so it is GENERATED from the Fastify route schemas
 * rather than hand-maintained: a route that exists is a route in the document,
 * and a documented route that does not exist is impossible by construction.
 *
 * Gate 3 then enumerates user-scoped routes FROM that document
 * (security/bola/route-matrix.mjs) and fails CI if any operation is
 * unclassified. Three annotations carry the classification:
 *
 *   x-pullfm-authz  public | authenticated-shared | user-scoped | system | webhook
 *   x-pullfm-bola   how a foreign object identity is substituted (user-scoped only)
 *   x-pullfm-dast   include | exclude, read by security/zap/scripts/prune-openapi.mjs
 *
 * They are attached to the route's `schema` object under a single `x-pullfm`
 * key, collected by an `onRoute` hook, and injected into the finished document.
 * Collecting them from the router rather than writing them into a static file
 * is what makes "forgetting to classify a new route" a build failure instead of
 * a silent coverage gap.
 *
 * The emitter FAILS if any operation lacks an annotation. That check lives here,
 * upstream of the enumerator, so the error names the Fastify route rather than
 * an anonymous path in a generated document.
 */

import type { FastifyInstance } from "fastify";

export type AuthzClass =
  "public" | "authenticated-shared" | "user-scoped" | "system" | "webhook";

export type BolaStrategy =
  "path-param" | "query-param" | "body-ref" | "header" | "implicit-subject";

export interface BolaDescriptor {
  readonly strategy: BolaStrategy;
  /** Which subject-A fixture the BOLA suite aims at this route. */
  readonly objectType: string;
  /** Parameter carrying the object identity. Required unless implicit-subject. */
  readonly param?: string;
  /** Acceptable denial status codes, declared per route rather than assumed. */
  readonly deny: readonly number[];
}

/**
 * Whether the first-launch consent gate applies to this operation, and if not,
 * WHY NOT.
 *
 * A bare boolean was rejected. Every exemption here is a hole in a control that
 * exists because a contract does not form without it, so the reason a route is
 * exempt has to be legible at the route rather than inferable from its path. The
 * reason is also the review criterion: a new value in this union is a new CLASS of
 * exemption and should be argued, while adding a route to an existing class is a
 * judgement about that route.
 *
 * `enforced` is the DEFAULT and is what an operation with no annotation gets.
 * That direction matters more than the values do: the failure mode of a
 * fail-closed default is a route that refuses a user who owes consent, which is
 * visible in one test run, and the failure mode of a fail-open default is a route
 * that quietly works without a contract, which is visible in a deposition.
 */
export type ConsentGate =
  | "enforced"
  /** The consent endpoints themselves. Gating them would deadlock the gate. */
  | "exempt-consent-flow"
  /**
   * Export and deletion. GDPR Article 17 and 20, and the CCPA equivalents:
   * conditioning a data-subject right on agreeing to a contract is not a
   * defensible position, and deletion is additionally the only honest exit for a
   * user who has read the Terms and refused them.
   */
  | "exempt-data-subject-right"
  /**
   * Sign-out. A user who refuses the Terms must be able to end their session,
   * and "you cannot log out until you agree" is indefensible in every direction.
   */
  | "exempt-session-control"
  /**
   * Reading one's own account. The consent screen has to say which account it is
   * about, and the client's launch sequence reads this before it can render
   * anything. Narrow on purpose: the READ is exempt, `PATCH /v1/me` is not.
   */
  | "exempt-account-identity";

export interface PullfmAnnotations {
  readonly authz: AuthzClass;
  /** Whether the ZAP active scan may drive this operation. */
  readonly dast: "include" | "exclude";
  readonly bola?: BolaDescriptor;
  /** Scope a personal API token must hold. Documented, not just enforced. */
  readonly tokenScope?: string;
  /**
   * Consent-gate classification. Omitted means `enforced`.
   *
   * Declared HERE, on the schema, rather than as an option to `requireAuth`,
   * even though `requireAuth` is what enforces it. Two declarations of one fact
   * drift, and the one that drifted would be the enforcement rather than the
   * documentation. The hook reads this off `request.routeOptions.schema`, so
   * there is exactly one place a route says whether the gate applies, and it is
   * the same place the security tooling reads it from.
   */
  readonly consent?: ConsentGate;
}

/** The key under which annotations ride on a Fastify route schema. */
export const ANNOTATION_KEY = "x-pullfm";

/** Attaches annotations to a route schema in a type-checked way. */
export function annotate(
  annotations: PullfmAnnotations,
): Record<string, PullfmAnnotations> {
  return { [ANNOTATION_KEY]: annotations };
}

interface CollectedRoute {
  readonly method: string;
  readonly path: string;
  readonly annotations: PullfmAnnotations;
}

/** Fastify `/v1/wishlist/:id` -> OpenAPI `/v1/wishlist/{id}`. */
export function toOpenApiPath(fastifyPath: string): string {
  return fastifyPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * Collects annotations as routes are registered.
 *
 * `onRoute` fires for every route in every encapsulation context, including
 * ones registered by plugins, which is exactly the population the spec must
 * cover.
 */
export function collectAnnotations(
  app: FastifyInstance,
): Map<string, CollectedRoute> {
  const collected = new Map<string, CollectedRoute>();

  app.addHook("onRoute", (route) => {
    const schema = route.schema as
      (Record<string, unknown> & { hide?: boolean }) | undefined;
    if (schema?.hide === true) return;

    const raw = schema?.[ANNOTATION_KEY];
    if (raw === undefined) return;
    const annotations = raw as PullfmAnnotations;

    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // HEAD is synthesised by Fastify for every GET and is not a distinct
      // operation. Emitting it would double the route matrix with rows the
      // BOLA suite cannot meaningfully exercise.
      if (method === "HEAD" || method === "OPTIONS") continue;
      const path = toOpenApiPath(route.url);
      collected.set(`${method} ${path}`, { method, path, annotations });
    }
  });

  return collected;
}

/**
 * Injects annotations into the finished document and refuses to emit an
 * unclassified operation.
 *
 * The refusal is the point. security/BOLA-TESTING.md section 2: a heuristic
 * that guesses wrong in the "skip it" direction produces zero coverage on the
 * most dangerous route in the API, and a green build.
 */
export function applyAnnotations(
  document: Record<string, unknown>,
  collected: Map<string, CollectedRoute>,
): Record<string, unknown> {
  const paths = document["paths"] as
    Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (paths === undefined) return document;

  const unclassified: string[] = [];

  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const found = collected.get(key);
      if (found === undefined) {
        unclassified.push(key);
        continue;
      }
      operation["x-pullfm-authz"] = found.annotations.authz;
      operation["x-pullfm-dast"] = found.annotations.dast;
      // Written for EVERY operation, defaulted rather than omitted, so the
      // exemption set can be enumerated from the document. An absent key would
      // be indistinguishable from an operation nobody classified, which is the
      // ambiguity the `enforced` default exists to remove.
      operation["x-pullfm-consent"] = found.annotations.consent ?? "enforced";
      if (found.annotations.bola !== undefined) {
        operation["x-pullfm-bola"] = found.annotations.bola;
      }
      if (found.annotations.tokenScope !== undefined) {
        operation["x-pullfm-token-scope"] = found.annotations.tokenScope;
      }
    }
  }

  if (unclassified.length > 0) {
    throw new Error(
      `OpenAPI emission refused: ${String(unclassified.length)} operation(s) carry no x-pullfm annotation:\n` +
        unclassified.map((r) => `  ${r}`).join("\n") +
        "\n\nAdd `...annotate({ authz, dast, bola })` to the route schema. An unclassified route " +
        "is an untested route (docs/PLAN.md Gate 3, security/BOLA-TESTING.md section 2).",
    );
  }

  return document;
}

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
