/**
 * SeatGeek Platform API v2.
 *
 * Built against the vendored spec at
 * packages/upstream/vendor-specs/seatgeek-platform-v2.openapi.json
 * (OpenAPI 3.0.1, base https://api.seatgeek.com/2).
 *
 * AUTH: HTTP Basic, client_id as username and client_secret as password.
 *
 * SeatGeek accepts the credential either as a `client_id` query parameter or as
 * Basic auth, and Basic is chosen deliberately. A credential in a query string
 * leaks through access logs, proxies, referrer headers, and any error message
 * that echoes a URL - and an error string built by a client is exactly the sort
 * of thing a request-serializer's query-stripping never sees. Basic auth
 * removes that entire class of leak. The query-parameter form is implemented
 * only as a fallback for a client_id with no secret, and even then the URL is
 * never logged (see `redactUrl` in provider-client.ts).
 *
 * The spec declares no securitySchemes at all, so authentication is not
 * described in the document; this is from SeatGeek's authentication docs and
 * was verified live by the operator.
 *
 * TWO AUTH FAILURE CODES, and they mean different things operationally:
 *   40307 "Client is required"           -> no credential was sent. Config bug.
 *   40302 "Invalid client credentials"   -> credential rejected. Revoked/wrong.
 * Collapsing them into "403 forbidden" costs someone an hour.
 *
 * RESULT CAP: since 2026-01-01 `/events` returns at most 10,000 results. That
 * is a cap on result-set size, not on narrow queries, and every query here is
 * scoped to one performer id, so it is not reachable from this client. Bulk
 * download and delta feeds exist for whole-catalogue use, which we do not have.
 *
 * NO PRICES. `stats.lowest_price` / `stats.average_price` are unpopulated by
 * design; they are not parsed and must not be modelled.
 *
 * NO PERSONAL DATA (terms 4.4, verbatim): "the SeatGeek API is not intended for
 * Personal Data, and you agree to not input or process Personal Data using the
 * SeatGeek API." Every outbound parameter is therefore checked against an
 * allow-list and every value against a coordinate/identifier pattern, and a
 * violation throws before the request is built. An allow-list rather than a
 * deny-list because the parameter that leaks a user is the one nobody thought
 * to ban.
 *
 * The value checks were widened on 2026-07-29: the original coordinate pattern
 * was anchored to the whole value, so `venue.city=41.8781` was refused and
 * `venue.city=41.8781,-87.6298` was sent. See `COORDINATE_PAIR_RE` below for the
 * full account. The allow-list itself was never the weak half; the assumption
 * that a leak arrives as a bare number was.
 */

import { UpstreamError } from "../errors.js";
import {
  arrayOrSingle,
  isRecord,
  optBoolean,
  optNumber,
  optRecord,
  optString,
} from "../json.js";
import type { ProviderAttribution } from "../events/types.js";
import type { ProviderClientOptions } from "../provider-client.js";
import { ProviderClient } from "../provider-client.js";
import type { Provider, ProviderStatus } from "../types.js";

export const SEATGEEK_BASE_URL = "https://api.seatgeek.com/2";

/**
 * No published numeric rate limit: SeatGeek's developer portal requires a login
 * and their public docs state only that exceeding the limit returns HTTP 429.
 * We therefore pace conservatively rather than assume a generous ceiling, and
 * the aggressive event cache means the real request rate is far below this.
 * Revise if and when a documented figure is obtained from the vendor.
 */
export const SEATGEEK_QUOTA = { limit: 60, windowMs: 60_000 } as const;
export const SEATGEEK_MIN_INTERVAL_MS = 1000;

/**
 * Attribution required by terms 3.1.
 *
 * Verbatim: we "shall display SeatGeek attribution, in the form of the SeatGeek
 * logo currently available at https://seatgeek.com/press" in every place their
 * material is accessed, used, or displayed, and each instance must link to the
 * SeatGeek homepage.
 *
 * This is a UI obligation that an API package cannot discharge on its own. What
 * it can do is refuse to hand back a bare credit string that a frontend would
 * reasonably render as text and consider done.
 */
export const SEATGEEK_ATTRIBUTION: ProviderAttribution = {
  source: "seatgeek",
  text: "SeatGeek",
  logoRequired: true,
  logoAssetPage: "https://seatgeek.com/press",
  linkUrl: "https://seatgeek.com",
  // Their Brand Guidelines permit proportional resizing without approval; any
  // other modification (recolouring, cropping, effects) needs written consent.
  logoModification: "proportional-resize-only",
};

/** SeatGeek's own scope statement: the US and Canada, other markets thinner. */
export const SEATGEEK_PRIMARY_COVERAGE: readonly string[] = ["US", "CA"];

export interface SeatGeekPerformer {
  readonly id: number;
  readonly name: string;
  readonly slug: string | undefined;
  readonly type: string | undefined;
  readonly url: string | undefined;
}

export interface SeatGeekVenue {
  readonly id: number | undefined;
  readonly name: string | undefined;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly country: string | undefined;
  readonly url: string | undefined;
}

export interface SeatGeekEvent {
  readonly id: number;
  readonly title: string;
  readonly shortTitle: string | undefined;
  readonly type: string | undefined;
  readonly datetimeUtc: string | undefined;
  readonly datetimeLocal: string | undefined;
  readonly datetimeTbd: boolean;
  readonly url: string | undefined;
  readonly venue: SeatGeekVenue | undefined;
  readonly performers: readonly SeatGeekPerformer[];
}

export interface SeatGeekEventsQuery {
  readonly performerId?: number | undefined;
  readonly q?: string | undefined;
  /** City NAME. There is no coordinate or postal-code option; see terms 4.4. */
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly country?: string | undefined;
  /** ISO 8601. Maps to datetime_utc.gte. Defaults to now at the call site. */
  readonly fromUtc?: string | undefined;
  readonly perPage?: number | undefined;
}

export interface SeatGeekClientOptions extends Omit<
  ProviderClientOptions,
  "name" | "baseUrl"
> {
  /** 35-character client id. Public-ish, but still kept out of URLs and logs. */
  readonly clientId: string;
  /** 64-character secret. Present enables Basic auth, which is preferred. */
  readonly clientSecret?: string | undefined;
  readonly baseUrl?: string;
}

function parsePerformer(v: unknown): SeatGeekPerformer | null {
  const id = optNumber(v, "id");
  const name = optString(v, "name");
  if (id === undefined || name === undefined) return null;
  return {
    id,
    name,
    slug: optString(v, "slug"),
    type: optString(v, "type"),
    url: optString(v, "url"),
  };
}

function parseVenue(v: unknown): SeatGeekVenue | undefined {
  if (!isRecord(v)) return undefined;
  return {
    id: optNumber(v, "id"),
    name: optString(v, "name"),
    city: optString(v, "city"),
    state: optString(v, "state"),
    country: optString(v, "country"),
    url: optString(v, "url"),
  };
}

export function parseEvent(v: unknown): SeatGeekEvent | null {
  const id = optNumber(v, "id");
  const title = optString(v, "title");
  if (id === undefined || title === undefined) return null;
  return {
    id,
    title,
    shortTitle: optString(v, "short_title"),
    type: optString(v, "type"),
    datetimeUtc: optString(v, "datetime_utc"),
    datetimeLocal: optString(v, "datetime_local"),
    datetimeTbd: optBoolean(v, "datetime_tbd") ?? false,
    url: optString(v, "url"),
    venue: parseVenue(isRecord(v) ? v["venue"] : undefined),
    performers: arrayOrSingle(v, "performers")
      .map(parsePerformer)
      .filter((p): p is SeatGeekPerformer => p !== null),
  };
}

/**
 * The vendored spec declares the /events 200 body as a bare array, while the
 * live service returns `{ events: [...], meta: {...} }`. Both are accepted
 * rather than picking a side: a spec/behaviour mismatch that breaks the client
 * is a worse outcome than a three-line tolerance here. Flagged in the report.
 */
function itemsOf(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  return arrayOrSingle(payload, key);
}

/**
 * Every query parameter this client is permitted to send.
 *
 * Terms 4.4 forbid inputting Personal Data. An allow-list is the only version
 * of this check that stays correct: a deny-list of `lat`, `lon`, `email`, and
 * so on is a list of the leaks somebody already thought of.
 */
export const SEATGEEK_ALLOWED_PARAMS: ReadonlySet<string> = new Set([
  "client_id",
  "q",
  "id",
  "per_page",
  "page",
  "sort",
  "type",
  "performers.id",
  "performers.slug",
  "venue.city",
  "venue.state",
  "venue.country",
  "taxonomies.id",
  "datetime_utc.gte",
  "datetime_utc.lte",
]);

/** A decimal coordinate: three or more fractional digits pins a person. */
const COORDINATE_RE = /^-?\d{1,3}\.\d{3,}$/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** US ZIP or ZIP+4, and the UK/CA shapes, in case one is ever passed through. */
const POSTAL_RE = /^(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/i;

/**
 * A coordinate PAIR anywhere inside a value, in any of the usual separators.
 *
 * ---------------------------------------------------------------------------
 * THIS CLOSES A REAL HOLE IN THE 4.4 GUARD, FOUND 2026-07-29 AUDITING THE
 * CLAUSE-BY-CLAUSE COMPLIANCE OF THIS PACKAGE.
 *
 * WHAT WAS WRONG. `COORDINATE_RE` is anchored `^...$`, so it only fired when the
 * WHOLE parameter value was a single decimal number. The route at
 * `GET /v1/artists/:mbid/events` accepts `city` as a free string up to 128
 * characters and passes it straight to `venue.city`. So:
 *
 *     ?city=41.8781            -> rejected  (whole value matches)
 *     ?city=41.8781,-87.6298   -> ACCEPTED, and sent to SeatGeek
 *
 * The second form is a user's exact location, arriving at the vendor as a query
 * parameter, which is precisely what 4.4 forbids and precisely what this function
 * was written to prevent. It is also the MORE likely shape: a client holding a
 * geolocation fix concatenates the pair, it does not send one axis.
 *
 * WHY THIS SHAPE. Three checks, layered, because each catches something the
 * others structurally cannot:
 *
 *   COORDINATE_RE       whole value is one axis. Applies to every parameter,
 *                       including ones where free text is not expected.
 *   COORDINATE_PAIR_RE  two axes anywhere in the value. Applies to every
 *                       parameter. Safe against the ISO timestamp in
 *                       `datetime_utc.gte` ("...T00:00:00.000Z" contains a
 *                       decimal-looking run but no comma-separated second one).
 *   EMBEDDED            one axis anywhere in the value, but ONLY for parameters
 *                       that legitimately carry free text. Unanchored on
 *                       `datetime_utc.gte` this WOULD false-positive on the
 *                       milliseconds, which is why it is key-scoped rather than
 *                       global. A city, state, country or performer slug never
 *                       contains a number with three or more decimal places.
 *
 * The postal-code check is scoped the same way and for a sharper reason: a
 * SeatGeek performer or event id can be five digits, so an unscoped ZIP check
 * would reject `id=60614` as a postal code and break ordinary lookups. That is
 * why `POSTAL_RE` is applied to the free-text place parameters only.
 *
 * Throwing on a coordinate pair means a caller that ever assembles one gets a
 * loud failure at the boundary instead of a silent breach. See the header of
 * this file for why an allow-list plus value inspection, rather than either
 * alone.
 */
const COORDINATE_PAIR_RE = /-?\d{1,3}\.\d{3,}\s*[,;|/]\s*-?\d{1,3}\.\d{3,}/;

/** One coordinate axis anywhere in the value. Only safe on free-text params. */
const EMBEDDED_COORDINATE_RE = /-?\d{1,3}\.\d{3,}/;

/**
 * Parameters whose values are human place names or search text, so a number with
 * three or more decimal places in one is never legitimate.
 *
 * Deliberately NOT `id`, `page`, `per_page`, `taxonomies.id`, `performers.id` or
 * either `datetime_utc` bound: those carry numbers and timestamps that a
 * coordinate- or postal-shaped test would reject for looking like themselves.
 */
const SEATGEEK_FREE_TEXT_PARAMS: ReadonlySet<string> = new Set([
  "q",
  "venue.city",
  "venue.state",
  "venue.country",
  "performers.slug",
]);

export class PersonalDataRejectedError extends Error {
  public override readonly name = "PersonalDataRejectedError";
  constructor(detail: string) {
    super(
      `refusing to send this to SeatGeek: ${detail}. Their terms 4.4 forbid inputting Personal Data; resolve a location to a city name before calling.`,
    );
  }
}

/**
 * Rejects anything that would put Personal Data in a SeatGeek request.
 *
 * Throws rather than silently dropping the parameter: a dropped location
 * quietly returns nationwide results, which looks like a ranking bug and would
 * be debugged for an hour before anyone found the sanitiser.
 */
export function assertNoPersonalData(
  params: Readonly<Record<string, string | number | undefined>>,
): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (!SEATGEEK_ALLOWED_PARAMS.has(key)) {
      throw new PersonalDataRejectedError(
        `parameter "${key}" is not on the allow-list`,
      );
    }
    const asString = typeof value === "number" ? String(value) : value;
    const trimmed = asString.trim();
    if (COORDINATE_RE.test(trimmed)) {
      throw new PersonalDataRejectedError(
        `parameter "${key}" looks like a precise coordinate`,
      );
    }
    if (COORDINATE_PAIR_RE.test(asString)) {
      throw new PersonalDataRejectedError(
        `parameter "${key}" contains a precise coordinate pair`,
      );
    }
    if (
      SEATGEEK_FREE_TEXT_PARAMS.has(key) &&
      EMBEDDED_COORDINATE_RE.test(asString)
    ) {
      throw new PersonalDataRejectedError(
        `parameter "${key}" contains a precise coordinate`,
      );
    }
    if (EMAIL_RE.test(asString)) {
      throw new PersonalDataRejectedError(
        `parameter "${key}" looks like an email address`,
      );
    }
    if (SEATGEEK_FREE_TEXT_PARAMS.has(key) && POSTAL_RE.test(trimmed)) {
      throw new PersonalDataRejectedError(
        `parameter "${key}" looks like a postal code; use a city name instead`,
      );
    }
  }
}

/** Distinguishes "no credential sent" from "credential rejected". */
export function describeAuthFailure(payload: unknown): string | null {
  const code = optNumber(payload, "code");
  if (code === 40307) {
    return "SeatGeek rejected the request with code 40307 (client is required): no credential was sent. This is a configuration error - check SEATGEEK_CLIENT_ID.";
  }
  if (code === 40302) {
    return "SeatGeek rejected the request with code 40302 (invalid client credentials): the credential was sent but refused. It is wrong or revoked - re-check the 1Password item and the client_id/client_secret pairing.";
  }
  return null;
}

export class SeatGeekClient implements Provider {
  readonly name = "seatgeek" as const;
  readonly #http: ProviderClient;
  readonly #clientIdQueryFallback: string | undefined;

  constructor(opts: SeatGeekClientOptions) {
    if (opts.clientId === "") throw new Error("SEATGEEK_CLIENT_ID is required");
    const { clientId, clientSecret, baseUrl, headers, ...rest } = opts;

    const useBasic = clientSecret !== undefined && clientSecret !== "";
    // Only fall back to the query parameter when there is no secret to do Basic
    // with. Basic keeps the credential out of the URL entirely.
    this.#clientIdQueryFallback = useBasic ? undefined : clientId;

    const authHeaders: Record<string, string> = useBasic
      ? {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
        }
      : {};

    this.#http = new ProviderClient({
      ...rest,
      name: "seatgeek",
      baseUrl: baseUrl ?? SEATGEEK_BASE_URL,
      headers: { ...headers, ...authHeaders, Accept: "application/json" },
      quota: opts.quota ?? SEATGEEK_QUOTA,
    });
  }

  status(): ProviderStatus {
    return this.#http.status();
  }

  #query(
    params: Readonly<Record<string, string | number | undefined>>,
  ): Record<string, string | number | undefined> {
    // Checked before the credential is added, so a rejection message can never
    // contain one.
    assertNoPersonalData(params);
    return this.#clientIdQueryFallback === undefined
      ? { ...params }
      : { ...params, client_id: this.#clientIdQueryFallback };
  }

  async #get(
    path: string,
    params: Readonly<Record<string, string | number | undefined>>,
  ): Promise<unknown> {
    const payload = await this.#http.requestJson({
      path,
      query: this.#query(params),
      // 403 carries the auth code we need to read; 404 is a normal miss.
      acceptStatuses: [403],
      emptyStatuses: [404],
    });
    const authMessage = describeAuthFailure(payload);
    if (authMessage !== null) {
      throw new UpstreamError({
        provider: "seatgeek",
        kind: "http",
        message: authMessage,
        status: 403,
      });
    }
    return payload;
  }

  /**
   * Finds performers by free-text name.
   *
   * Slug guessing is NOT used: `performers.slug=radiohead` returns 0 results
   * against the live API, so a slug derived from an artist name is not a
   * reliable join. Resolve an id once, cache it, then query by id forever.
   */
  async searchPerformers(
    name: string,
    limit = 10,
  ): Promise<SeatGeekPerformer[]> {
    const payload = await this.#get("/performers", {
      q: name,
      per_page: limit,
    });
    return itemsOf(payload, "performers")
      .map(parsePerformer)
      .filter((p): p is SeatGeekPerformer => p !== null);
  }

  async getPerformer(performerId: number): Promise<SeatGeekPerformer | null> {
    const payload = await this.#get(`/performers/${String(performerId)}`, {});
    return payload === null ? null : parsePerformer(payload);
  }

  /** Upcoming events. Scoped to one performer id wherever possible. */
  async listEvents(query: SeatGeekEventsQuery): Promise<SeatGeekEvent[]> {
    const params: Record<string, string | number | undefined> = {
      per_page: query.perPage ?? 20,
      sort: "datetime_utc.asc",
    };
    if (query.performerId !== undefined) {
      params["performers.id"] = query.performerId;
    }
    if (query.q !== undefined) params["q"] = query.q;
    if (query.city !== undefined) params["venue.city"] = query.city;
    if (query.state !== undefined) params["venue.state"] = query.state;
    if (query.country !== undefined) params["venue.country"] = query.country;
    // Past events are never useful to this product, and excluding them server
    // side keeps us far away from the 10,000-result cap.
    params["datetime_utc.gte"] = query.fromUtc ?? new Date().toISOString();

    const payload = await this.#get("/events", params);
    return itemsOf(payload, "events")
      .map(parseEvent)
      .filter((e): e is SeatGeekEvent => e !== null);
  }
}

/**
 * Unwraps a `{ performer: {...} }` envelope, or parses a bare performer record.
 *
 * ---------------------------------------------------------------------------
 * THE COMMENT ON THIS FUNCTION USED TO POINT AT A MODULE THAT WAS DELETED FOR
 * BEING A LICENCE BREACH, AND IT READ AS AN INVITATION TO RECREATE IT.
 *
 * It said: "Exposed for the bulk-dump backfill path; see
 * seatgeek/bulk-performers.ts". That module was deleted deliberately, not
 * misplaced. It parsed SeatGeek's hourly whole-catalogue JSONL performers dump,
 * and ingesting a whole-catalogue dump into local storage is close to the
 * definition of the "systematically downloading or storing SeatGeek Materials"
 * that terms 4.7 prohibits. The vendor-spec file records the deletion and its
 * reasoning, including the sentence "dormant code with a 'do not enable' note is
 * an invitation" - and then a stale doc comment left exactly that invitation
 * behind, naming the deleted file as though it were the intended consumer.
 *
 * The function itself is harmless and stays: it is a shape-tolerance helper, and
 * the live `/performers/{id}` endpoint is the reason to keep it. What is removed
 * is the pointer that told the next reader a bulk path was planned.
 *
 * IF A BULK PATH IS EVER WANTED, it needs a licensed bulk agreement with
 * SeatGeek first, not a parser. Re-adding one should require the conversation the
 * vendor-spec file records, and the deleted module is in git history at `705a3d8`
 * for whoever has had that conversation.
 */
export function performerRecordOf(payload: unknown): SeatGeekPerformer | null {
  const record = optRecord(payload, "performer") ?? payload;
  return parsePerformer(record);
}
