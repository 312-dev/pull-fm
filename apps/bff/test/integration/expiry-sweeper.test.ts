/**
 * The idempotency-key and connect-state expiry sweeper.
 *
 * The schema says these rows expire. Until this job existed nothing enforced
 * it: both expiries were applied ON READ ONLY, so an expired row was invisible
 * to the application and still present in the table for the life of the
 * account. For `idempotency_keys` that meant a verbatim copy of an API response
 * - email address, display name, wishlist note - stored indefinitely under a
 * published retention of 24 hours.
 *
 * So the suite proves two opposite things with equal weight. That the rows
 * actually go, because a retention promise nothing enforces is a false
 * statement of fact rather than a missing feature. And that the job cannot be
 * talked into deleting a row a request might still be using, because doing so
 * would turn a retried mutation into a second execution, which is precisely
 * what the Idempotency-Key header exists to prevent.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
  type Database,
} from "../../src/lib/db.js";
import {
  ExpirySweeper,
  EXPIRY_SWEEPER_DEFAULTS,
  EXPIRY_SWEEP_LOCK_KEY,
  type ExpirySweeperOptions,
} from "../../src/services/expiry-sweeper.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

const sweeper = (over: Partial<ExpirySweeperOptions> = {}): ExpirySweeper =>
  new ExpirySweeper(ctx.services.db, { ...EXPIRY_SWEEPER_DEFAULTS, ...over });

async function makeUser(): Promise<string> {
  const user = await ctx.services.users.upsert({
    workosUserId: `user_exp_${randomUUID().slice(0, 12)}`,
    email: `exp.${randomUUID().slice(0, 12)}@example.test`,
    displayName: null,
  });
  return user.id;
}

/**
 * Seeds one idempotency record whose expiry is `expiredForSeconds` in the past
 * (negative for a record that is still live).
 *
 * The body is deliberately the shape the policy document is worried about: an
 * email address and a free-text note copied verbatim out of an API response.
 */
async function idempotencyKey(
  userId: string,
  expiredForSeconds: number,
): Promise<string> {
  const key = `k-${randomUUID()}`;
  await ctx.services.db.query(
    `INSERT INTO idempotency_keys
       (user_id, key, request_hash, response_status, response_body, created_at, expires_at)
     VALUES ($1, $2, 'hash', 200,
             jsonb_build_object('email', 'leak@example.test', 'note', 'a private note'),
             now() - interval '48 hours',
             now() - make_interval(secs => $3::int))`,
    [userId, key, expiredForSeconds],
  );
  return key;
}

async function keyExists(userId: string, key: string): Promise<boolean> {
  const { rows } = await ctx.services.db.query(
    `SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
  return rows.length > 0;
}

/** Seeds one connect state. `provider` matters: one live state per user pair. */
async function connectState(
  userId: string,
  expiredForSeconds: number,
  provider: "lastfm" | "listenbrainz" = "lastfm",
): Promise<string> {
  const hash = randomBytes(32).toString("hex");
  await ctx.services.db.query(
    `INSERT INTO connect_states (state_hash, user_id, provider, redirect_uri, created_at, expires_at)
     VALUES ($1, $2, $3, 'https://app.example.test/cb',
             now() - interval '24 hours',
             now() - make_interval(secs => $4::int))`,
    [hash, userId, provider, expiredForSeconds],
  );
  return hash;
}

async function stateExists(hash: string): Promise<boolean> {
  const { rows } = await ctx.services.db.query(
    `SELECT 1 FROM connect_states WHERE state_hash = $1`,
    [hash],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
describe("what the sweeper refuses to delete", () => {
  test("an idempotency record inside its expiry survives", async () => {
    // The row a retry is about to read. Deleting it turns the retry into a
    // second execution of a mutation, which is the exact failure the header
    // exists to prevent.
    const userId = await makeUser();
    const key = await idempotencyKey(userId, -3600);

    await sweeper().run();

    expect(await keyExists(userId, key)).toBe(true);
  });

  test("an idempotency record expired but inside the slack hour survives", async () => {
    // The BFF and the database do not share a clock. The slack is not a
    // retention extension, it is the guarantee that this job can never delete a
    // row an in-flight request still considers valid.
    const userId = await makeUser();
    const key = await idempotencyKey(userId, 60);

    const outcome = await sweeper().run();

    expect(outcome.ran).toBe(true);
    expect(await keyExists(userId, key)).toBe(true);
  });

  test("a connect state inside its expiry survives", async () => {
    const userId = await makeUser();
    const hash = await connectState(userId, -60);

    await sweeper().run();

    expect(await stateExists(hash)).toBe(true);
  });

  test("a connect state inside the slack hour survives", async () => {
    const userId = await makeUser();
    const hash = await connectState(userId, 60);

    await sweeper().run();

    expect(await stateExists(hash)).toBe(true);
  });

  test("one user's expiry does not take another user's live rows with it", async () => {
    const stale = await makeUser();
    const live = await makeUser();
    const doomed = await idempotencyKey(stale, 7200);
    const kept = await idempotencyKey(live, -7200);
    const doomedState = await connectState(stale, 7200);
    const keptState = await connectState(live, -7200);

    await sweeper().run();

    expect(await keyExists(stale, doomed)).toBe(false);
    expect(await keyExists(live, kept)).toBe(true);
    expect(await stateExists(doomedState)).toBe(false);
    expect(await stateExists(keptState)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("what the sweeper does delete", () => {
  test("an idempotency record past its expiry and the slack is gone", async () => {
    const userId = await makeUser();
    const key = await idempotencyKey(userId, 7200);

    const outcome = await sweeper().run();

    expect(outcome.idempotencyKeysDeleted).toBeGreaterThan(0);
    expect(await keyExists(userId, key)).toBe(false);
  });

  test("the copied response body goes with the row, not just the key", async () => {
    // The point of the job. `response_body` is a verbatim copy of an API
    // response, so for account operations it holds an email address and a
    // display name and for wishlist writes the user's own free text. A sweep
    // that expired the key but left the body would enforce nothing.
    const userId = await makeUser();
    await idempotencyKey(userId, 7200);

    await sweeper().run();

    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM idempotency_keys
        WHERE user_id = $1 AND response_body IS NOT NULL`,
      [userId],
    );
    expect(rows[0]?.n).toBe("0");
  });

  test("an expired connect state is gone", async () => {
    const userId = await makeUser();
    const hash = await connectState(userId, 7200);

    const outcome = await sweeper().run();

    expect(outcome.connectStatesDeleted).toBeGreaterThan(0);
    expect(await stateExists(hash)).toBe(false);
  });

  test("the second run deletes nothing", async () => {
    const userId = await makeUser();
    await idempotencyKey(userId, 7200);
    await connectState(userId, 7200);

    await sweeper().run();
    const second = await sweeper().run();

    expect(second.idempotencyKeysDeleted).toBe(0);
    expect(second.connectStatesDeleted).toBe(0);
    expect(second.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("bounds", () => {
  test("a run is capped, and the cap is reported rather than hidden", async () => {
    // A backlog drains over several runs instead of taking one long lock on the
    // table. A cap that was not reported would look identical to a drained
    // backlog, and the difference is whether personal data is still there.
    const userId = await makeUser();
    await idempotencyKey(userId, 7200);
    await idempotencyKey(userId, 7200);
    await idempotencyKey(userId, 7200);

    const outcome = await sweeper({
      rowsPerBatch: 1,
      maxBatchesPerTable: 1,
    }).run();

    expect(outcome.idempotencyKeysDeleted).toBe(1);
    expect(outcome.capped).toBe(true);

    // And the rest go on subsequent runs rather than being stranded.
    await sweeper().run();
    const { rows } = await ctx.services.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM idempotency_keys WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0]?.n).toBe("0");
  });
});

// ---------------------------------------------------------------------------
describe("concurrency", () => {
  test("declines to start when another sweep holds the lock, and deletes nothing", async () => {
    // Taken on a PINNED connection, exactly as the job takes it. Through the
    // pool the lock would land on a connection that is immediately returned,
    // and the job could be handed the same one and re-acquire it, because
    // advisory locks are re-entrant within a session. An exclusion test that
    // does that passes while proving nothing.
    const userId = await makeUser();
    const key = await idempotencyKey(userId, 7200);

    await ctx.services.db.withConnection(async (holder) => {
      const acquired = await tryAdvisoryLock(
        holder,
        LOCK_NAMESPACE.expirySweep,
        EXPIRY_SWEEP_LOCK_KEY,
      );
      expect(acquired).toBe(true);

      try {
        const outcome = await sweeper().run();

        expect(outcome.ran).toBe(false);
        expect(outcome.idempotencyKeysDeleted).toBe(0);
        expect(await keyExists(userId, key)).toBe(true);
      } finally {
        await advisoryUnlock(
          holder,
          LOCK_NAMESPACE.expirySweep,
          EXPIRY_SWEEP_LOCK_KEY,
        );
      }
    });
  });

  test("releases the lock, so the next run can proceed", async () => {
    expect((await sweeper().run()).ran).toBe(true);
    expect((await sweeper().run()).ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("failure", () => {
  /** Wraps the pool so the statement naming `fragment` misbehaves. */
  function brokenOn(
    fragment: string,
    mode: "throw" | "unknown-rowcount",
  ): Database {
    const real = ctx.services.db;
    return {
      query: real.query.bind(real),
      withConnection: (fn: (client: any) => Promise<unknown>) =>
        real.withConnection((client) => {
          const patched = {
            query: (text: string, values?: unknown[]) => {
              if (typeof text === "string" && text.includes(fragment)) {
                if (mode === "throw") {
                  return Promise.reject(
                    new Error("injected statement failure"),
                  );
                }
                return Promise.resolve({ rows: [], rowCount: null });
              }
              return client.query(text, values as any);
            },
          };
          return fn(patched);
        }),
    } as unknown as Database;
  }

  test("a failing connect-state sweep does not stop the idempotency sweep", async () => {
    // The two tables are unrelated, and letting a stuck `connect_states` hold
    // up the table that actually holds email addresses would be the wrong
    // trade. The failed table is simply retried on the next run.
    const userId = await makeUser();
    const key = await idempotencyKey(userId, 7200);
    const hash = await connectState(userId, 7200);

    const outcome = await new ExpirySweeper(
      brokenOn("connect_states", "throw"),
      EXPIRY_SWEEPER_DEFAULTS,
    ).run();

    expect(outcome.ran).toBe(true);
    expect(outcome.failed).toBe(1);
    expect(outcome.idempotencyKeysDeleted).toBeGreaterThan(0);
    expect(await keyExists(userId, key)).toBe(false);
    // The state is untouched, not half-deleted, and the retry finishes it.
    expect(await stateExists(hash)).toBe(true);

    const retry = await sweeper().run();
    expect(retry.failed).toBe(0);
    expect(await stateExists(hash)).toBe(false);
  });

  test("an unknown affected-row count is a failure, never a drained backlog", async () => {
    // `pg` reports rowCount null when it cannot determine the count. Folding
    // that into zero would end the loop and report a clean run over rows that
    // are all still there, which for a deletion job is the worst available
    // failure mode.
    const userId = await makeUser();
    const key = await idempotencyKey(userId, 7200);

    const outcome = await new ExpirySweeper(
      brokenOn("idempotency_keys", "unknown-rowcount"),
      EXPIRY_SWEEPER_DEFAULTS,
    ).run();

    expect(outcome.failed).toBeGreaterThan(0);
    expect(outcome.idempotencyKeysDeleted).toBe(0);
    expect(await keyExists(userId, key)).toBe(true);
  });

  test("a failing sweep still releases the lock", async () => {
    await new ExpirySweeper(
      brokenOn("idempotency_keys", "throw"),
      EXPIRY_SWEEPER_DEFAULTS,
    ).run();

    expect((await sweeper().run()).ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("reachability", () => {
  test("the sweeper is not reachable from any route", () => {
    const paths = ctx.routes.map((r) => r.url.toLowerCase());
    for (const forbidden of ["sweep", "expire", "prune"]) {
      expect(
        paths.filter((p) => p.includes(forbidden)),
        `a route mentioning "${forbidden}" appeared`,
      ).toEqual([]);
    }
  });
});
