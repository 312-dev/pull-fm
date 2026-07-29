/**
 * The unverified-directory reaper.
 *
 * This job deletes identities, so the tests are weighted towards what it must
 * REFUSE to delete. A reaper that removes junk is easy; a reaper that cannot be
 * talked into removing a real account is the thing worth proving.
 *
 * The behaviour it compensates for was verified against the live WorkOS API on
 * 2026-07-29: `magic_auth/send` auto-creates a user for an unknown address with
 * `email_verified: false` and answers 200. The stub in test/helpers/app.ts
 * reproduces that, so these tests exercise the real condition rather than an
 * invented one.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
} from "../../src/lib/db.js";
import {
  DirectoryReaper,
  REAP_LOCK_KEY,
} from "../../src/services/directory-reaper.js";
import type { WorkOsUser } from "../../src/services/workos.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A directory record with nothing else in the world referring to it. */
function seed(
  label: string,
  opts: { verified: boolean; ageMs: number },
): { email: string; id: string } {
  const email = `${label}.${randomUUID().slice(0, 12)}@example.test`;
  const id = `user_${label}_${randomUUID().slice(0, 12)}`;
  ctx.workos.register(email, id, {
    verified: opts.verified,
    createdAt: new Date(Date.now() - opts.ageMs),
  });
  return { email, id };
}

const inDirectory = (id: string): boolean =>
  ctx.workos.directory().some((entry) => entry.id === id);

// ---------------------------------------------------------------------------
// The predicate, in isolation.
//
// The whole safety property of the job is this one function, so it is asserted
// directly as well as through a sweep. A pure predicate can be exhaustively
// covered in a way a job that walks a paginated directory cannot.
// ---------------------------------------------------------------------------
describe("eligibility", () => {
  const cutoff = new Date("2026-07-28T00:00:00.000Z");

  const user = (over: Partial<WorkOsUser>): WorkOsUser => ({
    id: "user_x",
    email: "x@example.test",
    firstName: null,
    lastName: null,
    emailVerified: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  });

  test("an old unverified record is eligible", () => {
    expect(DirectoryReaper.eligible(user({}), cutoff)).toEqual({
      eligible: true,
      reason: "eligible",
    });
  });

  test("a verified record is never eligible, however old", () => {
    // The key the whole design rests on: verification state, not age.
    const ancient = user({
      emailVerified: true,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(DirectoryReaper.eligible(ancient, cutoff)).toEqual({
      eligible: false,
      reason: "verified",
    });
  });

  test("a recent unverified record is not eligible", () => {
    const fresh = user({ createdAt: "2026-07-28T00:00:01.000Z" });
    expect(DirectoryReaper.eligible(fresh, cutoff).eligible).toBe(false);
    expect(DirectoryReaper.eligible(fresh, cutoff).reason).toBe("recent");
  });

  test("the boundary is exclusive, so a record exactly at the cutoff survives", () => {
    const exact = user({ createdAt: cutoff.toISOString() });
    expect(DirectoryReaper.eligible(exact, cutoff).eligible).toBe(false);
  });

  test("an ABSENT verification flag is unknown, not false", () => {
    // The fail-closed rule that matters most. If WorkOS ever stops returning
    // `email_verified`, folding absent into false would make every record in
    // the directory eligible at once.
    const unknown = user({ emailVerified: null });
    expect(DirectoryReaper.eligible(unknown, cutoff)).toEqual({
      eligible: false,
      reason: "unknown",
    });
  });

  test("an absent or unparseable creation time is unknown, not old", () => {
    for (const createdAt of [null, "not-a-date", ""]) {
      const broken = user({ createdAt });
      expect(
        DirectoryReaper.eligible(broken, cutoff),
        String(createdAt),
      ).toEqual({ eligible: false, reason: "unknown" });
    }
  });
});

// ---------------------------------------------------------------------------
describe("a sweep", () => {
  test("deletes an unverified record past the window", async () => {
    const stale = seed("stale", { verified: false, ageMs: 3 * DAY_MS });
    expect(inDirectory(stale.id)).toBe(true);

    const outcome = await ctx.services.directoryReaper.run();

    expect(outcome.ran).toBe(true);
    expect(outcome.deleted).toBeGreaterThan(0);
    expect(inDirectory(stale.id)).toBe(false);
  });

  test("never deletes a verified record, however old", async () => {
    // The assertion the operator asked for by name. Age alone must not be
    // sufficient, because a long-dormant real account is exactly the record
    // that looks most like junk.
    const ancient = seed("ancient", { verified: true, ageMs: 400 * DAY_MS });

    await ctx.services.directoryReaper.run();

    expect(inDirectory(ancient.id)).toBe(true);
  });

  test("never deletes an unverified record inside the window", async () => {
    // Someone who requested a code ten minutes ago and is still reading their
    // mail. Deleting them mid-flow would break a sign-in in progress.
    const fresh = seed("fresh", { verified: false, ageMs: 60_000 });

    await ctx.services.directoryReaper.run();

    expect(inDirectory(fresh.id)).toBe(true);
  });

  test("never deletes a record we hold a local row for", async () => {
    // Rule 3, the belt to rule 1's braces. A local row means a real person
    // completed a sign-in at some point, so even an unverified-looking, ancient
    // upstream record is off limits. This is what stops a response-shape change
    // plus a clock problem from destroying an account.
    const owned = seed("owned", { verified: false, ageMs: 30 * DAY_MS });
    await ctx.services.users.upsert({
      workosUserId: owned.id,
      email: owned.email,
      displayName: null,
    });

    await ctx.services.directoryReaper.run();

    expect(inDirectory(owned.id)).toBe(true);
  });

  test("never deletes a record whose local row was soft-deleted", async () => {
    // Deliberately checked WITHOUT `deleted_at IS NULL`, unlike every other
    // query in this application. A soft-deleted row is still evidence that a
    // real person was here, and the account-deletion path already removes the
    // upstream identity itself.
    const erased = seed("erased", { verified: false, ageMs: 30 * DAY_MS });
    const user = await ctx.services.users.upsert({
      workosUserId: erased.id,
      email: erased.email,
      displayName: null,
    });
    await ctx.services.db.query(
      `UPDATE users SET deleted_at = now() WHERE id = $1`,
      [user.id],
    );

    await ctx.services.directoryReaper.run();

    expect(inDirectory(erased.id)).toBe(true);
  });

  test("a real sign-in makes a record permanently safe", async () => {
    // End to end rather than by fixture: request a code, verify it, backdate
    // the record well past the window, and confirm the sweep leaves it alone.
    // This is the property a user actually depends on.
    const email = `signedin.${randomUUID().slice(0, 10)}@example.test`;
    await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/start",
      headers: { "x-forwarded-for": "10.9.9.9" },
      payload: { email },
    });
    const code = ctx.workos.codeFor(email) ?? "";
    const verified = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      headers: { "x-forwarded-for": "10.9.9.9" },
      payload: { email, code },
    });
    expect(verified.statusCode).toBe(200);

    const record = ctx.workos
      .directory()
      .find((entry) => entry.email === email.toLowerCase());
    expect(record?.verified).toBe(true);

    await ctx.services.directoryReaper.run();

    expect(
      ctx.workos.directory().some((e) => e.email === email.toLowerCase()),
      "a record that completed a sign-in was reaped",
    ).toBe(true);
  });

  test("is idempotent", async () => {
    // Deleting an already-deleted user is a 404, which the client treats as
    // success, so a re-run converges instead of erroring.
    seed("idem", { verified: false, ageMs: 5 * DAY_MS });

    const first = await ctx.services.directoryReaper.run();
    const second = await ctx.services.directoryReaper.run();

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(true);
    expect(second.deleted).toBe(0);
    expect(second.failed).toBe(0);
  });

  test("declines to start when another sweep holds the lock", async () => {
    // Concurrency safety. A second invocation must decline rather than race, so
    // two schedulers, or a slow run overlapping the next tick, cannot walk the
    // same directory at once.
    //
    // The lock is taken on a PINNED connection here, exactly as the reaper
    // takes it. Taking it through the pool would prove nothing: a session-scoped
    // advisory lock acquired that way lands on a connection that is immediately
    // returned, and the reaper can then be handed the same connection and
    // re-acquire it, because advisory locks are re-entrant within a session.
    // An earlier version of this test did that and passed while the exclusion
    // it claimed to prove did not exist.
    const blocked = seed("blocked", { verified: false, ageMs: 5 * DAY_MS });

    await ctx.services.db.withConnection(async (holder) => {
      const acquired = await tryAdvisoryLock(
        holder,
        LOCK_NAMESPACE.directoryReap,
        REAP_LOCK_KEY,
      );
      expect(acquired).toBe(true);

      try {
        const outcome = await ctx.services.directoryReaper.run();

        expect(outcome.ran).toBe(false);
        expect(outcome.deleted).toBe(0);
        // And nothing was touched while it declined.
        expect(inDirectory(blocked.id)).toBe(true);
      } finally {
        await advisoryUnlock(
          holder,
          LOCK_NAMESPACE.directoryReap,
          REAP_LOCK_KEY,
        );
      }
    });
  });

  test("releases the lock, so the next run can proceed", async () => {
    // A pooled connection holding an advisory lock after the job ends would
    // wedge every subsequent sweep, and the symptom would be "the reaper
    // silently stopped working" rather than an error.
    expect((await ctx.services.directoryReaper.run()).ran).toBe(true);
    expect((await ctx.services.directoryReaper.run()).ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("failure", () => {
  test("a listing failure deletes nothing and reports it", async () => {
    // A directory we cannot enumerate is one we must not act on. Reporting a
    // clean run here would be the worst outcome: the pollution bound would be
    // silently absent.
    const survivor = seed("listfail", { verified: false, ageMs: 5 * DAY_MS });
    ctx.workos.failNext("/user_management/users?", 503);

    await expect(ctx.services.directoryReaper.run()).rejects.toThrow();

    expect(inDirectory(survivor.id)).toBe(true);
  });

  test("a failed listing still releases the lock", async () => {
    // The `finally` in the sweep. Without it one upstream blip would wedge the
    // job until the process restarted.
    ctx.workos.failNext("/user_management/users?", 500);
    await expect(ctx.services.directoryReaper.run()).rejects.toThrow();

    expect((await ctx.services.directoryReaper.run()).ran).toBe(true);
  });

  test("one failed deletion does not abort the sweep, and leaves state consistent", async () => {
    // One stubborn identity must not protect every other record in the
    // directory. The failed record is still unverified and still past the
    // window, so the next run retries it, and no local state was written that
    // could disagree with the directory.
    const first = seed("delfail_a", { verified: false, ageMs: 6 * DAY_MS });
    const second = seed("delfail_b", { verified: false, ageMs: 6 * DAY_MS });

    // Aimed at the first deletion the sweep attempts, whichever record that is.
    ctx.workos.failNext("/user_management/users/", 500);

    const outcome = await ctx.services.directoryReaper.run();

    expect(outcome.ran).toBe(true);
    expect(outcome.failed).toBe(1);
    // The other record still went, so the sweep continued past the failure.
    expect(outcome.deleted).toBeGreaterThan(0);

    // Exactly one of the pair survived, and no local row was created or
    // destroyed for either. The reaper makes NO local writes, which is why a
    // partial run cannot leave local state inconsistent.
    const survivors = [first, second].filter((r) => inDirectory(r.id));
    expect(survivors).toHaveLength(1);

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM users
        WHERE workos_user_id = ANY($1::text[])`,
      [[first.id, second.id]],
    );
    expect(rows[0]?.n).toBe("0");

    // And the retry succeeds, so the failure was transient rather than sticky.
    const retry = await ctx.services.directoryReaper.run();
    expect(retry.failed).toBe(0);
    expect(survivors[0] && inDirectory(survivors[0].id)).toBe(false);
  });

  test("a failed deletion is recorded in the audit trail as an error", async () => {
    seed("auditfail", { verified: false, ageMs: 7 * DAY_MS });
    ctx.workos.failNext("/user_management/users/", 500);
    await ctx.services.directoryReaper.run();

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'directory.unverified_reaped' AND outcome = 'error'`,
    );
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("blast radius", () => {
  test("a run is capped, and the cap is reported rather than hidden", async () => {
    // If a bug or a response-shape change ever made everything look eligible,
    // the damage is bounded and the next run is a decision a human gets to
    // make. An uncapped destructive sweep is one bad deploy from a deleted
    // user base.
    const capped = await buildTestApp({
      env: { AUTH_UNVERIFIED_REAP_MAX_DELETIONS: "1" },
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        capped.workos.register(
          `cap${String(i)}.${randomUUID().slice(0, 8)}@example.test`,
          `user_cap_${String(i)}_${randomUUID().slice(0, 8)}`,
          { verified: false, createdAt: new Date(Date.now() - 5 * DAY_MS) },
        );
      }

      const outcome = await capped.services.directoryReaper.run();
      expect(outcome.deleted).toBe(1);
      expect(outcome.capped).toBe(2);
    } finally {
      await capped.close();
    }
  });

  test("the audit trail records the WorkOS id and never the address", async () => {
    // These rows outlive their subject, and the subject here is by definition
    // NOT a user of ours. Writing their address into our permanent audit trail
    // in order to note that we deleted their record would defeat the purpose.
    const reaped = seed("auditid", { verified: false, ageMs: 8 * DAY_MS });
    await ctx.services.directoryReaper.run();

    const { rows } = await ctx.services.db.query<{ subject_ref: string }>(
      `SELECT subject_ref FROM audit_log
        WHERE action = 'directory.unverified_reaped' AND outcome = 'ok'`,
    );
    const refs = rows.map((r) => r.subject_ref);
    expect(refs).toContain(reaped.id);
    for (const ref of refs) {
      expect(ref).not.toContain("@");
    }
  });

  test("the reaper is not reachable from any route", () => {
    // It enumerates the entire user directory and deletes identities. It is on
    // the service bundle so the scheduled script can share the wiring, not so a
    // handler can call it.
    const paths = ctx.routes.map((r) => r.url.toLowerCase());
    for (const forbidden of ["reap", "directory", "prune"]) {
      expect(
        paths.filter((p) => p.includes(forbidden)),
        `a route mentioning "${forbidden}" appeared`,
      ).toEqual([]);
    }
  });
});
