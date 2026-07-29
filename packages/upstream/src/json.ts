/**
 * Narrowing helpers for upstream JSON.
 *
 * Upstream payloads arrive as `unknown` and must stay that way until something
 * checks them. Casting instead would push a provider's schema drift into a
 * TypeError three layers away from the call that caused it; these helpers make
 * it a `malformed` UpstreamError at the boundary, naming the field.
 *
 * Deliberately tolerant where providers are inconsistent: Last.fm returns
 * numbers as strings ("listeners": "12345") and ListenBrainz returns some
 * counts as numbers, so `optNumber` accepts both.
 */

export class MalformedPayloadError extends Error {
  public override readonly name = "MalformedPayloadError";
  constructor(
    public readonly path: string,
    detail: string,
  ) {
    super(`malformed upstream payload at "${path}": ${detail}`);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function optRecord(
  v: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined;
  const child = v[key];
  return isRecord(child) ? child : undefined;
}

export function reqRecord(
  v: unknown,
  key: string,
  path = key,
): Record<string, unknown> {
  const child = optRecord(v, key);
  if (child === undefined) {
    throw new MalformedPayloadError(path, "expected an object");
  }
  return child;
}

export function optArray(v: unknown, key: string): unknown[] | undefined {
  if (!isRecord(v)) return undefined;
  const child = v[key];
  return Array.isArray(child) ? child : undefined;
}

/**
 * Reads a field that a provider returns as either one object or a list of them.
 *
 * Last.fm does this on tag lists: one tag comes back as an object, two come
 * back as an array. Every hand-rolled Last.fm client hits this eventually.
 */
export function arrayOrSingle(v: unknown, key: string): unknown[] {
  if (!isRecord(v)) return [];
  const child = v[key];
  if (Array.isArray(child)) return child;
  if (child === undefined || child === null) return [];
  return [child];
}

export function optString(v: unknown, key: string): string | undefined {
  if (!isRecord(v)) return undefined;
  const child = v[key];
  if (typeof child === "string") return child;
  if (typeof child === "number" && Number.isFinite(child)) return String(child);
  return undefined;
}

export function reqString(v: unknown, key: string, path = key): string {
  const s = optString(v, key);
  if (s === undefined || s === "") {
    throw new MalformedPayloadError(path, "expected a non-empty string");
  }
  return s;
}

export function optNumber(v: unknown, key: string): number | undefined {
  if (!isRecord(v)) return undefined;
  const child = v[key];
  if (typeof child === "number" && Number.isFinite(child)) return child;
  if (typeof child === "string" && child.trim() !== "") {
    const n = Number(child);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function optBoolean(v: unknown, key: string): boolean | undefined {
  if (!isRecord(v)) return undefined;
  const child = v[key];
  return typeof child === "boolean" ? child : undefined;
}

const MBID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MBIDs go into `uuid` columns. A non-UUID reaching Postgres is a 500 at write
 * time, so it is rejected here where the provider can be named in the error.
 */
export function isMbid(v: unknown): v is string {
  return typeof v === "string" && MBID_RE.test(v);
}

export function optMbid(v: unknown, key: string): string | undefined {
  const s = optString(v, key);
  return s !== undefined && MBID_RE.test(s) ? s.toLowerCase() : undefined;
}

export function parseJson(text: string, path = "(root)"): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new MalformedPayloadError(
      path,
      err instanceof Error ? err.message : "not valid JSON",
    );
  }
}
