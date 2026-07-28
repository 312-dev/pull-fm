/**
 * Structured logging with mandatory credential redaction.
 *
 * Gate 3 requires proving that no plaintext per-user token ever reaches a log
 * sink. Three layers enforce that, because any one of them alone has a known
 * bypass:
 *
 *   1. This redaction config, which handles known field paths.
 *   2. A custom Semgrep rule (.semgrep/pullfm.yml) that fails CI when a token
 *      field is passed to a logger at all.
 *   3. A serializer allowlist on requests, so headers are never logged wholesale.
 *
 * Redaction alone is insufficient: it only catches paths someone remembered to
 * list. The Semgrep rule is what catches the field nobody thought of.
 */

import { pino, type LoggerOptions } from "pino";

/**
 * Field paths scrubbed from every log record.
 *
 * Wildcards cover nesting depth, since a credential usually arrives inside an
 * upstream response body or an error `cause` chain rather than at the top level.
 */
const REDACTED_PATHS = [
  // Per-user third-party credentials: the highest-value asset in the system.
  "*.accessToken",
  "*.refreshToken",
  "*.sessionKey",
  "*.userToken",
  "*.access_token",
  "*.refresh_token",
  "*.session_key",
  "*.user_token",
  "accessToken",
  "refreshToken",
  "sessionKey",
  "userToken",

  // Envelope material. Ciphertext is not secret, but the keys are.
  "*.dek",
  "*.wrappedDek",
  "*.kek",
  "plaintext",
  "*.plaintext",

  // Application secrets.
  "*.apiKey",
  "*.apiSecret",
  "*.clientSecret",
  "*.sharedSecret",
  "*.password",

  // Request-borne credentials. Authorization is the common accidental leak,
  // and cookies carry the session.
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
];

/**
 * Fields kept when logging a request.
 *
 * An allowlist rather than a denylist: logging the whole header object and
 * hoping redaction catches everything is how tokens end up in Loki.
 */
function requestSerializer(req: {
  method: string;
  url: string;
  id?: string;
  ip?: string;
  headers?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    // Query strings can carry a search term or a token in a misused client.
    // Only the path is logged; handlers log specific validated params instead.
    path: req.url.split("?")[0],
    // Retained for abuse investigation. Covered by the log retention policy
    // rather than dropped, since it is needed to identify a scraper.
    ip: req.ip,
    userAgent: req.headers?.["user-agent"],
  };
}

function responseSerializer(res: {
  statusCode: number;
}): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

/**
 * Serializes errors without leaking a credential through the `cause` chain.
 *
 * Upstream client libraries routinely attach the full request, including the
 * Authorization header, to a thrown error. Passing that to the default pino
 * error serializer would defeat every other control here.
 */
function errorSerializer(err: Error): Record<string, unknown> {
  return {
    type: err.name,
    message: err.message,
    // Stacks are safe and necessary; request/response bodies attached by HTTP
    // clients are deliberately not included.
    stack: err.stack,
  };
}

export interface LoggerConfig {
  readonly level: string;
  readonly isProduction: boolean;
  readonly deployEnv: string;
}

/**
 * Builds pino options rather than a pino instance.
 *
 * Fastify accepts logger options directly and constructs the logger itself,
 * which keeps the app's type parameters at their defaults. Passing a
 * pre-built instance forces every route's generics to be rewritten around the
 * concrete logger type, for no benefit.
 */
export function loggerOptions(cfg: LoggerConfig): LoggerOptions {
  return {
    level: cfg.level,
    redact: {
      paths: REDACTED_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      req: requestSerializer,
      res: responseSerializer,
      err: errorSerializer,
      error: errorSerializer,
    },
    base: {
      service: "pull-fm-bff",
      env: cfg.deployEnv,
    },
    formatters: {
      // Log the level as a word. Numeric levels are unreadable in Loki queries.
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  } satisfies LoggerOptions;
}

/** Exposed for the Gate 3 test that asserts the redaction list is enforced. */
export const redactedPaths: readonly string[] = REDACTED_PATHS;
