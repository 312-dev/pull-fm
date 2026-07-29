/**
 * Background cache warming for the two providers no request may ever call.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `DiscoveryService.warmArtist`, `warmRecording` and `warmRelease` have been
 * implemented and tested since the MusicBrainz layer landed, and NOTHING CALLED
 * THEM. The comment above them says they "are the sanctioned entry point for
 * the background resolver, and they exist now so that job is a scheduler plus a
 * query rather than a second, uncached code path written under time pressure".
 * This is that job. `PreviewResolver.resolve` was in the same position: the only
 * caller on the request path is `resolveCached`, which never calls out.
 *
 * Why that matters more here than in a normal service. MusicBrainz permits ONE
 * REQUEST PER SECOND across the entire service, per IP, and iTunes about twenty
 * calls a minute with no documented scope and no appeals process for a block.
 * A cold cache is therefore not a slow product, it is an outage plus a terms
 * violation: the request path answers from `peek` and drops what it cannot
 * name, so an unwarmed MBID renders as a missing shelf item forever, and the
 * only alternative - filling it synchronously - would spend the global budget
 * of the whole service on one page render.
 *
 * ---------------------------------------------------------------------------
 * WHAT GETS WARMED, IN WHAT ORDER, AND WHY THAT ORDER
 *
 * MusicBrainz, highest priority first:
 *
 *   1. Wishlist recordings   Explicit, durable user intent. Somebody said "I
 *   2. Wishlist artists      want this" and will open a screen that renders it.
 *   3. Wishlist releases     The wishlist also carries denormalized names, so a
 *                            warmed row upgrades a provisional name to the
 *                            canonical one rather than creating a name from
 *                            nothing.
 *   4. Crosswalk recordings  MBIDs that real traffic has already resolved. This
 *   5. Crosswalk artists     is the feed's working set, evidenced rather than
 *   6. Crosswalk releases    guessed, and it is what moves the Gate 2 warm hit
 *                            rate.
 *
 * Newest first inside each tier, because a recently added wishlist item or a
 * recently resolved crosswalk entry is the one somebody is about to look at.
 *
 * What is deliberately NOT warmed: anything not already referenced by a user's
 * wishlist or by a resolution the product actually performed. There is no
 * crawl, no backfill of MusicBrainz, and no speculative fan-out. At 1 req/s a
 * crawl would never finish, and it would spend a shared global budget on rows
 * nobody asked for.
 *
 * iTunes previews, highest priority first:
 *
 *   1. Wishlist recordings with no servable preview. The wishlist row already
 *      carries `artist_name` and `title`, so this costs no MusicBrainz call.
 *   2. Recordings the MusicBrainz cache can name, with no servable preview.
 *
 * "No servable preview" is not the same as "no row". A row with a NULL
 * `store_url` cannot satisfy Apple's licence condition (ii) and is never
 * served, and a row past `revalidate_after` must be re-resolved because Apple
 * may withdraw content at any time. Both are candidates, exactly as
 * `resolveCached` treats them.
 *
 * ---------------------------------------------------------------------------
 * HOW IT YIELDS, WHICH IS THE WHOLE SAFETY PROPERTY
 *
 * The budget is per-IP and global. This job runs as a separate process from the
 * API nodes, so it does NOT share their in-process rate limiter and cannot be
 * paced by it. Four independent controls make it a good citizen anyway:
 *
 *   1. IT TAKES A FRACTION OF THE LIMIT, NOT THE LIMIT. The default pacing is
 *      one MusicBrainz call every 2000ms against a 1000ms floor, so the warmer
 *      spends at most half the global budget and leaves the rest as headroom.
 *      A background job that runs exactly at the published limit leaves nothing
 *      for anything else and is indistinguishable from abuse from the outside.
 *      iTunes is paced at one call per 6000ms, ten a minute against a local
 *      budget of fifteen and an observed real-world block at about nine.
 *
 *   2. IT STOPS AT THE FIRST SIGN OF CONTENTION. A `rate_limited`,
 *      `quota_exhausted`, `queue_overflow`, `circuit_open` or `disabled`
 *      failure ENDS THE PHASE for this run. It does not retry, and it does not
 *      continue to the next candidate. Background work is the thing that should
 *      disappear when a budget is tight; the alternative - a warmer that keeps
 *      pushing into a 429 - is how an IP gets blocked, and a blocked IP starves
 *      user-facing traffic completely rather than partially.
 *
 *   3. IT IS BOUNDED IN BOTH CALLS AND WALL CLOCK. Per-phase call ceilings and
 *      a whole-run deadline mean a run always ends well before the next
 *      scheduled tick, so two runs cannot overlap by simply taking too long.
 *
 *   4. IT IS SINGLE-FLIGHT. An advisory lock means a second invocation declines
 *      rather than doubling the rate. Two warmers on one egress IP is exactly
 *      the arithmetic that turns a compliant pace into a violation.
 *
 * A consecutive-failure ceiling backs (2) up for the failure kinds that are not
 * contention: an upstream that is simply down should be left alone rather than
 * walked candidate by candidate.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY AND FAILURE
 *
 * This job writes only cache rows, through the same read-through path the
 * request layer uses, so there is no application state a partial run can leave
 * inconsistent: a warmed row is a row somebody would have warmed anyway, and an
 * unwarmed one is simply still cold. That is what makes stopping at any point
 * safe, and it is why the yield rules above can be as blunt as they are.
 *
 * Idempotent. The candidate query excludes anything already cached and unexpired,
 * so a second run finds the rows the first one warmed already gone from its own
 * working set.
 *
 * The advisory lock is held on a PINNED connection for the whole run, via
 * `Database.withConnection`. A session-scoped lock taken through the pool lands
 * on whichever connection served that one query and is then returned to the
 * pool, so the unlock usually runs on a different connection and leaks the
 * lock, while a concurrent caller handed the same connection re-acquires it
 * because advisory locks are re-entrant within a session. The transaction-scoped
 * variant is unavailable here: this run makes many outbound HTTP calls over
 * many minutes and would die on `idle_in_transaction_session_timeout`.
 */

import {
  isUpstreamError,
  type ResolvedPreview,
  type TrackIdentity,
  type UpstreamErrorKind,
} from "@pull-fm/upstream";

import {
  advisoryUnlock,
  LOCK_NAMESPACE,
  tryAdvisoryLock,
  type Database,
  type Queryable,
} from "../lib/db.js";
import { intFromEnv } from "../lib/job-env.js";

/** Advisory-lock key, inside the shared namespace registry in lib/db.ts. */
export const CACHE_WARM_LOCK_KEY = "upstream:cache-warm";

/**
 * The MusicBrainz warm path, narrowed to what this job uses.
 *
 * A structural interface rather than `DiscoveryService`, so the yield and
 * pacing rules - which are the whole point of the job - can be asserted against
 * a substitute that counts calls, without standing up a discovery service and
 * every dependency behind it.
 */
export interface MusicBrainzWarmTarget {
  warmRecording(mbid: string): Promise<unknown>;
  warmArtist(mbid: string): Promise<unknown>;
  warmRelease(mbid: string): Promise<unknown>;
}

/** The preview warm path. `UpstreamBundle.previewWarmer` satisfies it. */
export interface PreviewWarmTarget {
  resolve(track: TrackIdentity): Promise<ResolvedPreview | null>;
}

export interface CacheWarmerOptions {
  /**
   * Minimum ms between two MusicBrainz calls. MUST be above their 1000ms floor,
   * and should be a multiple of it so the warmer leaves headroom. See control 1.
   */
  readonly musicbrainzIntervalMs: number;
  readonly musicbrainzMaxCalls: number;
  /** Minimum ms between two iTunes calls. Ten a minute at the default. */
  readonly itunesIntervalMs: number;
  readonly itunesMaxCalls: number;
  /** Hard wall-clock ceiling on one run, so two runs cannot overlap. */
  readonly runDeadlineMs: number;
  /**
   * Consecutive non-contention failures that end a phase.
   *
   * A provider that is down should be left alone, not walked one candidate at a
   * time until the call ceiling runs out.
   */
  readonly maxConsecutiveFailures: number;
  /** Injectable clock and sleep, so the pacing rules are testable. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const CACHE_WARMER_DEFAULTS: Omit<CacheWarmerOptions, "now" | "sleep"> =
  {
    // Twice MusicBrainz's 1000ms floor: half the global budget, deliberately.
    musicbrainzIntervalMs: 2000,
    // 300 * 2s = 600s of pacing, comfortably inside the deadline below.
    musicbrainzMaxCalls: 300,
    // Ten a minute against a local budget of fifteen and a real-world block
    // observed at about nine (docs/compliance/apple-itunes-terms-review.md A7).
    itunesIntervalMs: 6000,
    // 60 * 6s = 360s. 600 + 360 = 960s, inside the 20 minute deadline.
    itunesMaxCalls: 60,
    runDeadlineMs: 20 * 60_000,
    maxConsecutiveFailures: 5,
  };

/**
 * Resolves the options from the environment, falling back to the defaults.
 *
 * Lives beside the defaults rather than in `wiring.ts` so the variable names
 * and the pacing arithmetic they override are one screen apart. See
 * lib/job-env.ts for why these are not in `config.ts`. `now` and `sleep` are
 * absent on purpose: they are test seams, not operator knobs, and an
 * environment that could shorten the pacing sleep could turn this job into a
 * terms violation without touching the interval it appears to respect.
 */
export function cacheWarmerOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Omit<CacheWarmerOptions, "now" | "sleep"> {
  const d = CACHE_WARMER_DEFAULTS;
  return {
    musicbrainzIntervalMs: intFromEnv(
      "WARM_MUSICBRAINZ_INTERVAL_MS",
      d.musicbrainzIntervalMs,
      env,
    ),
    musicbrainzMaxCalls: intFromEnv(
      "WARM_MUSICBRAINZ_MAX_CALLS",
      d.musicbrainzMaxCalls,
      env,
    ),
    itunesIntervalMs: intFromEnv(
      "WARM_ITUNES_INTERVAL_MS",
      d.itunesIntervalMs,
      env,
    ),
    itunesMaxCalls: intFromEnv("WARM_ITUNES_MAX_CALLS", d.itunesMaxCalls, env),
    runDeadlineMs: intFromEnv("WARM_RUN_DEADLINE_MS", d.runDeadlineMs, env),
    maxConsecutiveFailures: intFromEnv(
      "WARM_MAX_CONSECUTIVE_FAILURES",
      d.maxConsecutiveFailures,
      env,
    ),
  };
}

/**
 * Failure kinds that mean "someone else needs this budget more than we do".
 *
 * Every one of them is a signal that the provider, the local quota, or the
 * shared queue is already saturated. A background job's correct response to all
 * five is to stop, not to retry: retrying is what converts a throttle into a
 * block, and a block starves user-facing traffic completely.
 */
const YIELD_KINDS: ReadonlySet<UpstreamErrorKind> = new Set([
  "rate_limited",
  "quota_exhausted",
  "queue_overflow",
  "circuit_open",
  "disabled",
]);

export interface PhaseOutcome {
  /** Candidates the query returned. */
  readonly considered: number;
  /** Upstream calls actually made. */
  readonly called: number;
  /** Calls that produced something worth keeping. */
  readonly warmed: number;
  /** Calls that succeeded but found nothing (a 404, or no preview). */
  readonly empty: number;
  /** Calls that failed for a reason that was not contention. */
  readonly failed: number;
  /** Non-null when the phase stopped early because it yielded the budget. */
  readonly yieldedOn: UpstreamErrorKind | null;
  /** True when the phase stopped because the run deadline passed. */
  readonly deadlineHit: boolean;
  /** True when the phase stopped because it hit its own call ceiling. */
  readonly capped: boolean;
}

export interface WarmOutcome {
  /** False when another run held the lock. Not an error. */
  readonly ran: boolean;
  readonly musicbrainz: PhaseOutcome;
  readonly itunes: PhaseOutcome;
}

const EMPTY_PHASE: PhaseOutcome = {
  considered: 0,
  called: 0,
  warmed: 0,
  empty: 0,
  failed: 0,
  yieldedOn: null,
  deadlineHit: false,
  capped: false,
};

const EMPTY: WarmOutcome = {
  ran: false,
  musicbrainz: EMPTY_PHASE,
  itunes: EMPTY_PHASE,
};

/**
 * MusicBrainz candidates: referenced by the product, not yet cached.
 *
 * `NOT EXISTS` against `upstream_cache` is what makes this idempotent and what
 * makes negative results cheap: a 404 from MusicBrainz is cached as a JSON
 * `null` payload under the same key, so a dead MBID is asked about once per TTL
 * rather than once per run. Without that this job would spend the same slice of
 * a 1 req/s global budget on the same missing MBID every night forever.
 *
 * The wishlist tiers are joined to live users only. Warming a soft-deleted
 * account's wishlist would spend a shared, rate-limited budget on data nobody
 * will ever be shown.
 *
 * The two-level query is not cosmetic: `DISTINCT ON` must order by its own
 * key, so the priority ordering has to be applied outside it or an MBID that
 * appears in two tiers would be de-duplicated correctly and then returned in
 * MBID order.
 */
const MUSICBRAINZ_CANDIDATES = `
WITH live_wishlist AS (
    SELECT w.recording_mbid, w.artist_mbid, w.release_mbid, w.created_at
      FROM wishlist_items w
      JOIN users u ON u.id = w.user_id AND u.deleted_at IS NULL
     WHERE w.status <> 'dismissed'
),
candidates AS (
    SELECT 1 AS priority, 'recording' AS entity, recording_mbid AS mbid, created_at
      FROM live_wishlist WHERE recording_mbid IS NOT NULL
    UNION ALL
    SELECT 2, 'artist', artist_mbid, created_at
      FROM live_wishlist WHERE artist_mbid IS NOT NULL
    UNION ALL
    SELECT 3, 'release', release_mbid, created_at
      FROM live_wishlist WHERE release_mbid IS NOT NULL
    UNION ALL
    SELECT 4, 'recording', mbid, created_at
      FROM mbid_crosswalk WHERE entity_type = 'recording'
    UNION ALL
    SELECT 5, 'artist', mbid, created_at
      FROM mbid_crosswalk WHERE entity_type = 'artist'
    UNION ALL
    SELECT 6, 'release', mbid, created_at
      FROM mbid_crosswalk WHERE entity_type = 'release'
),
deduped AS (
    SELECT DISTINCT ON (c.entity, c.mbid) c.priority, c.entity, c.mbid, c.created_at
      FROM candidates c
     WHERE NOT EXISTS (
         SELECT 1 FROM upstream_cache uc
          WHERE uc.provider  = 'musicbrainz'
            AND uc.cache_key = c.entity || ':' || c.mbid::text
            AND (uc.expires_at IS NULL OR uc.expires_at > now())
     )
     ORDER BY c.entity, c.mbid, c.priority, c.created_at DESC
)
SELECT entity, mbid::text AS mbid
  FROM deduped
 ORDER BY priority, created_at DESC
 LIMIT $1::int`;

/**
 * iTunes candidates: nameable recordings with no servable preview.
 *
 * Tier 2 reads the name back out of the MusicBrainz cache rather than calling
 * MusicBrainz, which is the point of running the MusicBrainz phase first. The
 * cache-key regex is a fail-closed guard: `substring(...)::uuid` on a key that
 * is not shaped like `recording:<uuid>` would abort the whole statement, so a
 * key this job cannot parse is SKIPPED rather than allowed to take the query
 * down with it.
 *
 * "Servable" mirrors `PreviewResolver.resolveCached` exactly: a row with a NULL
 * `store_url` cannot satisfy Apple's licence condition (ii) and is never
 * served, and a row past `revalidate_after` must be re-resolved because Apple
 * may withdraw content at any time. Both are candidates.
 */
const ITUNES_CANDIDATES = `
WITH named AS (
    SELECT 1 AS priority,
           w.recording_mbid AS mbid,
           w.artist_name,
           w.title,
           w.created_at
      FROM wishlist_items w
      JOIN users u ON u.id = w.user_id AND u.deleted_at IS NULL
     WHERE w.recording_mbid IS NOT NULL
       AND w.status <> 'dismissed'
       AND w.artist_name <> ''
       AND w.title       <> ''
    UNION ALL
    SELECT 2,
           substring(uc.cache_key from 11)::uuid,
           uc.payload->>'artistName',
           uc.payload->>'title',
           uc.fetched_at
      FROM upstream_cache uc
     WHERE uc.provider = 'musicbrainz'
       AND uc.cache_key ~ '^recording:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND uc.payload->>'artistName' IS NOT NULL
       AND uc.payload->>'title'      IS NOT NULL
),
deduped AS (
    SELECT DISTINCT ON (n.mbid) n.priority, n.mbid, n.artist_name, n.title, n.created_at
      FROM named n
     WHERE NOT EXISTS (
         SELECT 1 FROM track_previews tp
          WHERE tp.recording_mbid   = n.mbid
            AND tp.provider         = 'itunes'
            AND tp.store_url IS NOT NULL
            AND tp.revalidate_after > now()
     )
     ORDER BY n.mbid, n.priority, n.created_at DESC
)
SELECT mbid::text AS mbid, artist_name, title
  FROM deduped
 ORDER BY priority, created_at DESC
 LIMIT $1::int`;

interface MusicBrainzCandidate {
  readonly entity: string;
  readonly mbid: string;
}

interface ItunesCandidate {
  readonly mbid: string;
  readonly artist_name: string;
  readonly title: string;
}

/** Accumulator for one phase. Collapsed into a PhaseOutcome at the end. */
interface PhaseState {
  considered: number;
  called: number;
  warmed: number;
  empty: number;
  failed: number;
  consecutiveFailures: number;
  yieldedOn: UpstreamErrorKind | null;
  deadlineHit: boolean;
  capped: boolean;
}

const newPhase = (): PhaseState => ({
  considered: 0,
  called: 0,
  warmed: 0,
  empty: 0,
  failed: 0,
  consecutiveFailures: 0,
  yieldedOn: null,
  deadlineHit: false,
  capped: false,
});

const seal = (p: PhaseState): PhaseOutcome => ({
  considered: p.considered,
  called: p.called,
  warmed: p.warmed,
  empty: p.empty,
  failed: p.failed,
  yieldedOn: p.yieldedOn,
  deadlineHit: p.deadlineHit,
  capped: p.capped,
});

export class CacheWarmer {
  readonly #db: Database;
  readonly #musicbrainz: MusicBrainzWarmTarget;
  readonly #previews: PreviewWarmTarget;
  readonly #opts: CacheWarmerOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    db: Database,
    musicbrainz: MusicBrainzWarmTarget,
    previews: PreviewWarmTarget,
    opts: CacheWarmerOptions,
  ) {
    this.#db = db;
    this.#musicbrainz = musicbrainz;
    this.#previews = previews;
    this.#opts = opts;
    this.#now = opts.now ?? (() => Date.now());
    this.#sleep =
      opts.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /**
   * Runs one warm pass.
   *
   * Returns a summary rather than throwing, so a scheduler can tell "another
   * run holds the lock" from "we yielded the budget" from "the provider is
   * failing" without parsing an error string. Only a failure to take the
   * connection, the lock, or to read the candidate list propagates: a candidate
   * list we cannot read is a working set we must not guess at.
   */
  async run(): Promise<WarmOutcome> {
    const deadline = this.#now() + this.#opts.runDeadlineMs;

    return await this.#db.withConnection(async (locked) => {
      if (
        !(await tryAdvisoryLock(
          locked,
          LOCK_NAMESPACE.cacheWarm,
          CACHE_WARM_LOCK_KEY,
        ))
      ) {
        // Another warmer is running. Declining is the correct outcome: two
        // warmers on one egress IP would double the rate against a per-IP
        // limit, which is the arithmetic this lock exists to prevent.
        return EMPTY;
      }
      try {
        // MusicBrainz first, and not only because it is the tighter limit: tier
        // 2 of the preview query reads names out of the rows this phase writes,
        // so running it second is what lets a preview be resolved for a
        // recording that was cold at the start of the run.
        const musicbrainz = await this.#warmMusicBrainz(locked, deadline);
        const itunes = await this.#warmPreviews(locked, deadline);
        return { ran: true, musicbrainz, itunes };
      } finally {
        await advisoryUnlock(
          locked,
          LOCK_NAMESPACE.cacheWarm,
          CACHE_WARM_LOCK_KEY,
        ).catch(() => undefined);
      }
    });
  }

  async #warmMusicBrainz(
    client: Queryable,
    deadline: number,
  ): Promise<PhaseOutcome> {
    const phase = newPhase();
    // One more than the ceiling, deliberately. Asking for exactly the ceiling
    // makes "the working set is bigger than one run's budget" and "we warmed
    // everything there was" produce identical output, and those are opposite
    // operational facts: the first means the cache is not converging.
    const { rows } = await client.query<MusicBrainzCandidate>(
      MUSICBRAINZ_CANDIDATES,
      [this.#opts.musicbrainzMaxCalls + 1],
    );
    phase.considered = rows.length;

    let lastCallAt = Number.NEGATIVE_INFINITY;
    for (const candidate of rows) {
      if (!this.#mayContinue(phase, deadline)) break;
      if (phase.called >= this.#opts.musicbrainzMaxCalls) {
        phase.capped = true;
        break;
      }
      lastCallAt = await this.#pace(
        lastCallAt,
        this.#opts.musicbrainzIntervalMs,
      );
      // Checked again: the wait itself may have crossed the deadline, and a
      // call made after it is a run overrunning its scheduling interval.
      if (!this.#mayContinue(phase, deadline)) break;
      await this.#attempt(phase, () => this.#warmOne(candidate));
    }

    return seal(phase);
  }

  /**
   * Dispatches one candidate to the right warm method.
   *
   * An entity this job does not recognise is SKIPPED rather than guessed at.
   * The candidate query only ever produces the three known values, so reaching
   * the default arm means the query changed underneath this code, and warming
   * the wrong entity type would write a cache row under a key the request path
   * then reads as the wrong shape.
   */
  async #warmOne(candidate: MusicBrainzCandidate): Promise<boolean> {
    switch (candidate.entity) {
      case "recording":
        return (await this.#musicbrainz.warmRecording(candidate.mbid)) !== null;
      case "artist":
        return (await this.#musicbrainz.warmArtist(candidate.mbid)) !== null;
      case "release":
        return (await this.#musicbrainz.warmRelease(candidate.mbid)) !== null;
      default:
        return false;
    }
  }

  async #warmPreviews(
    client: Queryable,
    deadline: number,
  ): Promise<PhaseOutcome> {
    const phase = newPhase();
    // One more than the ceiling; see the MusicBrainz phase.
    const { rows } = await client.query<ItunesCandidate>(ITUNES_CANDIDATES, [
      this.#opts.itunesMaxCalls + 1,
    ]);
    phase.considered = rows.length;

    let lastCallAt = Number.NEGATIVE_INFINITY;
    for (const candidate of rows) {
      if (!this.#mayContinue(phase, deadline)) break;
      if (phase.called >= this.#opts.itunesMaxCalls) {
        phase.capped = true;
        break;
      }
      lastCallAt = await this.#pace(lastCallAt, this.#opts.itunesIntervalMs);
      if (!this.#mayContinue(phase, deadline)) break;
      await this.#attempt(phase, async () => {
        const resolved = await this.#previews.resolve({
          recordingMbid: candidate.mbid,
          artistName: candidate.artist_name,
          title: candidate.title,
        });
        // `cacheable` is the honest test of whether anything was WARMED. This
        // resolver has no Deezer fallback, so in practice a resolved preview is
        // always a persisted iTunes one; the check is here so that if a future
        // provider with signed URLs is added, a result that was thrown away
        // cannot be counted as a row that now exists.
        return resolved?.cacheable === true;
      });
    }

    return seal(phase);
  }

  /** False once the phase must stop: deadline, yield, or repeated failure. */
  #mayContinue(phase: PhaseState, deadline: number): boolean {
    if (phase.yieldedOn !== null) return false;
    if (phase.consecutiveFailures >= this.#opts.maxConsecutiveFailures) {
      return false;
    }
    if (this.#now() >= deadline) {
      phase.deadlineHit = true;
      return false;
    }
    return true;
  }

  /**
   * Waits until `intervalMs` has passed since the previous call.
   *
   * Measured from DISPATCH rather than from completion, so a slow provider
   * cannot silently push the effective rate below the intended one, and a fast
   * one cannot push it above.
   */
  async #pace(lastCallAt: number, intervalMs: number): Promise<number> {
    const waitMs = intervalMs - (this.#now() - lastCallAt);
    if (waitMs > 0) await this.#sleep(waitMs);
    return this.#now();
  }

  /**
   * Runs one upstream call and folds the result into the phase.
   *
   * The three-way split is the important part:
   *
   *   contention   stop the phase entirely. See control 2 in the header.
   *   provider     count it, keep going, but a run of them ends the phase.
   *   our bug      RETHROWN. A non-`UpstreamError` escaping a provider client
   *                is a defect in this repository, and swallowing it here would
   *                turn it into a warmer that quietly warms nothing.
   */
  async #attempt(
    phase: PhaseState,
    call: () => Promise<boolean>,
  ): Promise<void> {
    phase.called += 1;
    try {
      const found = await call();
      phase.consecutiveFailures = 0;
      if (found) phase.warmed += 1;
      else phase.empty += 1;
    } catch (err) {
      if (!isUpstreamError(err)) throw err;
      if (YIELD_KINDS.has(err.kind)) {
        phase.yieldedOn = err.kind;
        return;
      }
      phase.failed += 1;
      phase.consecutiveFailures += 1;
    }
  }
}
