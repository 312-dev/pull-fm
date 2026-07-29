/**
 * Magic Auth: the only interactive sign-in this application has.
 *
 * The architectural decision behind that, and the two things a future reader
 * will be tempted to add, are argued in full at the top of services/workos.ts.
 * The one-line version: `authenticateWithMagicAuth` is a server-to-server call,
 * so every screen in the sign-in flow is ours and the user never sees a hosted
 * page or a hostname they do not recognise. Social login and passkeys both give
 * that up. Do not add either without reading that comment first.
 *
 * This module owns the two properties that make the flow safe to expose to the
 * open internet, neither of which belongs in a route handler:
 *
 *   1. It must not disclose whether an address has an account.
 *   2. It must not be usable to flood a mailbox or to guess a code.
 *
 * ---------------------------------------------------------------------------
 * 1. NON-DISCLOSURE, INCLUDING THROUGH THE CLOCK
 *
 * `requestCode` returns the same thing for a registered address, an unregistered
 * one, and one WorkOS refused. That handles the response body. It does not
 * handle timing, and timing is the half that is usually forgotten: if a known
 * address takes 400ms upstream and an unknown one is rejected in 40ms, the
 * response body is irrelevant because the clock answered the question.
 *
 * So every call is padded to a floor (AUTH_START_FLOOR_MS). This is not
 * constant-time and is not claimed to be: an upstream slower than the floor
 * still varies, and a determined attacker with enough samples can see through
 * statistical noise. What it removes is the trivially observable, single-sample
 * difference, which is the version of this leak that actually gets exploited.
 * The honest framing is "as far as is practical", and the residual is recorded
 * here rather than hidden behind a claim of constant time.
 *
 * ---------------------------------------------------------------------------
 * 2. BUDGETS, IN THE `noeviction` REDIS
 *
 * Every counter here lives in the QUOTA Redis, never the cache instance.
 * Eviction policy in Redis is per instance: on `allkeys-lru` a cache-fill event
 * silently evicts these counters and the abuse controls are simply absent, with
 * no error and no alert. That is THREAT-MODEL T11, and it is the same reasoning
 * that puts the session revocation deny list on the same instance.
 *
 * Three budgets, because they stop three different attacks:
 *
 *   per IP, send      one host spraying many addresses to enumerate them.
 *   per address, send many hosts pointed at one mailbox. This is mail bombing,
 *                     it is what a botnet produces, and a per-IP limit cannot
 *                     see it at all.
 *   per address, verify
 *                     guessing the code. Much tighter than the send budgets,
 *                     because a short numeric code is guessable at volume in a
 *                     way that a request for one is not. WorkOS applies its own
 *                     limit; ours exists because relying on an upstream control
 *                     we cannot inspect or test is not a control.
 *
 * All three fail CLOSED. A rate limiter that fails open is not a rate limiter,
 * and on this route failing open means an open mail relay pointed at arbitrary
 * third parties.
 *
 * ---------------------------------------------------------------------------
 * THE SEND BUDGETS PROTECT SOMETHING BEYOND MAILBOXES. READ THIS BEFORE
 * RETUNING THEM.
 *
 * `POST /user_management/magic_auth/send` CREATES a WorkOS user when the
 * address does not already have one (verified against the live API on
 * 2026-07-29). `POST /v1/auth/start` is unauthenticated. So these two send
 * budgets are also the PRIMARY BOUND ON DIRECTORY POLLUTION: they decide how
 * fast an anonymous caller can cause personal-data records to be created for
 * people who never consented and are not users.
 *
 * That is a GDPR Article 6 problem, not a tidiness one, and it is why raising
 * these numbers is a bigger decision than it looks. The companion control is
 * services/directory-reaper.ts, which bounds how LONG such a record survives.
 * Rate and duration are independent: loosening these budgets is not compensated
 * for by the reaper, because the reaper does not care how many records appeared
 * inside its window.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * THE ADDRESS IS NEVER A KEY, AND NEVER AN AUDIT VALUE
 *
 * Counter keys and audit rows carry a truncated SHA-256 of the address, not the
 * address. Two reasons, both concrete. Redis keys turn up in `SCAN` output,
 * `MONITOR`, slow logs and support screenshots, and an email address is
 * personal data that would then be sitting in a store with no retention policy.
 * And `audit_log` rows deliberately outlive the user (migration 0002 says so),
 * so writing an address there would create a record of a person that survives
 * their own erasure request.
 *
 * The digest is not reversible in bulk but it is enumerable if an attacker
 * already has a candidate address, which is fine: it is a correlation handle
 * for an incident, not a secret.
 */

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { Redis } from "ioredis";

import { errors } from "../lib/errors.js";
import { incrementWindow } from "../lib/redis.js";
import type { WorkOsClient, WorkOsSession } from "./workos.js";

export interface MagicAuthOptions {
  readonly perIpMax: number;
  readonly perEmailMax: number;
  readonly verifyMax: number;
  readonly windowSeconds: number;
  readonly floorMs: number;
}

/**
 * How long a client should be told a code lasts.
 *
 * WorkOS's own lifetime, restated so a client can render a countdown. It is
 * advisory: the authoritative expiry is enforced by WorkOS at exchange time,
 * and a code that has expired produces the same 401 as a wrong one.
 */
export const MAGIC_AUTH_CODE_TTL_S = 600;

/**
 * Normalises an address for keying and storage.
 *
 * Case folding only. Deliberately NOT dot-stripping or plus-stripping: those
 * are Gmail-specific behaviours, applying them to every provider merges
 * genuinely distinct mailboxes at other hosts, and merging two people's
 * accounts is a worse outcome than letting one person hold two.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Stable, non-reversible handle for an address. Never the address itself. */
export function emailKey(email: string): string {
  return createHash("sha256")
    .update(normalizeEmail(email), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export class MagicAuthService {
  readonly #workos: WorkOsClient;
  readonly #quota: Redis;
  readonly #opts: MagicAuthOptions;

  constructor(workos: WorkOsClient, quota: Redis, opts: MagicAuthOptions) {
    this.#workos = workos;
    this.#quota = quota;
    this.#opts = opts;
  }

  /**
   * Consumes one unit of a budget, failing closed.
   *
   * A Redis error is turned into 503 rather than being ignored. THREAT-MODEL
   * T11 is about this failure being SILENT; here it is the loudest thing the
   * route can do.
   */
  async #consume(key: string, limit: number): Promise<void> {
    let count: number;
    try {
      ({ count } = await incrementWindow(
        this.#quota,
        key,
        this.#opts.windowSeconds,
      ));
    } catch {
      throw errors.upstreamUnavailable("rate limiter");
    }
    if (count > limit) {
      throw errors.rateLimited(
        "Too many sign-in attempts. Wait a few minutes and try again.",
      );
    }
  }

  /**
   * Requests a code for an address.
   *
   * Always resolves, for every address, unless a budget is exhausted or a
   * dependency is down. The caller renders one 202 and learns nothing from
   * this method about whether the address exists, because this method returns
   * nothing that could tell it.
   *
   * Order matters and is deliberate. The IP budget is consumed BEFORE the
   * address budget, so an attacker cannot exhaust a victim's per-address budget
   * for free from a host that has already used up its own allowance. And both
   * budgets are consumed before the upstream call, so a caller who is already
   * over the limit cannot make us send mail at all.
   */
  async requestCode(email: string, ip: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const normalized = normalizeEmail(email);
      await this.#consume(`quota:auth:start:ip:${ip}`, this.#opts.perIpMax);
      await this.#consume(
        `quota:auth:start:email:${emailKey(normalized)}`,
        this.#opts.perEmailMax,
      );

      // The outcome is deliberately discarded. It is the only place in this
      // application where an upstream answer is thrown away on purpose, and
      // that is the anti-enumeration control: "declined" and "sent" must be
      // indistinguishable to the caller, so nothing downstream is allowed to
      // see which one happened. A 5xx still throws out of here, because an
      // outage is a fact about us rather than about the address.
      await this.#workos.sendMagicAuthCode(normalized);
    } finally {
      // In `finally` so a rate-limited or failed request is padded too.
      // Otherwise the fast path becomes its own signal.
      await this.#pad(startedAt);
    }
  }

  /**
   * Exchanges a code for a session.
   *
   * The budget is consumed before the exchange, so an exhausted budget cannot
   * be spent on further guesses, and it is keyed on the ADDRESS rather than the
   * IP so rotating source addresses does not buy more attempts. Both keys are
   * consumed: the IP budget also applies, because a single host walking many
   * addresses is a different attack from many hosts walking one.
   */
  async verifyCode(
    email: string,
    code: string,
    ip: string,
  ): Promise<WorkOsSession> {
    const normalized = normalizeEmail(email);
    await this.#consume(`quota:auth:verify:ip:${ip}`, this.#opts.verifyMax);
    await this.#consume(
      `quota:auth:verify:email:${emailKey(normalized)}`,
      this.#opts.verifyMax,
    );
    return this.#workos.authenticateWithMagicAuth(normalized, code);
  }

  async #pad(startedAt: number): Promise<void> {
    const remaining = this.#opts.floorMs - (Date.now() - startedAt);
    if (remaining > 0) await delay(remaining);
  }
}
