// ---------------------------------------------------------------------------
// Pull.fm - shared OpenAPI helpers for the security tooling.
//
// Used by security/bola/route-matrix.mjs (Gate 3 route enumeration) and
// security/zap/scripts/prune-openapi.mjs (DAST-safe spec generation). Both need
// the same answer to "what are the operations in this document", and the whole
// point of enumerating from the spec is that there is exactly one answer.
//
// Zero dependencies. JSON only: converting YAML would need a parser, and the
// spec is generated from the Fastify route schemas anyway, so JSON is the
// natural output. Callers that hold a YAML spec convert it first.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

// Per OpenAPI 3.1, the fixed fields of a Path Item Object that are operations.
// `parameters`, `summary`, `description`, `servers`, `$ref` and extensions are
// not, and treating them as operations is the classic enumeration bug that
// makes a "complete" route list quietly wrong.
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

export class SpecError extends Error {}

export function loadSpec(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new SpecError(`cannot read spec at ${path}: ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new SpecError(
      `${path} is not valid JSON (${err.message}). ` +
        "This tooling reads JSON specs only; convert a YAML spec first.",
    );
  }
  if (!doc || typeof doc !== "object")
    throw new SpecError(`${path} is not an object`);
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new SpecError(`${path} is not an OpenAPI 3.x document`);
  }
  if (!doc.paths || typeof doc.paths !== "object") {
    throw new SpecError(`${path} has no paths object`);
  }
  return doc;
}

/**
 * Yield every operation in the document.
 *
 * A `$ref` at path-item level is rejected rather than resolved. Resolving refs
 * correctly needs a real resolver, and a half-implemented one would silently
 * skip operations. For enumeration that claims to be exhaustive, silently
 * skipping is the one failure that must not happen, so it fails loudly instead.
 */
export function* eachOperation(doc) {
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== "object") continue;
    if (item.$ref) {
      throw new SpecError(
        `path item ${path} uses $ref, which this tooling does not resolve. ` +
          "Emit a fully dereferenced spec so route enumeration cannot silently miss operations.",
      );
    }
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      yield {
        path,
        method: method.toUpperCase(),
        operationId: op.operationId ?? `${method}:${path}`,
        operation: op,
        pathItem: item,
        // Path-level parameters apply to every operation on the path; merging
        // them here is what lets a caller find `{id}` on an operation that
        // does not redeclare it.
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
      };
    }
  }
}

/** Stable "METHOD /path" key used as the identity of an operation everywhere. */
export const routeKey = ({ method, path }) => `${method} ${path}`;
