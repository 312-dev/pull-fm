/**
 * RFC 9457 problem+json error responses.
 *
 * One error shape across the whole API, decided before the client exists so it
 * never has to special-case a handler that invented its own format.
 *
 * The security property that matters here: an unexpected error must never leak
 * its message to the client. Upstream client libraries attach request details,
 * including Authorization headers, to thrown errors, so echoing `err.message`
 * on a 500 is a credible way to leak a credential to an attacker who can
 * trigger the failure. Unexpected errors return a fixed string and are
 * correlated to the log by request id.
 */

/** An RFC 9457 problem document. */
export interface ProblemDetails {
  /** Stable URI identifying the error class. Clients switch on this. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Field-level validation failures, when applicable. */
  errors?: readonly { field: string; message: string }[];
  /**
   * RFC 9457 extension members, for a problem class where the client needs data
   * as well as an explanation.
   *
   * There is exactly one today (`consent`), and it has to be DECLARED in
   * `problemSchema` as well as set here. That is not documentation: Fastify
   * serialises problem bodies with fast-json-stringify against the route's
   * declared 4xx schema, so an extension member the schema does not know about is
   * silently dropped on the wire. An undeclared extension is therefore a missing
   * field rather than an undocumented one, which is the same M12 property the
   * success schemas rely on, applied to failures.
   */
  consent?: unknown;
}

const TYPE_BASE = "https://pull.fm/problems";

/**
 * An error that is safe to describe to the client.
 *
 * Throwing this is an explicit assertion that the message contains no secret
 * and no internal detail. Everything else is treated as untrusted.
 */
export class ApiError extends Error {
  public override readonly name = "ApiError";
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly fieldErrors?: readonly { field: string; message: string }[];
  /** Declared extension members. See `ProblemDetails.consent`. */
  readonly extensions?: Readonly<Pick<ProblemDetails, "consent">>;

  constructor(
    status: number,
    type: string,
    title: string,
    detail?: string,
    fieldErrors?: readonly { field: string; message: string }[],
    extensions?: Readonly<Pick<ProblemDetails, "consent">>,
  ) {
    super(detail ?? title);
    this.status = status;
    this.type = `${TYPE_BASE}/${type}`;
    this.title = title;
    if (fieldErrors !== undefined) {
      this.fieldErrors = fieldErrors;
    }
    if (extensions !== undefined) {
      this.extensions = extensions;
    }
  }

  toProblem(instance?: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: this.type,
      title: this.title,
      status: this.status,
    };
    if (this.message !== this.title) problem.detail = this.message;
    if (instance !== undefined) problem.instance = instance;
    if (this.fieldErrors !== undefined) problem.errors = this.fieldErrors;
    if (this.extensions?.consent !== undefined) {
      problem.consent = this.extensions.consent;
    }
    return problem;
  }
}

export const errors = {
  badRequest: (
    detail?: string,
    fields?: readonly { field: string; message: string }[],
  ) => new ApiError(400, "bad-request", "Bad Request", detail, fields),

  unauthorized: (detail = "Authentication is required.") =>
    new ApiError(401, "unauthorized", "Unauthorized", detail),

  /**
   * Used for authorization failures on objects the caller does not own.
   *
   * Note the deliberate choice in `notFound` below: for user-scoped objects we
   * return 404 rather than 403, so an attacker cannot enumerate which ids exist
   * by distinguishing "exists but forbidden" from "does not exist".
   */
  forbidden: (detail = "You do not have access to this resource.") =>
    new ApiError(403, "forbidden", "Forbidden", detail),

  notFound: (detail = "The requested resource does not exist.") =>
    new ApiError(404, "not-found", "Not Found", detail),

  conflict: (detail?: string) =>
    new ApiError(409, "conflict", "Conflict", detail),

  /** An Idempotency-Key was reused with a different request body. */
  idempotencyConflict: () =>
    new ApiError(
      409,
      "idempotency-key-reuse",
      "Idempotency Key Reused",
      "This Idempotency-Key was already used with a different request body.",
    ),

  unprocessable: (
    detail?: string,
    fields?: readonly { field: string; message: string }[],
  ) =>
    new ApiError(422, "unprocessable", "Unprocessable Content", detail, fields),

  rateLimited: (detail = "Too many requests. Slow down and retry later.") =>
    new ApiError(429, "rate-limited", "Too Many Requests", detail),

  /**
   * The service is not offered in the caller's region.
   *
   * 451 RATHER THAN 403, AND THE CHOICE IS ARGUED RATHER THAN INHERITED.
   * RFC 7725 defines 451 for a refusal that is a legal position rather than an
   * access-control outcome, which is exactly what this is: nothing is wrong
   * with the caller's credential, there is nothing they could present that
   * would work, and a retry is pointless. 403 says "you are not permitted",
   * which a client reasonably answers by sending a credential, and 404 would be
   * a lie about a route that plainly exists. A distinct code also lets a client
   * render the real explanation instead of bouncing the user around a sign-in
   * loop forever.
   *
   * THE MESSAGE IS DELIBERATELY UNINFORMATIVE ABOUT MECHANISM. It says the
   * service is not offered where the caller is; it does not say what we think
   * their country is, that a header was consulted, or which branch of
   * lib/registration-geo.ts produced the answer. An unavailable region, an
   * undetermined one, and a request that did not arrive through the edge all
   * return this identical body, so the refusal cannot be used as an oracle for
   * probing the control.
   *
   * It is also not hostile. The person on the other end has done nothing wrong,
   * and a refusal that reads as an accusation is both unpleasant and a support
   * ticket.
   */
  regionUnavailable: () =>
    new ApiError(
      451,
      "region-unavailable",
      "Unavailable For Legal Reasons",
      "Pull.fm is not offered in your region, so this request was not carried out. " +
        "No message was sent and no account was created.",
    ),

  /**
   * Account formation is refused because Pull.fm is in a closed beta.
   *
   * 403 RATHER THAN 451, 503, 404 OR 401, AND THE CHOICE IS ARGUED RATHER THAN
   * COPIED FROM THE REFUSAL NEXT DOOR.
   *
   *   NOT 451. `regionUnavailable` above is a 451 for a good reason and it does
   *            not transfer. RFC 7725 is for a refusal that is a LEGAL position -
   *            there is nothing the caller could present, and no future date at
   *            which the answer changes. A closed beta is neither: it is a
   *            product decision that ends, and reusing 451 would tell a client
   *            "never" about something that means "not yet". It would also
   *            collapse two unrelated facts into one status code, so an operator
   *            reading a dashboard could no longer tell a European sign-up
   *            attempt from a curious stranger.
   *   NOT 503. Tempting, because "the service is not open" is true and says
   *            nothing about the address. Refused because 503 in this repository
   *            already means an outage or maintenance (see `maintenance` and
   *            `upstreamUnavailable`, and the 503 description in lib/schemas.ts).
   *            A permanent 503 producer on the sign-in route would make every
   *            error-rate panel and the node watchdog unable to distinguish a
   *            closed beta from a broken staging environment.
   *   NOT 404. It would be a lie about a route that plainly exists, which is the
   *            same reason `regionUnavailable` refused it.
   *   NOT 401. The caller has no credential and could not obtain one that helps.
   *            A client that sees 401 refreshes or restarts sign-in, and on the
   *            sign-in route itself that is a loop with no exit.
   *
   * 403 is what is left and it is also the honest reading: RFC 9110 says the
   * server understood the request and refuses to authorize it, which is exactly
   * what happened. `consentRequired` below reached the same status by the same
   * route, and the distinct `type` URI is what a client actually switches on.
   *
   * THE MESSAGE IS ONE STRING FOR EVERY REFUSED ADDRESS, AND THAT IS THE WHOLE
   * CONTROL. It does not say whether the address is on a list, whether a list
   * exists, whether the address is known, or what the caller could do about it.
   * A refusal that differed between "your address is not on the list" and "the
   * service is not open" would turn this route into a way to DISCOVER WHICH
   * ADDRESSES ARE ALLOWLISTED, one probe at a time - which is the same
   * enumeration oracle `/v1/auth/start` spends thirty lines refusing to be for
   * account existence, reintroduced through the back door. There is one body, and
   * test/security/registration-allowlist.test.ts asserts it is byte-identical for
   * a near-miss address and a plainly unrelated one.
   *
   * It is also not hostile. Nobody who reaches it has done anything wrong.
   */
  registrationClosed: () =>
    new ApiError(
      403,
      "registration-closed",
      "Forbidden",
      "Pull.fm is in a closed beta, so this request was not carried out. " +
        "No message was sent and no account was created.",
    ),

  /**
   * The caller has not accepted the current legal documents.
   *
   * 403 RATHER THAN 401, 409 OR 428, AND THE CHOICE IS ARGUED RATHER THAN
   * INHERITED.
   *
   *   NOT 401. The credential is perfectly valid and re-authenticating changes
   *            nothing. A client that receives 401 refreshes its token or bounces
   *            the user through sign-in, which here is an infinite loop that ends
   *            with the user reinstalling the app. Same reasoning as
   *            `regionUnavailable` refusing to be a 403.
   *   NOT 409. Nothing about the request conflicts with server state. The
   *            request is well formed and the caller simply is not permitted to
   *            make it yet, which is what 403 means.
   *   NOT 428. `Precondition Required` is about conditional requests and
   *            If-Match, and reusing it here would put a legal gate in the same
   *            bucket as an ETag mismatch for every intermediary and library that
   *            handles 428 specially.
   *
   * The distinct `type` URI is what the client actually switches on, and the
   * `consent` extension member carries the documents to display, so a cold-started
   * client learns what to render from the refusal itself rather than needing a
   * second round trip to discover it.
   *
   * The message names the two ways out - accept, or delete the account - because
   * a refusal that offers no exit is a trap, and refusing to accept the Terms has
   * to remain a real option. `DELETE /v1/me` and `GET /v1/me/export` are never
   * gated by this; see the exemptions in plugins/auth.ts.
   */
  consentRequired: (
    reason: "never-accepted" | "revision-pending",
    outstanding: unknown,
  ) =>
    new ApiError(
      403,
      "consent-required",
      "Forbidden",
      reason === "never-accepted"
        ? "You have not accepted the Pull.fm Terms of Service and Privacy Policy. Accept them at " +
            "POST /v1/me/consent, or delete your account at DELETE /v1/me. Reading your own account and " +
            "exporting or deleting your data are not gated by this."
        : "The Terms of Service or Privacy Policy have changed materially since you last accepted them, " +
            "so this write was refused. Reading still works. Accept the current versions at " +
            "POST /v1/me/consent, or delete your account at DELETE /v1/me.",
      undefined,
      { consent: { reason, outstanding } },
    ),

  /**
   * A required upstream is unavailable or the circuit breaker is open.
   *
   * Distinct from a generic 500 so clients can retry sensibly and so
   * dashboards can separate our faults from a provider's.
   */
  upstreamUnavailable: (provider: string) =>
    new ApiError(
      503,
      "upstream-unavailable",
      "Upstream Unavailable",
      `The ${provider} service is temporarily unavailable. Some results may be missing.`,
    ),

  maintenance: () =>
    new ApiError(
      503,
      "maintenance",
      "Service Unavailable",
      "Pull.fm is briefly down for maintenance. Please retry shortly.",
    ),

  notImplemented: (detail: string) =>
    new ApiError(501, "not-implemented", "Not Implemented", detail),
} as const;

/**
 * The fixed body returned for any error we did not construct deliberately.
 *
 * No detail, ever. The request id is the only correlation handed to the client.
 */
export function internalProblem(instance?: string): ProblemDetails {
  const problem: ProblemDetails = {
    type: `${TYPE_BASE}/internal`,
    title: "Internal Server Error",
    status: 500,
    detail:
      "An unexpected error occurred. Quote the instance id if you contact support.",
  };
  if (instance !== undefined) problem.instance = instance;
  return problem;
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
