/**
 * The per-subject UPSTREAM-CALL budget.
 *
 * WHAT IS ACTUALLY SCARCE
 * -----------------------
 * Every limiter this service had before counted REQUESTS. Requests are not the
 * scarce resource. The scarce resource is a slot in a provider allowance that
 * every user shares and that cannot be bought more of. A request answered from
 * the cache costs a database read. A request that MISSES spends one of those
 * slots.
 *
 * BE PRECISE ABOUT WHICH ALLOWANCE, BECAUSE THE OBVIOUS ANSWER IS WRONG.
 * MusicBrainz's 1 req/s is the famous number here and NO REQUEST CAN REACH IT:
 * every request-path MusicBrainz read is `CachedUpstream.peek`, a database read
 * that returns null on a miss and never calls out. Only the background warmer
 * spends that budget, from its own process.
 *
 * The allowance a request really can drain is ListenBrainz labs: roughly 30
 * calls per 10 seconds, APP-WIDE, with no per-user token to spread it across.
 * `GET /v1/artists/{mbid}/similar` turns any well-formed UUID into exactly one
 * labs call with no existence check first, so a random UUID is a guaranteed miss
 * and the request-to-upstream ratio is 1:1 with no cache able to absorb it.
 * `/preview` (Deezer) and `/events` (SeatGeek) have the same shape.
 *
 * That is the cost asymmetry: one cheap HTTP request buys one unit of a budget
 * the whole service shares, the caller never repeats a key so no cache ever
 * helps, the circuit opens, and legitimate users are denied service.
 *
 * This module budgets the scarce thing instead. A subject gets N UPSTREAM CALLS
 * per window. A cache hit costs nothing at all. A miss costs exactly the number
 * of provider requests it caused, retries included, because a retry consumes a
 * real slot in the same real budget.
 *
 * IT IS NOT AN EXISTENCE CHECK, AND ONE IS STILL WANTED
 * ----------------------------------------------------
 * A UUID that appears in neither the cache nor the crosswalk cannot be a
 * legitimate lookup, and refusing it would cost a local index probe instead of a
 * network call - a strictly better answer than spending a slot and budgeting it.
 * That belongs in the route and the discovery service rather than here, so it is
 * reported rather than done: this budget bounds the damage whether or not the
 * check ever lands, and it keeps working for the routes where the identifier IS
 * legitimate and the answer simply is not cached yet.
 *
 * WHY THAT ENDS THE IP-ROTATION BYPASS
 * ------------------------------------
 * The demonstrated bypass (security/AUDIT-2026-07-29.md F12) was that the only
 * per-IP limiter was a 5,000-entry in-process LRU, so interleaving requests from
 * 5,600 addresses evicted the attacker's own throttled counter and restored a
 * full budget. Two things close it and both are needed:
 *
 *   1. The counters live in the `noeviction` QUOTA Redis, so nothing evicts them
 *      and they survive a container swap and a second node.
 *   2. The budget is keyed on the SUBJECT, not on the address. An authenticated
 *      subject is a stable identity that no amount of address rotation changes,
 *      and an unauthenticated caller gets a budget small enough that rotating
 *      addresses to farm it is not worth the addresses.
 *
 * The three routes that fan out all require an interactive SESSION, so the
 * attacker in AUDIT-2026-07-29 F13 is a signed-in account rotating addresses,
 * not an anonymous flood. A subject-keyed budget is therefore the control that
 * fits the threat: it is the first limiter in the chain that sees a verified
 * identity, and an identity does not change when the address does.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not global admission control. Fifty thousand subjects at their full
 * budget would still exceed every provider allowance combined; the controls for
 * that are the per-provider `QuotaCounter`s and the circuit breakers, which
 * already exist. This bounds what ONE subject, or one rotating set of addresses,
 * can take from the shared pool. That is the denial-of-service property, and it
 * is the one that was missing.
 *
 * It also does not lean on the kill switch. `KillSwitch` is constructed empty
 * and nothing can throw it - there is no admin route, environment variable or
 * config path that flips a provider off - so "an operator disables the provider"
 * is not an available response and no part of this design assumes it is.
 *
 * FAIL CLOSED
 * -----------
 * A budget that cannot be counted is not a budget. When the quota store refuses
 * the write the request is REFUSED, the refusal is counted on
 * `pullfm_fail_closed_total` and logged. There is precedent for getting this
 * half right: the per-token limiter's fail-closed branch was once a bare `catch`
 * that logged nothing and counted nothing, so a dead quota store produced 503s
 * indistinguishable from an upstream outage. `onFailClosed` is not optional
 * decoration here.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Redis } from "ioredis";

import { errors } from "./errors.js";

/**
 * Which budget a caller draws on.
 *
 * Two tiers rather than a continuum, because the only distinction that carries
 * security weight is whether there is a stable identity to hold responsible.
 */
export type BudgetTier = "authenticated" | "anonymous";

/** Who is spending. `id` is a user id for a subject and an address otherwise. */
export interface BudgetSubject {
  readonly tier: BudgetTier;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Per-request accounting.
//
// The budget has to charge for calls that LEFT THE PROCESS, and the only place
// that knows is `ProviderClient`, several layers below any route. Passing a
// counter down through the cache, the discovery service, the blend and every
// port would mean touching every one of them and would still miss the paths that
// reach a provider indirectly.
//
// An AsyncLocalStorage carries it instead. `ProviderClient` already emits a
// `request` event per attempt for metrics; wiring charges the ambient account
// from that same sink, so there is exactly one definition of "an upstream call
// happened" and the budget and the metric can never disagree.
//
// The context is entered with `run` from a callback-style `onRequest` hook
// rather than with `enterWith`, because `run` is the form that provably carries
// through Fastify's hook runner into the handler.
//
// SINGLE-FLIGHT INTERACTS WITH THIS CORRECTLY AND BY ACCIDENT OF THE RIGHT
// DESIGN. A coalesced caller joins a promise created inside the FIRST caller's
// context, so the fill is charged to the request that actually dispatched it and
// to nobody else. That is the honest answer: only one call left the process.
// Background jobs run outside any request, so `chargeUpstreamCall` finds no
// account and does nothing, which is also correct - the cache warmer's spend is
// nobody's per-subject budget.
// ---------------------------------------------------------------------------

/** Mutable because it is incremented from deep inside a provider call. */
export interface UpstreamAccount {
  calls: number;
}

const accounting = new AsyncLocalStorage<UpstreamAccount>();

/**
 * Runs `next` with `account` as the ambient upstream account.
 *
 * Callback-shaped so it can be handed a Fastify `done` directly.
 */
export function withUpstreamAccount(
  account: UpstreamAccount,
  next: () => void,
): void {
  accounting.run(account, next);
}

/**
 * Records one upstream request against whatever account is ambient.
 *
 * Silent when there is none. A metrics sink must never be able to fail a
 * request, and this runs from one.
 */
export function chargeUpstreamCall(): void {
  const account = accounting.getStore();
  if (account !== undefined) account.calls += 1;
}

/** The ambient account, for tests and for assertions. Null outside a request. */
export function currentUpstreamAccount(): UpstreamAccount | null {
  return accounting.getStore() ?? null;
}

// ---------------------------------------------------------------------------
// The budget.
// ---------------------------------------------------------------------------

/**
 * Reserve, then settle.
 *
 * A request cannot know how many upstream calls it will make until it has made
 * them, and waiting until it knows would let a hundred concurrent requests all
 * observe a full budget and all spend it. So one unit is RESERVED before the
 * handler runs and the reservation is settled to the true cost afterwards:
 *
 *   0 calls (a pure cache hit)  settled to 0. The hit was free.
 *   n calls                     settled to n. The miss cost what it spent.
 *
 * The reservation is what makes concurrency safe: at most `limit` requests can
 * be in flight against one subject at once, because the reservation is an atomic
 * check-and-increment. The settle can push the counter ABOVE the limit when a
 * request turns out to have been expensive, which is deliberate: a request
 * already in flight is allowed to finish and to pay for what it really used, and
 * the next reservation then sees the overrun and refuses.
 */
export interface BudgetReservation {
  readonly key: string;
  readonly tier: BudgetTier;
  readonly limit: number;
  /** Units held while the request is in flight. Always 1 today. */
  readonly reserved: number;
  /** Counter value after the reservation. */
  readonly count: number;
  readonly ttlSeconds: number;
}

export type BudgetDecision =
  | { readonly allowed: true; readonly reservation: BudgetReservation }
  | {
      readonly allowed: false;
      readonly tier: BudgetTier;
      readonly limit: number;
      readonly retryAfterSeconds: number;
    };

export interface UpstreamBudgetOptions {
  /** Upstream calls a signed-in subject may cause per window. */
  readonly authenticatedMax: number;
  /** Upstream calls an unauthenticated caller may cause per window. */
  readonly anonymousMax: number;
  readonly windowSeconds: number;
  /**
   * Called when the quota store could not be consulted and the request is being
   * refused because of it. Counted AND logged by the caller; see the header.
   */
  readonly onFailClosed?: () => void;
  /**
   * Called when a settle could not be written. Not a refusal: the response has
   * already been sent. The reservation simply stands, which errs toward
   * over-charging the subject rather than under-charging, and that is the safe
   * direction for a control whose failure mode is otherwise "no limit at all".
   */
  readonly onSettleFailure?: (err: unknown) => void;
  /** Injectable clock, so a window-boundary test does not have to wait. */
  readonly now?: () => number;
}

/**
 * Atomic check-and-increment.
 *
 * `GET` then `INCRBY` in one script, so two concurrent reservations cannot both
 * observe `count = limit - 1`. Rejecting at `current >= limit` rather than after
 * incrementing is what keeps a refused request from consuming budget: a caller
 * who is already over must not be able to push the counter further out and
 * extend their own lockout.
 */
/**
 * A marker both budget scripts carry.
 *
 * The adversarial suite has to sever THIS control's store access without also
 * severing the global limiter's, which shares the same client and the same
 * `eval`. Matching on the script text is how a test targets one of them; a
 * marker makes that match deliberate rather than a coincidence of wording that
 * a later edit would silently break.
 */
export const BUDGET_SCRIPT_MARKER = "-- pullfm:upstream-budget";

const RESERVE = `
${BUDGET_SCRIPT_MARKER}
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', KEYS[1])) or 0
if current >= limit then
  local ttl = redis.call('TTL', KEYS[1])
  return {0, current, ttl}
end
local updated = redis.call('INCRBY', KEYS[1], cost)
if updated == cost then
  redis.call('EXPIRE', KEYS[1], window)
end
return {1, updated, redis.call('TTL', KEYS[1])}
`;

/**
 * Applies the difference between what was reserved and what was spent.
 *
 * Guarded on the TTL for one reason that is easy to miss: if the window has
 * already rolled over, the key is gone, and a bare `INCRBY` would recreate it
 * with NO EXPIRY. A counter with no expiry is a subject permanently throttled by
 * a refund, which is the funniest possible way to build a denial of service into
 * a denial-of-service control.
 */
const SETTLE = `
${BUDGET_SCRIPT_MARKER}
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  return -1
end
local updated = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
if updated < 0 then
  redis.call('INCRBY', KEYS[1], -updated)
  updated = 0
end
return updated
`;

/**
 * The key a subject's budget is counted under.
 *
 * Fixed window, matching the per-token limiter next door: an at-most-2x burst
 * across a window boundary is acceptable for a budget whose purpose is to stop
 * sustained monopolisation, and a per-request sorted-set write on the quota
 * instance is not.
 *
 * The address goes in raw for the anonymous tier, exactly as the Magic Auth
 * budgets already do. An address is not a secret and hashing it here would make
 * an operator unable to answer "which address is doing this" during the incident
 * the counter exists to detect.
 */
export function upstreamBudgetKey(
  subject: BudgetSubject,
  windowSeconds: number,
  nowMs: number,
): string {
  const window = Math.floor(nowMs / 1000 / windowSeconds);
  return `quota:upstream:${subject.tier}:${subject.id}:${String(window)}`;
}

export class UpstreamBudget {
  readonly #redis: Redis;
  readonly #opts: UpstreamBudgetOptions;
  readonly #now: () => number;

  constructor(redis: Redis, opts: UpstreamBudgetOptions) {
    this.#redis = redis;
    this.#opts = opts;
    this.#now = opts.now ?? (() => Date.now());
  }

  limitFor(tier: BudgetTier): number {
    return tier === "authenticated"
      ? this.#opts.authenticatedMax
      : this.#opts.anonymousMax;
  }

  /**
   * Holds one unit against the subject's budget.
   *
   * Throws a 503 rather than returning a decision when the store cannot be
   * reached, because there is no honest decision to return: admitting would fail
   * open, and a caller that had to distinguish "refused" from "unknowable" would
   * eventually get it wrong.
   */
  async reserve(subject: BudgetSubject): Promise<BudgetDecision> {
    const limit = this.limitFor(subject.tier);
    const window = this.#opts.windowSeconds;
    const key = upstreamBudgetKey(subject, window, this.#now());

    let raw: [number, number, number];
    try {
      raw = (await this.#redis.eval(
        RESERVE,
        1,
        key,
        String(limit),
        String(window),
        "1",
      )) as [number, number, number];
    } catch {
      // Fail CLOSED. THREAT-MODEL T11 is about this failure being silent; the
      // notification is what makes it an alert rather than an anomaly in a
      // latency graph.
      this.#opts.onFailClosed?.();
      throw errors.upstreamUnavailable("upstream budget");
    }

    const [allowed, count, ttl] = raw;
    const ttlSeconds = ttl < 0 ? window : ttl;

    if (allowed !== 1) {
      return {
        allowed: false,
        tier: subject.tier,
        limit,
        retryAfterSeconds: ttlSeconds,
      };
    }
    return {
      allowed: true,
      reservation: {
        key,
        tier: subject.tier,
        limit,
        reserved: 1,
        count,
        ttlSeconds,
      },
    };
  }

  /**
   * Settles a reservation against what the request actually spent.
   *
   * Never throws. The response has already been sent by the time this runs, so
   * the only thing a throw could achieve is an unhandled rejection.
   */
  async settle(
    reservation: BudgetReservation,
    upstreamCalls: number,
  ): Promise<void> {
    const delta = upstreamCalls - reservation.reserved;
    if (delta === 0) return;
    try {
      await this.#redis.eval(SETTLE, 1, reservation.key, String(delta));
    } catch (err) {
      this.#opts.onSettleFailure?.(err);
    }
  }

  /** Current spend for a subject. Exposed for tests and for the runbook. */
  async spent(subject: BudgetSubject): Promise<number> {
    const key = upstreamBudgetKey(
      subject,
      this.#opts.windowSeconds,
      this.#now(),
    );
    const value = await this.#redis.get(key);
    return value === null ? 0 : Number.parseInt(value, 10);
  }
}
