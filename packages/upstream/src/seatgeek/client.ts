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

export const SEATGEEK_ATTRIBUTION = "Event data provided by SeatGeek";

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
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly country?: string | undefined;
  readonly postalCode?: string | undefined;
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
    if (query.postalCode !== undefined) {
      params["venue.postal_code"] = query.postalCode;
    }
    // Past events are never useful to this product, and excluding them server
    // side keeps us far away from the 10,000-result cap.
    params["datetime_utc.gte"] = query.fromUtc ?? new Date().toISOString();

    const payload = await this.#get("/events", params);
    return itemsOf(payload, "events")
      .map(parseEvent)
      .filter((e): e is SeatGeekEvent => e !== null);
  }
}

/** Exposed for the bulk-dump backfill path; see seatgeek/bulk-performers.ts. */
export function performerRecordOf(payload: unknown): SeatGeekPerformer | null {
  const record = optRecord(payload, "performer") ?? payload;
  return parsePerformer(record);
}
