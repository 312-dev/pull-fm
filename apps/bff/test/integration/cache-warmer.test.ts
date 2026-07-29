/**
 * The background cache warmer.
 *
 * The warm methods it drives have existed since the MusicBrainz layer landed
 * and nothing called them, so the product has been running on whatever the feed
 * happened to resolve. This job is the intended caller.
 *
 * What the suite is actually about is the RATE, not the warming. MusicBrainz
 * permits one request per second across the entire service per IP, and iTunes
 * about twenty calls a minute with no appeals process for a block. Getting the
 * warming wrong costs a cold cache; getting the pacing or the yielding wrong
 * costs the project its API access, and takes user-facing traffic with it
 * because a blocked IP is blocked for everything. So the calls out are always
 * made against a substitute here, and the assertions that matter are the ones
 * about how few of them there are and how fast the job stops.
 *
 * Every test runs against a real database and a real candidate query, because
 * the candidate query is where "do not spend a global budget on rows nobody
 * asked for" is actually implemented.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  MUSICBRAINZ_MIN_INTERVAL_MS,
  UpstreamError,
  type ResolvedPreview,
  type TrackIdentity,
  type UpstreamErrorKind,
} from "@pull-fm/upstream";

import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
} from "../../src/lib/db.js";
import {
  CacheWarmer,
  CACHE_WARMER_DEFAULTS,
  CACHE_WARM_LOCK_KEY,
  type CacheWarmerOptions,
  type MusicBrainzWarmTarget,
  type PreviewWarmTarget,
} from "../../src/services/cache-warmer.js";

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
}, 60_000);

afterAll(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------
// Substitutes. No test in this file may reach a real provider: MusicBrainz
// blocks IPs and Apple has no appeals process, so a suite that called them
// could cost the project its access.
// ---------------------------------------------------------------------------

interface FakeMb extends MusicBrainzWarmTarget {
  readonly calls: string[];
}

/** `failures` maps a 1-based call number to the error kind it should raise. */
function fakeMusicBrainz(
  failures: ReadonlyMap<number, UpstreamErrorKind> = new Map(),
  found = true,
): FakeMb {
  const calls: string[] = [];
  const call = (mbid: string): Promise<unknown> => {
    calls.push(mbid);
    const kind = failures.get(calls.length);
    if (kind !== undefined) {
      return Promise.reject(
        new UpstreamError({
          provider: "musicbrainz",
          kind,
          message: "injected",
        }),
      );
    }
    return Promise.resolve(found ? { mbid } : null);
  };
  return {
    calls,
    warmRecording: call,
    warmArtist: call,
    warmRelease: call,
  };
}

interface FakePreviews extends PreviewWarmTarget {
  readonly calls: TrackIdentity[];
}

function fakePreviews(
  opts: { cacheable?: boolean; found?: boolean } = {},
): FakePreviews {
  const calls: TrackIdentity[] = [];
  return {
    calls,
    resolve(track: TrackIdentity): Promise<ResolvedPreview | null> {
      calls.push(track);
      if (opts.found === false) return Promise.resolve(null);
      return Promise.resolve({
        recordingMbid: track.recordingMbid,
        provider: "itunes",
        url: "https://audio.example.test/p.m4a",
        durationMs: 30_000,
        expiresAt: null,
        cacheable: opts.cacheable ?? true,
        attribution: { source: "itunes", text: "courtesy of iTunes" },
      });
    },
  };
}

/**
 * A virtual clock. `sleep` advances it, so pacing is exact and instant.
 *
 * Real timers would make a test that proves "one call every two seconds" take
 * as long as the thing it is proving, which is how a rate-limit test stops
 * being run.
 */
function virtualClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waits: number[];
} {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      waits.push(ms);
      t += ms;
      return Promise.resolve();
    },
    waits,
  };
}

function warmer(
  mb: MusicBrainzWarmTarget,
  previews: PreviewWarmTarget,
  over: Partial<CacheWarmerOptions> = {},
): CacheWarmer {
  return new CacheWarmer(ctx.services.db, mb, previews, {
    ...CACHE_WARMER_DEFAULTS,
    // Big enough that a sibling suite's rows cannot push this file's fixtures
    // out of the candidate list, since the scratch database is shared.
    musicbrainzMaxCalls: 5000,
    itunesMaxCalls: 5000,
    sleep: () => Promise.resolve(),
    ...over,
  });
}

// --- fixtures --------------------------------------------------------------

async function makeUser(): Promise<string> {
  const user = await ctx.services.users.upsert({
    workosUserId: `user_warm_${randomUUID().slice(0, 12)}`,
    email: `warm.${randomUUID().slice(0, 12)}@example.test`,
    displayName: null,
  });
  return user.id;
}

/** A wishlist row, which is priority tier 1 and carries its own names. */
async function wishlist(
  userId: string,
  opts: { status?: string; artistMbid?: string } = {},
): Promise<string> {
  const mbid = randomUUID();
  await ctx.services.db.query(
    `INSERT INTO wishlist_items
       (user_id, recording_mbid, artist_mbid, artist_name, title, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      mbid,
      opts.artistMbid ?? null,
      `Artist ${mbid.slice(0, 8)}`,
      `Title ${mbid.slice(0, 8)}`,
      opts.status ?? "wanted",
    ],
  );
  return mbid;
}

/** A crosswalk row, which is priority tier 4 and below. */
async function crosswalk(entity = "recording"): Promise<string> {
  const mbid = randomUUID();
  await ctx.services.db.query(
    `INSERT INTO mbid_crosswalk (entity_type, normalized_key, mbid, source)
     VALUES ($1, $2, $3, 'test')`,
    [entity, `key ${randomUUID()}`, mbid],
  );
  return mbid;
}

async function cacheRow(
  entity: string,
  mbid: string,
  ttlSeconds: number | null,
): Promise<void> {
  await ctx.services.db.query(
    `INSERT INTO upstream_cache (provider, cache_key, payload, expires_at)
     VALUES ('musicbrainz', $1, $2::jsonb,
             CASE WHEN $3::int IS NULL THEN NULL
                  ELSE now() + make_interval(secs => $3::int) END)
     ON CONFLICT (provider, cache_key) DO UPDATE
        SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
    [
      `${entity}:${mbid}`,
      JSON.stringify({
        mbid,
        title: `Cached ${mbid.slice(0, 8)}`,
        artistName: `Cached artist ${mbid.slice(0, 8)}`,
      }),
      ttlSeconds,
    ],
  );
}

async function previewRow(
  mbid: string,
  opts: { storeUrl: string | null; revalidateInDays: number },
): Promise<void> {
  await ctx.services.db.query(
    `INSERT INTO track_previews
       (recording_mbid, provider, preview_url, store_url, revalidate_after)
     VALUES ($1, 'itunes', 'https://audio.example.test/p.m4a', $2,
             now() + make_interval(days => $3::int))
     ON CONFLICT (recording_mbid, provider) DO UPDATE
        SET store_url = EXCLUDED.store_url,
            revalidate_after = EXCLUDED.revalidate_after`,
    [mbid, opts.storeUrl, opts.revalidateInDays],
  );
}

// ---------------------------------------------------------------------------
describe("what gets warmed", () => {
  test("a wishlist recording with no cached row is warmed", async () => {
    const mbid = await wishlist(await makeUser());
    const mb = fakeMusicBrainz();

    const outcome = await warmer(mb, fakePreviews()).run();

    expect(outcome.ran).toBe(true);
    expect(mb.calls).toContain(mbid);
  });

  test("an already-cached, unexpired MBID is NOT called again", async () => {
    // The budget is one request per second for the whole service. Re-fetching a
    // row we already hold is the single easiest way to spend it on nothing.
    const mbid = await wishlist(await makeUser());
    await cacheRow("recording", mbid, 86_400);
    const mb = fakeMusicBrainz();

    await warmer(mb, fakePreviews()).run();

    expect(mb.calls).not.toContain(mbid);
  });

  test("an EXPIRED cached row is warmed again", async () => {
    // MBIDs get merged and titles corrected upstream, so a row that never
    // expires is a correction we never pick up.
    const mbid = await wishlist(await makeUser());
    await cacheRow("recording", mbid, -3600);
    const mb = fakeMusicBrainz();

    await warmer(mb, fakePreviews()).run();

    expect(mb.calls).toContain(mbid);
  });

  test("a soft-deleted account's wishlist is not warmed", async () => {
    // Spending a shared, rate-limited, global budget on data nobody will ever
    // be shown. The erasure path has already made these rows invisible.
    const userId = await makeUser();
    const mbid = await wishlist(userId);
    await ctx.services.db.query(
      `UPDATE users SET deleted_at = now() WHERE id = $1`,
      [userId],
    );
    const mb = fakeMusicBrainz();

    await warmer(mb, fakePreviews()).run();

    expect(mb.calls).not.toContain(mbid);
  });

  test("a dismissed wishlist item is not warmed", async () => {
    const mbid = await wishlist(await makeUser(), { status: "dismissed" });
    const mb = fakeMusicBrainz();

    await warmer(mb, fakePreviews()).run();

    expect(mb.calls).not.toContain(mbid);
  });

  test("a crosswalk MBID is warmed, after the wishlist", async () => {
    // Priority order, asserted as an order rather than as a set. Explicit user
    // intent outranks traffic-derived working set, and both outrank nothing
    // else, because there is no third tier: no crawl, no backfill, no
    // speculative fan-out. At one request per second a crawl never finishes.
    const wishlistMbid = await wishlist(await makeUser());
    const crosswalkMbid = await crosswalk("recording");
    const mb = fakeMusicBrainz();

    await warmer(mb, fakePreviews()).run();

    expect(mb.calls).toContain(crosswalkMbid);
    expect(mb.calls.indexOf(wishlistMbid)).toBeLessThan(
      mb.calls.indexOf(crosswalkMbid),
    );
  });

  test("a wishlist artist MBID is warmed as an artist", async () => {
    const artistMbid = randomUUID();
    await wishlist(await makeUser(), { artistMbid });
    const seen: string[] = [];
    const mb: MusicBrainzWarmTarget = {
      warmRecording: () => Promise.resolve({}),
      warmArtist: (mbid) => {
        seen.push(mbid);
        return Promise.resolve({});
      },
      warmRelease: () => Promise.resolve({}),
    };

    await warmer(mb, fakePreviews()).run();

    expect(seen).toContain(artistMbid);
  });

  test("a second run does not re-warm what the first one warmed", async () => {
    // Idempotence comes from the candidate query, not from bookkeeping: a row
    // that now exists in `upstream_cache` is simply no longer a candidate.
    const mbid = await wishlist(await makeUser());
    const first = fakeMusicBrainz();
    await warmer(first, fakePreviews()).run();
    expect(first.calls).toContain(mbid);

    await cacheRow("recording", mbid, 86_400);

    const second = fakeMusicBrainz();
    await warmer(second, fakePreviews()).run();
    expect(second.calls).not.toContain(mbid);
  });
});

// ---------------------------------------------------------------------------
describe("previews", () => {
  test("a wishlist recording with no preview row is resolved, using its own names", async () => {
    // Tier 1 costs no MusicBrainz call: the wishlist row already carries the
    // artist and title, denormalized precisely because names cannot be
    // re-resolved on read at one request per second.
    const mbid = await wishlist(await makeUser());
    const previews = fakePreviews();

    const outcome = await warmer(fakeMusicBrainz(), previews).run();

    const call = previews.calls.find((c) => c.recordingMbid === mbid);
    expect(call).toBeDefined();
    expect(call?.artistName).toBe(`Artist ${mbid.slice(0, 8)}`);
    expect(outcome.itunes.warmed).toBeGreaterThan(0);
  });

  test("a preview row with no store URL is still a candidate", async () => {
    // Apple's licence condition (ii) is conjunctive: a preview without a
    // per-track store link cannot be rendered legally, so a row with a NULL
    // store_url is never served and must be re-resolved. `resolveCached`
    // already treats it as absent; the candidate query has to agree.
    const mbid = await wishlist(await makeUser());
    await previewRow(mbid, { storeUrl: null, revalidateInDays: 30 });
    const previews = fakePreviews();

    await warmer(fakeMusicBrainz(), previews).run();

    expect(previews.calls.map((c) => c.recordingMbid)).toContain(mbid);
  });

  test("a preview row past its revalidation is still a candidate", async () => {
    // Apple may remove promo content immediately on request, so a resolved URL
    // kept forever would serve a withdrawn track from our own table.
    const mbid = await wishlist(await makeUser());
    await previewRow(mbid, {
      storeUrl: "https://music.apple.com/us/album/x/1?i=2",
      revalidateInDays: -1,
    });
    const previews = fakePreviews();

    await warmer(fakeMusicBrainz(), previews).run();

    expect(previews.calls.map((c) => c.recordingMbid)).toContain(mbid);
  });

  test("a fresh, servable preview row is NOT a candidate", async () => {
    const mbid = await wishlist(await makeUser());
    await previewRow(mbid, {
      storeUrl: "https://music.apple.com/us/album/x/1?i=2",
      revalidateInDays: 30,
    });
    const previews = fakePreviews();

    await warmer(fakeMusicBrainz(), previews).run();

    expect(previews.calls.map((c) => c.recordingMbid)).not.toContain(mbid);
  });

  test("a result that cannot be persisted is not counted as warmed", async () => {
    // A signed, expiring URL is thrown away after use, so resolving one warms
    // nothing. Counting it would make the job report progress it did not make.
    await wishlist(await makeUser());
    const previews = fakePreviews({ cacheable: false });

    const outcome = await warmer(fakeMusicBrainz(), previews).run();

    expect(outcome.itunes.called).toBeGreaterThan(0);
    expect(outcome.itunes.warmed).toBe(0);
    expect(outcome.itunes.empty).toBeGreaterThan(0);
  });

  test("a recording the MusicBrainz cache can name is a candidate without a wishlist row", async () => {
    // Tier 2. This is why the MusicBrainz phase runs first: it writes the rows
    // this query reads the names out of.
    const mbid = randomUUID();
    await cacheRow("recording", mbid, 86_400);
    const previews = fakePreviews();

    await warmer(fakeMusicBrainz(), previews).run();

    const call = previews.calls.find((c) => c.recordingMbid === mbid);
    expect(call?.title).toBe(`Cached ${mbid.slice(0, 8)}`);
  });

  test("a cache key that is not shaped like recording:<uuid> is skipped, not fatal", async () => {
    // Fail closed. `substring(...)::uuid` on an unparseable key would abort the
    // whole statement, so a key this job cannot read must be skipped rather
    // than allowed to take the candidate query down with it.
    await ctx.services.db.query(
      `INSERT INTO upstream_cache (provider, cache_key, payload)
       VALUES ('musicbrainz', $1, '{"title":"x","artistName":"y"}'::jsonb)
       ON CONFLICT (provider, cache_key) DO NOTHING`,
      [`recording:not-a-uuid-${randomUUID().slice(0, 8)}`],
    );

    const outcome = await warmer(fakeMusicBrainz(), fakePreviews()).run();

    expect(outcome.ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("pacing", () => {
  test("the default MusicBrainz interval leaves at least half the global budget", () => {
    // Not a runtime assertion, a design one. The published limit is one request
    // per second for the entire service per IP. A background job that runs
    // exactly at the limit leaves nothing for anything else and is
    // indistinguishable from abuse from the outside.
    expect(CACHE_WARMER_DEFAULTS.musicbrainzIntervalMs).toBeGreaterThanOrEqual(
      2 * MUSICBRAINZ_MIN_INTERVAL_MS,
    );
    // iTunes: ten a minute, against a local budget of fifteen and a real-world
    // block observed at about nine.
    expect(60_000 / CACHE_WARMER_DEFAULTS.itunesIntervalMs).toBeLessThanOrEqual(
      10,
    );
  });

  test("every gap between two calls is at least the configured interval", async () => {
    const userId = await makeUser();
    for (let i = 0; i < 4; i += 1) await wishlist(userId);
    const clock = virtualClock();
    const mb = fakeMusicBrainz();

    await warmer(mb, fakePreviews(), {
      now: clock.now,
      sleep: clock.sleep,
      // Deliberately not the default, so the assertion is about the mechanism
      // rather than about the constant.
      musicbrainzIntervalMs: 2500,
      itunesIntervalMs: 2500,
    }).run();

    expect(mb.calls.length).toBeGreaterThan(1);
    // Never below the provider's own floor, and never below what we asked for.
    for (const wait of clock.waits) {
      expect(wait).toBeGreaterThanOrEqual(MUSICBRAINZ_MIN_INTERVAL_MS);
      expect(wait).toBe(2500);
    }
  });

  test("the run stops at its deadline rather than overrunning its schedule", async () => {
    // Runs must finish well inside their scheduling interval, or two of them
    // overlap on one egress IP and the observed rate doubles against a limit
    // that does not care they were separate jobs.
    const userId = await makeUser();
    for (let i = 0; i < 20; i += 1) await wishlist(userId);
    const clock = virtualClock();
    const mb = fakeMusicBrainz();

    const outcome = await warmer(mb, fakePreviews(), {
      now: clock.now,
      sleep: clock.sleep,
      musicbrainzIntervalMs: 2000,
      runDeadlineMs: 5000,
    }).run();

    expect(outcome.musicbrainz.deadlineHit).toBe(true);
    // t = 0, 2000, 4000. The next wait would land at 6000, past the deadline,
    // and the call is NOT made: a call issued after the deadline is the
    // overrun this bound exists to prevent.
    expect(mb.calls).toHaveLength(3);
    // And the preview phase gets nothing rather than running past the deadline.
    expect(outcome.itunes.called).toBe(0);
  });

  test("a phase stops at its own call ceiling and says so", async () => {
    const userId = await makeUser();
    for (let i = 0; i < 5; i += 1) await wishlist(userId);
    const mb = fakeMusicBrainz();

    const outcome = await warmer(mb, fakePreviews(), {
      musicbrainzMaxCalls: 2,
      itunesMaxCalls: 1,
    }).run();

    expect(mb.calls).toHaveLength(2);
    expect(outcome.musicbrainz.capped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("yielding the budget", () => {
  for (const kind of [
    "rate_limited",
    "quota_exhausted",
    "queue_overflow",
    "circuit_open",
    "disabled",
  ] as const) {
    test(`stops the phase immediately on ${kind}`, async () => {
      // Background work is the thing that should disappear when a shared budget
      // tightens. A warmer that keeps pushing into a throttle is how an IP gets
      // blocked, and a blocked IP starves user-facing traffic completely rather
      // than partially.
      const userId = await makeUser();
      for (let i = 0; i < 5; i += 1) await wishlist(userId);
      const mb = fakeMusicBrainz(new Map([[2, kind]]));

      const outcome = await warmer(mb, fakePreviews()).run();

      expect(mb.calls).toHaveLength(2);
      expect(outcome.musicbrainz.yieldedOn).toBe(kind);
      // Not counted as a failure: yielding is the system working as designed.
      expect(outcome.musicbrainz.failed).toBe(0);
    });
  }

  test("a provider error that is not contention is counted and the run continues", async () => {
    // A single 500 is not evidence that the budget is tight. Stopping the whole
    // run on one is how a warmer quietly never warms anything.
    const userId = await makeUser();
    for (let i = 0; i < 5; i += 1) await wishlist(userId);
    const mb = fakeMusicBrainz(new Map([[1, "server_error"]]));

    const outcome = await warmer(mb, fakePreviews()).run();

    expect(mb.calls.length).toBeGreaterThan(1);
    expect(outcome.musicbrainz.failed).toBe(1);
    expect(outcome.musicbrainz.yieldedOn).toBeNull();
  });

  test("a run of provider errors ends the phase", async () => {
    // An upstream that is simply down should be left alone rather than walked
    // one candidate at a time until the call ceiling runs out.
    const userId = await makeUser();
    for (let i = 0; i < 10; i += 1) await wishlist(userId);
    const failures = new Map<number, UpstreamErrorKind>();
    for (let i = 1; i <= 10; i += 1) failures.set(i, "server_error");
    const mb = fakeMusicBrainz(failures);

    const outcome = await warmer(mb, fakePreviews(), {
      maxConsecutiveFailures: 3,
    }).run();

    expect(mb.calls).toHaveLength(3);
    expect(outcome.musicbrainz.failed).toBe(3);
  });

  test("a bug in our own code is loud rather than swallowed", async () => {
    // A non-UpstreamError escaping a provider client is a defect here.
    // Swallowing it would turn it into a warmer that reports clean runs and
    // warms nothing, which is the failure mode nobody notices.
    await wishlist(await makeUser());
    const mb: MusicBrainzWarmTarget = {
      warmRecording: () => Promise.reject(new TypeError("undefined is not a")),
      warmArtist: () => Promise.resolve({}),
      warmRelease: () => Promise.resolve({}),
    };

    await expect(warmer(mb, fakePreviews()).run()).rejects.toThrow(TypeError);
  });

  test("a lock is still released after a thrown bug", async () => {
    const mb: MusicBrainzWarmTarget = {
      warmRecording: () => Promise.reject(new TypeError("boom")),
      warmArtist: () => Promise.resolve({}),
      warmRelease: () => Promise.resolve({}),
    };
    await wishlist(await makeUser());
    await expect(warmer(mb, fakePreviews()).run()).rejects.toThrow();

    expect((await warmer(fakeMusicBrainz(), fakePreviews()).run()).ran).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
describe("concurrency", () => {
  test("declines to start when another warm holds the lock, and calls nothing", async () => {
    // Two warmers on one egress IP double the observed rate against a per-IP
    // limit. That is the arithmetic the lock exists to prevent, and it is why
    // declining is the correct outcome rather than queueing.
    //
    // The lock is taken here on a PINNED connection, exactly as the job takes
    // it: through the pool it would land on a connection that is immediately
    // returned, and the job could be handed the same one and re-acquire it,
    // because advisory locks are re-entrant within a session.
    await wishlist(await makeUser());
    const mb = fakeMusicBrainz();

    await ctx.services.db.withConnection(async (holder) => {
      const acquired = await tryAdvisoryLock(
        holder,
        LOCK_NAMESPACE.cacheWarm,
        CACHE_WARM_LOCK_KEY,
      );
      expect(acquired).toBe(true);

      try {
        const outcome = await warmer(mb, fakePreviews()).run();

        expect(outcome.ran).toBe(false);
        expect(mb.calls).toHaveLength(0);
      } finally {
        await advisoryUnlock(
          holder,
          LOCK_NAMESPACE.cacheWarm,
          CACHE_WARM_LOCK_KEY,
        );
      }
    });
  });

  test("releases the lock, so the next run can proceed", async () => {
    expect((await warmer(fakeMusicBrainz(), fakePreviews()).run()).ran).toBe(
      true,
    );
    expect((await warmer(fakeMusicBrainz(), fakePreviews()).run()).ran).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
describe("reachability", () => {
  test("no route can reach MusicBrainz or iTunes, warm or otherwise", () => {
    const paths = ctx.routes.map((r) => r.url.toLowerCase());
    for (const forbidden of ["warm", "musicbrainz", "itunes"]) {
      expect(
        paths.filter((p) => p.includes(forbidden)),
        `a route mentioning "${forbidden}" appeared`,
      ).toEqual([]);
    }
  });

  test("the preview warmer has no Deezer fallback", () => {
    // A Deezer URL is signed and expiring and is never persisted, so resolving
    // one in a background job spends an upstream call and warms nothing. The
    // request path keeps its fallback; the warmer does not get one.
    expect(ctx.services.upstream.previewWarmer).not.toBe(
      ctx.services.upstream.previews,
    );
  });
});
