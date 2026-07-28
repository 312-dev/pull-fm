/**
 * Wire-shape helpers: what each provider actually puts on the wire when it is
 * healthy, throttled, or broken.
 *
 * Every shape here is modeled from the provider's documented or commonly
 * observed behavior. Where a header name or status code could not be verified
 * against live traffic it is marked MODELED, and it is tunable from
 * POST /__admin/config so a re-audit corrects it without a code change.
 */

/** Rate-limit headers a provider attaches, by style. */
export function rateLimitHeaders(style, info) {
  switch (style) {
    case "musicbrainz":
      // MusicBrainz exposes the classic X-RateLimit trio. Note the absence of
      // Retry-After: a client that waits only when told to will hammer it.
      return {
        "x-ratelimit-limit": String(info.limit),
        "x-ratelimit-remaining": String(info.remaining),
        "x-ratelimit-reset": String(Math.floor(info.resetAt / 1000)),
      };
    case "listenbrainz":
      // ListenBrainz sends reset-in (relative seconds) alongside the absolute
      // reset, which is the pair the BFF's backoff should prefer.
      return {
        "x-ratelimit-limit": String(info.limit),
        "x-ratelimit-remaining": String(info.remaining),
        "x-ratelimit-reset-in": String(info.resetInSeconds),
        "x-ratelimit-reset": String(Math.floor(info.resetAt / 1000)),
      };
    case "generic":
      return {
        "x-ratelimit-limit": String(info.limit),
        "x-ratelimit-remaining": String(info.remaining),
      };
    default:
      return {};
  }
}

/** The body and content type a provider returns when it refuses on quota. */
export function rateLimitBody(provider, info) {
  switch (provider) {
    case "musicbrainz":
      return {
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          error:
            "Your requests are exceeding the allowable rate limit. Please see https://musicbrainz.org/doc/XML_Web_Service/Rate_Limiting for more information.",
        }),
      };
    case "listenbrainz":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          code: 429,
          error: `Rate limit exceeded. Please wait ${info.resetInSeconds} seconds.`,
        }),
      };
    case "lastfm":
      // Last.fm error 29 is literally "Rate limit exceeded".
      return {
        contentType: "application/json",
        body: JSON.stringify({
          error: 29,
          message:
            "Rate limit exceeded - Your IP has made too many requests in a short period",
        }),
      };
    case "itunes":
      // MODELED: Apple returns a plain-text refusal, not JSON. A client that
      // calls res.json() on this throws instead of backing off.
      return {
        contentType: "text/plain; charset=utf-8",
        body: "Your request produced too many results or you have exceeded the allowed number of calls per minute.",
      };
    case "deezer":
      // Deezer answers HTTP 200 with an error object. This is the single most
      // dangerous shape in the set and the reason the mock exists.
      return {
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          error: {
            type: "Exception",
            message: "Quota limit exceeded",
            code: 4,
          },
        }),
      };
    default:
      return {
        contentType: "application/json",
        body: JSON.stringify({ error: "rate limit exceeded" }),
      };
  }
}

/** The body a provider returns on an internal failure. */
export function serverErrorBody(provider) {
  switch (provider) {
    case "listenbrainz":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          code: 500,
          error: "Currently disabled due to high load",
        }),
      };
    case "lastfm":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          error: 8,
          message: "Operation failed - Something else went wrong",
        }),
      };
    case "musicbrainz":
      return {
        contentType: "text/html; charset=utf-8",
        // MusicBrainz returns an HTML error page on 5xx, not JSON. A client
        // that assumes JSON on every response throws here.
        body: "<!DOCTYPE html><html><head><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>",
      };
    default:
      return {
        contentType: "application/json",
        body: JSON.stringify({ error: "internal server error" }),
      };
  }
}

/** Write a descriptor produced by a provider handler. */
export function send(res, descriptor) {
  const headers = {
    "content-type": descriptor.contentType ?? "application/json; charset=utf-8",
    // Marks every byte in this run as synthetic. If this header ever shows up
    // in a production trace, something is pointed at the wrong place.
    "x-pullfm-mock": "upstream",
    ...(descriptor.headers ?? {}),
  };
  const body =
    typeof descriptor.body === "string"
      ? descriptor.body
      : JSON.stringify(descriptor.body ?? {});
  headers["content-length"] = Buffer.byteLength(body);
  res.writeHead(descriptor.status ?? 200, headers);
  res.end(body);
}
