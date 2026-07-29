/**
 * The two S3 operations the erasure ledger needs, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HAND-ROLLED RATHER THAN `@aws-sdk/client-s3`
 *
 * The BFF needs to PUT one small JSON object and HEAD one key, on the deletion
 * path only. `@aws-sdk/client-s3` is tens of megabytes of transitive
 * dependencies for two requests, and every one of them lands in the image that
 * serves the public API and in the dependency-scanning surface
 * (`pnpm scan:deps`). SigV4 for a single-shot, single-region, unsigned-payload-
 * free request is about eighty lines and is fully specified. The cost of
 * writing it is paid once; the cost of carrying the SDK is paid on every audit.
 *
 * The signing is also the only part worth testing, and testing it against a
 * known-answer vector is far easier than testing that an SDK was configured
 * correctly.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   - No retries. The caller decides, because the caller is the only thing that
 *     knows the request is an account deletion with a timeout the user is
 *     waiting on.
 *   - No DELETE and no LIST. The ledger is append-only, and a credential that
 *     can erase the erasure record defeats the object of keeping it outside
 *     Postgres. This client cannot express the operation even if the token
 *     could perform it.
 *   - No streaming. Every body here is a few hundred bytes of JSON, so the
 *     payload hash is computed over a string in memory, which is what SigV4
 *     wants anyway.
 *
 * PATH-STYLE ADDRESSING (`https://<endpoint>/<bucket>/<key>`) rather than
 * virtual-host style, because R2's jurisdiction-scoped hosts are configured as
 * a whole endpoint URL and a bucket-prefixed hostname would have to be
 * synthesised from it. infra/lib/backup-common.sh documents the trap that makes
 * guessing the host expensive: an EU-jurisdiction bucket answers NoSuchBucket
 * on the account's default host, so the endpoint is configuration, never
 * derivation.
 */

import { createHash, createHmac } from "node:crypto";

/** R2 has no regions; SigV4 still requires the field. `auto` is what R2 wants. */
const REGION = "auto";
const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

export interface R2ClientOptions {
  /** Full origin, e.g. `https://<account>.eu.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Per-request ceiling. A hung object store must become a fast failure. */
  readonly timeoutMs: number;
  /** Test seam. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Test seam. Defaults to `Date`. */
  readonly now?: (() => Date) | undefined;
}

/**
 * A failure talking to the object store.
 *
 * Carries the status and a TRUNCATED body for the log. Nothing constructed here
 * ever reaches a client: the deletion route maps it to a fixed problem
 * document, for the reason lib/errors.ts gives about echoing error messages.
 */
export class R2Error extends Error {
  public override readonly name = "R2Error";
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/**
 * Percent-encoding per RFC 3986, which is what SigV4 canonicalisation requires.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so a key
 * containing one would produce a canonical request that does not match the one
 * the server computes, and the request would fail signature verification with a
 * message about the credential. Ledger keys are UUIDs today; this is here so
 * that stays true if the key scheme ever changes.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes an object key, keeping `/` as the segment separator S3 expects. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `20260729T101500Z` and `20260729`, the two forms SigV4 asks for. */
function timestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

/**
 * Builds the signed request for one operation.
 *
 * Exported so the signature can be tested against a fixed clock and fixed
 * credentials rather than only through a live call, which is the only way to
 * catch a canonicalisation mistake before it becomes an outage on the deletion
 * path.
 */
export function signRequest(opts: {
  method: "PUT" | "HEAD";
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  body: string;
  contentType?: string | undefined;
  now: Date;
}): SignedRequest {
  const origin = new URL(opts.endpoint);
  const host = origin.host;
  const canonicalUri = `${origin.pathname.replace(/\/+$/, "")}/${encodeRfc3986(opts.bucket)}/${encodeKey(opts.key)}`;
  const { amzDate, dateStamp } = timestamps(opts.now);
  const payloadHash = sha256Hex(opts.body);

  // Sorted by header name, lowercased, values trimmed: the canonical-headers
  // rules. Content-type is signed when present rather than left unsigned,
  // because an intermediary that rewrites an unsigned header cannot then be
  // told apart from a tampered request.
  const signed: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (opts.contentType !== undefined) {
    signed["content-type"] = opts.contentType;
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n] ?? ""}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    "", // no query string on either operation
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, dateStamp), REGION), SERVICE),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    url: `${origin.origin}${canonicalUri}`,
    method: opts.method,
    headers: {
      ...signed,
      authorization:
        `${ALGORITHM} Credential=${opts.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** A minimal, append-only S3 client: does this key exist, and write this key. */
export class R2Client {
  readonly #opts: R2ClientOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(opts: R2ClientOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#now = opts.now ?? ((): Date => new Date());
  }

  /** True when the key is already present. Throws on anything but 200 or 404. */
  async exists(key: string): Promise<boolean> {
    const res = await this.#send("HEAD", key, "", undefined);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new R2Error(
      `HEAD of the ledger object answered ${String(res.status)}`,
      res.status,
      res.body,
    );
  }

  /** Writes the object. Throws on any non-2xx. */
  async put(key: string, body: string): Promise<void> {
    const res = await this.#send("PUT", key, body, "application/json");
    if (res.status >= 200 && res.status < 300) return;
    throw new R2Error(
      `PUT of the ledger object answered ${String(res.status)}`,
      res.status,
      res.body,
    );
  }

  async #send(
    method: "PUT" | "HEAD",
    key: string,
    body: string,
    contentType: string | undefined,
  ): Promise<{ status: number; body: string }> {
    const signed = signRequest({
      method,
      endpoint: this.#opts.endpoint,
      bucket: this.#opts.bucket,
      key,
      accessKeyId: this.#opts.accessKeyId,
      secretAccessKey: this.#opts.secretAccessKey,
      body,
      contentType,
      now: this.#now(),
    });

    let res: Response;
    try {
      res = await this.#fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        ...(method === "PUT" ? { body } : {}),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
    } catch (err) {
      // A timeout and a DNS failure are the same thing to the caller: the
      // ledger write did not happen, so the erasure must not proceed.
      throw new R2Error(
        `the ledger object store is unreachable: ${err instanceof Error ? err.name : "unknown error"}`,
        null,
      );
    }

    // Read at most a short prefix. An S3 error body is XML with no secret in
    // it, but this string reaches the log and a log line is not a place to put
    // an unbounded remote-controlled payload.
    let text = "";
    try {
      text = method === "HEAD" ? "" : (await res.text()).slice(0, 512);
    } catch {
      /* a body we cannot read tells us nothing the status has not already */
    }
    return { status: res.status, body: text };
  }
}
