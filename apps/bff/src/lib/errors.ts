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

  constructor(
    status: number,
    type: string,
    title: string,
    detail?: string,
    fieldErrors?: readonly { field: string; message: string }[],
  ) {
    super(detail ?? title);
    this.status = status;
    this.type = `${TYPE_BASE}/${type}`;
    this.title = title;
    if (fieldErrors !== undefined) {
      this.fieldErrors = fieldErrors;
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
