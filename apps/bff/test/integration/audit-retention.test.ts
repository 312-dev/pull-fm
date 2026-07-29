/**
 * The audit-log retention purge.
 *
 * This job rewrites and deletes the only evidence an incident investigation
 * would have, so the suite is weighted towards what it must REFUSE to touch. A
 * purge that clears a table is easy; a purge that cannot be talked into
 * destroying an in-window row, a live user's recent history, or a row it has
 * never swept is the thing worth proving.
 *
 * Four properties get the most attention, because each one is a bug that has
 * either already been written down as a good idea or would pass a naive test:
 *
 *   1. PER-ROW WINDOWS. docs/compliance/data-retention-policy.md section 5.4
 *      selects victim USERS by age and then updates every row those users have.
 *      Applied to the 90-day pass that anonymizes a live user's sign-in from
 *      yesterday the moment any one of their rows turns 90 days old. The
 *      windows must bind per row, and two tests here exist to prove they do.
 *   2. ONE PSEUDONYM PER USER, and it must differ between users. That is the
 *      only forensic property anonymization preserves; getting it wrong in
 *      either direction destroys or invents a correlation.
 *   3. THE HARD DELETE REFUSES UNKNOWN STATE. A 400-day row that was never
 *      anonymized is a bug symptom, and deleting it erases both the evidence
 *      and the only signal that the anonymizer stopped.
 *   4. THE EXCLUSION IS REAL. The advisory-lock test takes the lock the way the
 *      job takes it, on a pinned connection. Taking it through the pool proves
 *      nothing: the lock lands on a connection that is immediately returned,
 *      and the job can be handed the same one and re-acquire it, because
 *      advisory locks are re-entrant within a session.
 */

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
  type Database,
} from "../../src/lib/db.js";
import {
  AuditRetention,
  AUDIT_RETENTION_DEFAULTS,
  AUDIT_RETENTION_LOCK_KEY,
  type AuditRetentionOptions,
} from "../../src/services/audit-retention.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

/**
 * Every row this suite creates is BACKDATED; every row any other suite creates
 * is fresh. Deleting everything older than a day therefore cleans up after this
 * file exactly, without reaching into a sibling suite running in a parallel
 * worker against the same scratch database.
 */
afterEach(async () => {
  await ctx.services.db.query(
    `DELETE FROM audit_log WHERE created_at < now() - interval '1 day'`,
  );
  await ctx.services.db.query(
    `DELETE FROM deletion_log WHERE notes = 'retention-suite'`,
  );
});

/**
 * A retention job with tuned windows.
 *
 * Every run under the real policy windows goes through
 * `ctx.services.auditRetention`, which is the object `pnpm purge:audit`
 * actually runs, so a wiring mistake fails here rather than the first time a
 * retention window is enforced in production. This helper exists only for the
 * cases the bundle cannot express: a per-test window that would otherwise cost
 * a whole second application, and a substituted database that fails on demand.
 */
const job = (over: Partial<AuditRetentionOptions> = {}): AuditRetention =>
  new AuditRetention(ctx.services.db, { ...AUDIT_RETENTION_DEFAULTS, ...over });

async function makeUser(): Promise<string> {
  const user = await ctx.services.users.upsert({
    workosUserId: `user_ret_${randomUUID().slice(0, 12)}`,
    email: `ret.${randomUUID().slice(0, 12)}@example.test`,
    displayName: null,
  });
  return user.id;
}

/** Records the account as deleted, exactly as DeletionService would. */
async function markDeleted(userId: string): Promise<void> {
  await ctx.services.db.query(
    `INSERT INTO deletion_log (deleted_user_id, requested_at, completed_at, notes)
     VALUES ($1, now(), now(), 'retention-suite')`,
    [userId],
  );
}

interface Row {
  readonly id: string;
  readonly user_id: string | null;
  readonly subject_pseudonym: string | null;
  readonly anonymized_at: Date | null;
  readonly ip: string | null;
}

/** Inserts one audit row, backdated by `ageDays`. */
async function audit(opts: {
  userId: string | null;
  ageDays: number;
  ip?: string | null;
}): Promise<string> {
  const { rows } = await ctx.services.db.query<{ id: string }>(
    `INSERT INTO audit_log (user_id, action, subject_ref, outcome, ip, created_at)
     VALUES ($1, 'auth.callback', 'fixture', 'ok', $2,
             now() - make_interval(days => $3::int))
     RETURNING id::text AS id`,
    [
      opts.userId,
      opts.ip === undefined ? "203.0.113.7" : opts.ip,
      opts.ageDays,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("failed to seed an audit row");
  return id;
}

async function read(id: string): Promise<Row> {
  const { rows } = await ctx.services.db.query<Row>(
    `SELECT id::text AS id, user_id::text AS user_id,
            subject_pseudonym::text AS subject_pseudonym,
            anonymized_at, host(ip) || '/' || masklen(ip) AS ip
       FROM audit_log WHERE id = $1::bigint`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`audit row ${id} is gone`);
  return row;
}

async function exists(id: string): Promise<boolean> {
  const { rows } = await ctx.services.db.query(
    `SELECT 1 FROM audit_log WHERE id = $1::bigint`,
    [id],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
describe("what the purge refuses to anonymize", () => {
  test("a row inside the full-fidelity window keeps its identifiers", async () => {
    // The whole retention argument rests on 90 days of full fidelity being
    // real. A row at 89 days is evidence, not a liability.
    const userId = await makeUser();
    const fresh = await audit({ userId, ageDays: 89 });

    await ctx.services.auditRetention.run();

    const row = await read(fresh);
    expect(row.user_id).toBe(userId);
    expect(row.subject_pseudonym).toBeNull();
    expect(row.anonymized_at).toBeNull();
    expect(row.ip).toBe("203.0.113.7/32");
  });

  test("a LIVE user's recent rows survive when an old row of theirs ages out", async () => {
    // THE bug the spec's literal SQL would have shipped. Its UPDATE carries no
    // per-row age predicate, so one 91-day-old row would have anonymized the
    // same user's entire history including yesterday's sign-in, and the 90-day
    // window would have bounded nothing at all.
    const userId = await makeUser();
    const old = await audit({ userId, ageDays: 91 });
    const yesterday = await audit({ userId, ageDays: 1 });

    await ctx.services.auditRetention.run();

    expect((await read(old)).anonymized_at).not.toBeNull();

    const recent = await read(yesterday);
    expect(
      recent.user_id,
      "a live user's recent row was anonymized because an older row of theirs aged out",
    ).toBe(userId);
    expect(recent.anonymized_at).toBeNull();
  });

  test("a deleted account's recent rows survive the post-deletion window", async () => {
    // The same shape under the deletion rule. Thirty days exists because
    // account deletion is a plausible final step of a takeover: the sign-in
    // that stole the credential is exactly the row an attacker wants gone, and
    // it is exactly the row that is younger than the rest.
    const userId = await makeUser();
    await markDeleted(userId);
    const old = await audit({ userId, ageDays: 45 });
    const recent = await audit({ userId, ageDays: 3 });

    await ctx.services.auditRetention.run();

    expect((await read(old)).anonymized_at).not.toBeNull();
    expect(
      (await read(recent)).user_id,
      "the takeover window was collapsed by an older row belonging to the same account",
    ).toBe(userId);
  });

  test("a deleted account inside the 30-day window is untouched entirely", async () => {
    const userId = await makeUser();
    await markDeleted(userId);
    const row = await audit({ userId, ageDays: 10 });

    await ctx.services.auditRetention.run();

    const after = await read(row);
    expect(after.user_id).toBe(userId);
    expect(after.ip).toBe("203.0.113.7/32");
  });
});

// ---------------------------------------------------------------------------
describe("anonymization", () => {
  test("a deleted account's aged row loses its identifiers and keeps its network", async () => {
    // docs/compliance/data-retention-policy.md section 8.2, verbatim.
    const userId = await makeUser();
    await markDeleted(userId);
    const id = await audit({ userId, ageDays: 31 });

    const outcome = await ctx.services.auditRetention.run();
    expect(outcome.ran).toBe(true);
    expect(outcome.anonymizedDeleted).toBeGreaterThan(0);

    const row = await read(id);
    expect(row.user_id).toBeNull();
    expect(row.subject_pseudonym).not.toBeNull();
    expect(row.anonymized_at).not.toBeNull();
    expect(row.ip).toBe("203.0.113.0/24");
  });

  test("one pseudonym per user, and a different one per user", async () => {
    // The only forensic property anonymization preserves is "these events were
    // the same actor". A per-row pseudonym destroys it; a shared one invents a
    // correlation between strangers.
    const alice = await makeUser();
    const bob = await makeUser();
    const a1 = await audit({ userId: alice, ageDays: 95 });
    const a2 = await audit({ userId: alice, ageDays: 120 });
    const b1 = await audit({ userId: bob, ageDays: 95 });

    await ctx.services.auditRetention.run();

    const [ra1, ra2, rb1] = [await read(a1), await read(a2), await read(b1)];
    expect(ra1.subject_pseudonym).not.toBeNull();
    expect(ra1.subject_pseudonym).toBe(ra2.subject_pseudonym);
    expect(rb1.subject_pseudonym).not.toBe(ra1.subject_pseudonym);
  });

  test("an IPv6 address is truncated to its /48", async () => {
    const userId = await makeUser();
    const id = await audit({
      userId,
      ageDays: 95,
      ip: "2001:db8:abcd:1234::1",
    });

    await ctx.services.auditRetention.run();

    expect((await read(id)).ip).toBe("2001:db8:abcd::/48");
  });

  test("a row with no IP is anonymized without inventing one", async () => {
    const userId = await makeUser();
    const id = await audit({ userId, ageDays: 95, ip: null });

    await ctx.services.auditRetention.run();

    const row = await read(id);
    expect(row.ip).toBeNull();
    expect(row.anonymized_at).not.toBeNull();
  });

  test("an event with no subject is anonymized and gets NO pseudonym", async () => {
    // `directory.unverified_reaped`, `webhook.rejected` and the failed
    // magic-link attempts are written with user_id NULL, so neither user-keyed
    // statement can ever match them: `a.user_id = assigned.user_id` is never
    // true for NULL. Without a dedicated pass they would keep their IP forever
    // and the standing invariant would be permanently violated. Minting a
    // pseudonym for them would fabricate a subject rather than protect one.
    const id = await audit({ userId: null, ageDays: 95 });

    const outcome = await ctx.services.auditRetention.run();

    const row = await read(id);
    expect(outcome.anonymizedOrphan).toBeGreaterThan(0);
    expect(row.anonymized_at).not.toBeNull();
    expect(row.subject_pseudonym).toBeNull();
    expect(row.ip).toBe("203.0.113.0/24");
  });

  test("the second run changes nothing and does not re-pseudonymize", async () => {
    // Section 8.3. Re-running must be free, because the schedule will re-run it
    // and a re-pseudonymized row would silently break correlation between rows
    // that were anonymized on different days.
    const userId = await makeUser();
    await markDeleted(userId);
    const id = await audit({ userId, ageDays: 40 });

    await ctx.services.auditRetention.run();
    const first = await read(id);

    const second = await ctx.services.auditRetention.run();

    expect(second.anonymizedDeleted).toBe(0);
    expect(second.anonymizedAged).toBe(0);
    expect(second.anonymizedOrphan).toBe(0);

    const after = await read(id);
    expect(after.subject_pseudonym).toBe(first.subject_pseudonym);
    expect(after.anonymized_at?.getTime()).toBe(first.anonymized_at?.getTime());
  });
});

// ---------------------------------------------------------------------------
describe("the hard delete", () => {
  test("removes an anonymized row past the tail window", async () => {
    const userId = await makeUser();
    const id = await audit({ userId, ageDays: 401 });

    const outcome = await ctx.services.auditRetention.run();

    expect(outcome.hardDeleted).toBeGreaterThan(0);
    expect(await exists(id)).toBe(false);
  });

  test("REFUSES a row past the tail window that was never anonymized", async () => {
    // The guard the spec does not have. A 400-day row the sweep never reached
    // means the anonymizer is broken; deleting it would destroy the evidence
    // AND erase the standing invariant's only symptom. Reproduced by disabling
    // the anonymization windows, which is what a broken anonymizer looks like
    // from the delete statement's point of view.
    const userId = await makeUser();
    const id = await audit({ userId, ageDays: 401 });

    const outcome = await job({
      fullFidelityDays: 100_000,
      postDeletionDays: 100_000,
    }).run();

    expect(outcome.hardDeleted).toBe(0);
    expect(await exists(id)).toBe(true);
    // And the row is still visible to the standing invariant under the real
    // policy window, so a broken anonymizer surfaces as a violation rather than
    // as a table that quietly got smaller.
    expect(
      (await ctx.services.auditRetention.invariant()).pending,
    ).toBeGreaterThan(0);
  });

  test("a row inside the tail window is kept even though it is anonymized", async () => {
    const userId = await makeUser();
    const id = await audit({ userId, ageDays: 399 });

    await ctx.services.auditRetention.run();

    expect(await exists(id)).toBe(true);
    expect((await read(id)).anonymized_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("personal API token IPs", () => {
  test("an idle token's last-used IP is cleared and the token itself is not", async () => {
    const userId = await makeUser();
    const { rows } = await ctx.services.db.query<{ id: string }>(
      `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, last_four,
                               expires_at, last_used_at, last_used_ip)
       VALUES ($1, $2, encode(sha256($3::bytea), 'hex'), 'pfm_test', 'abcd',
               now() + interval '30 days', now() - interval '120 days', '198.51.100.9')
       RETURNING id::text AS id`,
      [userId, `ret-${randomUUID().slice(0, 8)}`, randomUUID()],
    );
    const tokenId = rows[0]?.id;
    expect(tokenId).toBeDefined();

    const outcome = await ctx.services.auditRetention.run();
    expect(outcome.tokenIpsCleared).toBeGreaterThan(0);

    const after = await ctx.services.db.query<{
      last_used_ip: string | null;
      revoked_at: Date | null;
    }>(
      `SELECT host(last_used_ip) AS last_used_ip, revoked_at FROM api_tokens WHERE id = $1`,
      [tokenId],
    );
    expect(after.rows[0]?.last_used_ip).toBeNull();
    // The credential is untouched. This job expires an identifier, never a
    // token: revoking somebody's working script because it went quiet for a
    // quarter would be a retention job causing an outage.
    expect(after.rows[0]?.revoked_at).toBeNull();

    await ctx.services.db.query(`DELETE FROM api_tokens WHERE id = $1`, [
      tokenId,
    ]);
  });

  test("a recently used token keeps its last-used IP", async () => {
    const userId = await makeUser();
    const { rows } = await ctx.services.db.query<{ id: string }>(
      `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, last_four,
                               expires_at, last_used_at, last_used_ip)
       VALUES ($1, $2, encode(sha256($3::bytea), 'hex'), 'pfm_test', 'abcd',
               now() + interval '30 days', now() - interval '2 days', '198.51.100.9')
       RETURNING id::text AS id`,
      [userId, `ret-${randomUUID().slice(0, 8)}`, randomUUID()],
    );
    const tokenId = rows[0]?.id;

    await ctx.services.auditRetention.run();

    const after = await ctx.services.db.query<{ last_used_ip: string | null }>(
      `SELECT host(last_used_ip) AS last_used_ip FROM api_tokens WHERE id = $1`,
      [tokenId],
    );
    expect(after.rows[0]?.last_used_ip).toBe("198.51.100.9");

    await ctx.services.db.query(`DELETE FROM api_tokens WHERE id = $1`, [
      tokenId,
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("the standing invariant and the freshness signal", () => {
  test("a full run drives the invariant to zero, including subjectless rows", async () => {
    // Section 8.5. The invariant is the whole compliance claim: if it is not
    // zero, personal data is past its stated retention regardless of what any
    // document says.
    const userId = await makeUser();
    await audit({ userId, ageDays: 200 });
    await audit({ userId: null, ageDays: 200 });

    const outcome = await ctx.services.auditRetention.run();

    expect(outcome.pendingBeyondWindow).toBe(0);
  });

  test("a dead scheduler is reported as stale rather than as a failure", async () => {
    // Section 8.4. A scheduler that stopped running produces no errors at all,
    // so the only symptom is rows piling up past the window while nothing has
    // been anonymized for days. Reproduced by seeding exactly that state.
    const userId = await makeUser();
    await audit({ userId, ageDays: 200 });

    const outcome = await ctx.services.auditRetention.run();

    expect(outcome.stale).toBe(true);
    expect(outcome.failed).toBe(0);
    // And having run, the backlog is gone.
    expect(outcome.pendingBeyondWindow).toBe(0);
  });

  test("a healthy run is not reported as stale", async () => {
    const userId = await makeUser();
    await audit({ userId, ageDays: 95 });
    await ctx.services.auditRetention.run();

    const outcome = await ctx.services.auditRetention.run();

    expect(outcome.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("concurrency", () => {
  test("declines to start when another run holds the lock, and changes nothing", async () => {
    // The lock is taken here on a PINNED connection, exactly as the job takes
    // it. Taking it through the pool would prove nothing: a session-scoped
    // advisory lock acquired that way lands on a connection that is
    // immediately returned, and the job can be handed the same connection and
    // re-acquire it, because advisory locks are re-entrant within a session.
    const userId = await makeUser();
    await markDeleted(userId);
    const id = await audit({ userId, ageDays: 200 });

    await ctx.services.db.withConnection(async (holder) => {
      const acquired = await tryAdvisoryLock(
        holder,
        LOCK_NAMESPACE.auditRetention,
        AUDIT_RETENTION_LOCK_KEY,
      );
      expect(acquired).toBe(true);

      try {
        const outcome = await ctx.services.auditRetention.run();

        expect(outcome.ran).toBe(false);
        expect(outcome.anonymizedDeleted).toBe(0);
        expect(outcome.hardDeleted).toBe(0);
        // And the row it would have rewritten is untouched.
        expect((await read(id)).user_id).toBe(userId);
      } finally {
        await advisoryUnlock(
          holder,
          LOCK_NAMESPACE.auditRetention,
          AUDIT_RETENTION_LOCK_KEY,
        );
      }
    });
  });

  test("releases the lock, so the next run can proceed", async () => {
    // A pooled connection still holding the lock after the job returns would
    // wedge every subsequent run, and the symptom would be "retention silently
    // stopped" rather than an error.
    expect((await ctx.services.auditRetention.run()).ran).toBe(true);
    expect((await ctx.services.auditRetention.run()).ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("failure", () => {
  /**
   * Wraps the pool so one statement misbehaves.
   *
   * `mode` is the interesting part. A thrown error is the obvious failure; a
   * `rowCount` of null is the one that matters, because `pg` reports it for a
   * statement whose affected-row count it could not determine, and folding it
   * into zero would make a purge that has no idea what it did report a clean
   * run and stop.
   */
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

  test("one failing statement is reported and does not abort the rest", async () => {
    // The remaining statements operate on disjoint predicates, so refusing to
    // run them would let one stuck window hold up every other. The failing
    // window is simply retried on the next run.
    const deletedUser = await makeUser();
    await markDeleted(deletedUser);
    const underDeletion = await audit({ userId: deletedUser, ageDays: 60 });

    const liveUser = await makeUser();
    const underAge = await audit({ userId: liveUser, ageDays: 95 });

    const outcome = await new AuditRetention(
      brokenOn("JOIN deletion_log", "throw"),
      AUDIT_RETENTION_DEFAULTS,
    ).run();

    expect(outcome.ran).toBe(true);
    expect(outcome.failed).toBeGreaterThan(0);

    // The deletion-rule row was left exactly as it was: not half-written.
    const stuck = await read(underDeletion);
    expect(stuck.user_id).toBe(deletedUser);
    expect(stuck.subject_pseudonym).toBeNull();
    expect(stuck.anonymized_at).toBeNull();

    // The age-rule row went through anyway.
    expect((await read(underAge)).anonymized_at).not.toBeNull();

    // And a healthy run afterwards finishes the job.
    const retry = await ctx.services.auditRetention.run();
    expect(retry.failed).toBe(0);
    expect((await read(underDeletion)).anonymized_at).not.toBeNull();
  });

  test("an unknown affected-row count is a failure, never a drained backlog", async () => {
    const userId = await makeUser();
    const id = await audit({ userId, ageDays: 200 });

    const outcome = await new AuditRetention(
      brokenOn("JOIN deletion_log", "unknown-rowcount"),
      AUDIT_RETENTION_DEFAULTS,
    ).run();

    expect(outcome.failed).toBeGreaterThan(0);
    // Nothing was counted as done under the statement that would not say.
    expect(outcome.anonymizedDeleted).toBe(0);
    // The row still gets handled by the age rule, which was not broken.
    expect((await read(id)).anonymized_at).not.toBeNull();
  });

  test("a failing statement still releases the lock", async () => {
    await new AuditRetention(
      brokenOn("JOIN deletion_log", "throw"),
      AUDIT_RETENTION_DEFAULTS,
    ).run();

    expect((await ctx.services.auditRetention.run()).ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the structural guarantee", () => {
  test("the database refuses a row that carries BOTH a user id and a pseudonym", async () => {
    // This is why partial failure cannot leave an inconsistent state: the one
    // shape that would hand a reader the mapping between a user and their
    // pseudonym is unrepresentable, so no interrupted batch, no bug in the job,
    // and no hand-run SQL can produce it.
    const userId = await makeUser();
    const id = await audit({ userId, ageDays: 95 });

    await expect(
      ctx.services.db.query(
        `UPDATE audit_log
            SET subject_pseudonym = gen_random_uuid(), anonymized_at = now()
          WHERE id = $1::bigint`,
        [id],
      ),
    ).rejects.toThrow(/audit_log_identity_chk/);
  });

  test("the purge is not reachable from any route", () => {
    // It rewrites and deletes the audit trail. It exists for a scheduled
    // command, not for a handler, and a route that could trigger it would be a
    // self-service evidence-destruction endpoint.
    const paths = ctx.routes.map((r) => r.url.toLowerCase());
    for (const forbidden of ["purge", "retention", "anonymi"]) {
      expect(
        paths.filter((p) => p.includes(forbidden)),
        `a route mentioning "${forbidden}" appeared`,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Registration.
//
// `pnpm purge:audit` reads the job off the service bundle rather than building
// one beside the scheduler. That is what makes every assertion above a
// statement about the windows production actually enforces.
// ---------------------------------------------------------------------------
describe("registration", () => {
  test("the bundled job is stable, not rebuilt per read", () => {
    expect(ctx.services.auditRetention).toBeInstanceOf(AuditRetention);
    expect(ctx.services.auditRetention).toBe(ctx.services.auditRetention);
  });

  test("its windows come from the environment", async () => {
    // The retention windows are deliberately absent from `config.ts` (see
    // src/lib/job-env.ts), so this is the only place the path from an
    // operator's variable to the object the entrypoint runs is checked end to
    // end. Before the job was on the bundle there was nothing to check: the
    // entrypoint read the variable and built its own job, so a wiring mistake
    // was invisible until a window was already being enforced wrongly.
    const userId = await makeUser();
    const id = await audit({ userId, ageDays: 3 });

    // Three days old is far inside the shipped 90-day window, so the bundled
    // job under the real policy must leave it alone.
    await ctx.services.auditRetention.run();
    expect((await read(id)).anonymized_at).toBeNull();

    const tuned = await buildTestApp({
      jobEnv: { AUDIT_FULL_FIDELITY_DAYS: "1" },
    });
    try {
      await tuned.services.auditRetention.run();
      expect((await read(id)).anonymized_at).not.toBeNull();
    } finally {
      await tuned.close();
    }
  });
});
