/**
 * Enforcement of the per-subject upstream-call budget.
 *
 * lib/upstream-budget.ts argues why the budget is denominated in upstream calls
 * rather than in requests. This file is where it meets the request lifecycle,
 * and the three hook choices below are the whole design:
 *
 *   onRequest    Opens the accounting context. FIRST, before anything can reach
 *                a provider, so no call can escape being counted.
 *   preHandler   Reserves one unit. AFTER `requireAuth`, which runs at
 *                preValidation, so `request.subject` exists and the reservation
 *                is made against a VERIFIED identity rather than against
 *                whatever the caller claimed to be.
 *   onResponse   Settles the reservation to the true cost. After the response,
 *                because the true cost is not known before it.
 *
 * WHY THERE ARE NO `RateLimit-*` HEADERS FOR THIS BUDGET
 * -----------------------------------------------------
 * The obvious thing is to emit remaining-budget headers the way the per-token
 * limiter does, and it is wrong here. This budget is spent only on a MISS, so a
 * per-request `remaining` is a cache oracle: a caller watching it learns, for
 * any identifier they choose, whether Pull.fm already holds that record. That
 * turns a rate-limit header into an enumeration primitive over the whole
 * catalogue and over what other users have caused to be resolved.
 *
 * Withholding it costs a client nothing it can act on, because the number would
 * be a window behind anyway: the settle happens after the headers are sent. The
 * only thing emitted is `Retry-After` on the refusal itself, which discloses
 * aggregate spend to the subject who spent it and nothing per-key.
 *
 * EXEMPTIONS
 * ----------
 * Health, readiness and metrics are exempt for the same reason maintenance mode
 * lets them through: an operator must be able to see the service while it is
 * refusing traffic. The documentation prefix and the OpenAPI document are exempt
 * because one page view is many requests for static assets. None of the four can
 * reach a provider, so exempting them costs no coverage.
 *
 * THE RESERVATION IS ALSO A CONCURRENCY CAP, AND THAT IS FINE
 * ----------------------------------------------------------
 * Holding a unit for the life of the request means a subject can have at most
 * `limit` requests in flight at once, which for the anonymous tier is a small
 * number and looks alarming for a large office behind one NAT address. It is
 * not, because reserve-to-settle is the handler's own duration: at single-digit
 * milliseconds, saturating five concurrent slots needs hundreds of requests per
 * second from one address, and RATE_LIMIT_MAX (300 a minute, so five a second)
 * refuses that two limiters earlier. The concurrency cap can only bind after the
 * per-IP floor already has.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { errors } from "../lib/errors.js";
import {
  withUpstreamAccount,
  type BudgetSubject,
  type BudgetReservation,
  type UpstreamAccount,
  type UpstreamBudget,
} from "../lib/upstream-budget.js";
import { DOCS_PREFIX, OPENAPI_PATH } from "./docs.js";

/** Per-request state. One object so the request augmentation stays small. */
export interface UpstreamBudgetState {
  readonly account: UpstreamAccount;
  reservation: BudgetReservation | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Null on an exempt route, and only there. */
    upstreamBudget: UpstreamBudgetState | null;
  }
}

export interface UpstreamBudgetPluginOptions {
  readonly budget: UpstreamBudget;
  /**
   * Prefixes that neither reserve nor settle. Defaults to the three endpoints
   * maintenance mode also lets through.
   */
  readonly exemptPrefixes?: readonly string[];
}

const DEFAULT_EXEMPT = [
  "/healthz",
  "/readyz",
  "/metrics",
  DOCS_PREFIX,
  OPENAPI_PATH,
] as const;

/**
 * Resolves who is spending.
 *
 * A verified subject is keyed on the USER, deliberately not on the token or the
 * session. Keying on the credential would let one account mint ten personal
 * tokens and hold ten budgets, which is the same bypass as address rotation
 * wearing a different hat. Personal tokens keep their own per-token REQUEST
 * budget in plugins/auth.ts; this is the shared upstream budget behind it.
 *
 * `req.ip` is only trustworthy because `trustProxy` is set and the origin accepts
 * connections from Cloudflare alone (M24). Without that property the anonymous
 * tier would be keyed on something the caller controls, which is worse than no
 * limiter at all because it looks like one.
 */
function subjectOfRequest(request: FastifyRequest): BudgetSubject {
  const subject = request.subject;
  if (subject !== null) {
    return { tier: "authenticated", id: subject.userId };
  }
  return { tier: "anonymous", id: request.ip };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function upstreamBudgetPlugin(
  app: FastifyInstance,
  opts: UpstreamBudgetPluginOptions,
): Promise<void> {
  const exempt = opts.exemptPrefixes ?? DEFAULT_EXEMPT;
  const isExempt = (url: string): boolean =>
    exempt.some((prefix) => url.startsWith(prefix));

  app.decorateRequest("upstreamBudget", null);

  /**
   * Opens the accounting context.
   *
   * Callback-shaped rather than async on purpose: `AsyncLocalStorage.run` with
   * Fastify's `done` as the continuation is the form that carries the context
   * through the rest of the hook chain and into the handler. `enterWith` on an
   * async hook is the version that looks equivalent and silently loses the
   * context on some paths.
   */
  app.addHook("onRequest", (request, _reply, done) => {
    if (isExempt(request.url)) {
      done();
      return;
    }
    const state: UpstreamBudgetState = {
      account: { calls: 0 },
      reservation: null,
    };
    request.upstreamBudget = state;
    withUpstreamAccount(state.account, done);
  });

  app.addHook("preHandler", async (request, reply) => {
    const state = request.upstreamBudget;
    if (state === null) return;

    const decision = await opts.budget.reserve(subjectOfRequest(request));
    if (decision.allowed) {
      state.reservation = decision.reservation;
      return;
    }

    void reply.header("retry-after", String(decision.retryAfterSeconds));
    // Deliberately says nothing about WHICH request was expensive or whether any
    // particular record was cached. See the header note on the missing headers.
    throw errors.rateLimited(
      decision.tier === "authenticated"
        ? "This account has spent its upstream data budget for now. Cached results are still served; retry shortly."
        : "Unauthenticated callers have a small upstream data budget. Sign in for a larger one, or retry shortly.",
    );
  });

  /**
   * Settles after the response.
   *
   * Not awaited into the response path and unable to fail it: `settle` swallows
   * its own errors and reports them through `onSettleFailure`. A settle that
   * never lands leaves the one reserved unit charged, which over-charges by at
   * most one unit per request and never under-charges.
   */
  app.addHook(
    "onResponse",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const state = request.upstreamBudget;
      const reservation = state?.reservation;
      if (state === null || reservation === null || reservation === undefined) {
        return;
      }
      await opts.budget.settle(reservation, state.account.calls);
    },
  );
}

export default fp(upstreamBudgetPlugin, { name: "pullfm-upstream-budget" });
