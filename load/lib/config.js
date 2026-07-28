/**
 * Environment configuration and safety guards for every scenario.
 *
 * One module owns every knob so that "how do I make this shorter / smaller /
 * point somewhere else" has exactly one answer, and so the guards below cannot
 * be bypassed by a scenario that forgot to call them.
 */
import exec from "k6/execution";

const env = (k, d) => {
  const v = __ENV[k];
  return v === undefined || v === "" ? d : v;
};
const num = (k, d) => {
  const v = Number(env(k, d));
  return Number.isFinite(v) ? v : d;
};
const bool = (k, d) => {
  const v = env(k, d ? "1" : "0");
  return v === "1" || v.toLowerCase() === "true";
};

/** Hosts that are never a valid target. Pointing the load suite at any of these
 *  is the failure mode PLAN.md section 8 exists to prevent, so it is not
 *  overridable by an environment variable. */
const FORBIDDEN_HOSTS = [
  "musicbrainz.org",
  "listenbrainz.org",
  "audioscrobbler.com",
  "last.fm",
  "itunes.apple.com",
  "apple.com",
  "deezer.com",
  "dzcdn.net",
  "reccobeats.com",
  "acousticbrainz.org",
  "spotify.com",
];

/** Hosts that are obviously non-production. Anything else needs an explicit
 *  acknowledgement, because "load test hit prod" is a career-defining incident
 *  and a typo in BASE_URL is all it takes. */
const SAFE_HOST_PATTERNS = [
  /^localhost$/,
  /^127\./,
  /^\[?::1\]?$/,
  /^0\.0\.0\.0$/,
  /staging/,
  /^test\./,
  /\.test$/,
  /\.local$/,
  /^host\.docker\.internal$/,
];

/** Read before CONFIG so the session shape can default differently for a
 *  shakeout run. A session is ~20 actions with human think time, which is 1 to
 *  2 minutes; a 30 second smoke run would otherwise complete zero sessions and
 *  measure nothing. */
const SMOKE = bool("SMOKE", false);

export const CONFIG = {
  baseUrl: env("BASE_URL", "http://127.0.0.1:3000").replace(/\/$/, ""),
  mockUrl: env("MOCK_URL", "http://127.0.0.1:8787").replace(/\/$/, ""),

  // Shape of the run. Every scenario derives its stages from these so a smoke
  // run is `DURATION=30s RAMP_UP=5s RAMP_DOWN=5s`.
  duration: env("DURATION", "30m"),
  rampUp: env("RAMP_UP", "2m"),
  rampDown: env("RAMP_DOWN", "1m"),

  /** Load held at full rate BEFORE measurement starts, so the cache is warm
   *  when the SLO window opens. Excluded from every threshold. See lib/phase.js
   *  for why the ">90% warm cache" gate is otherwise decided by run length. */
  warmup: env("WARMUP", SMOKE ? "15s" : "5m"),

  /** Sessions started per second. See TRAFFIC MODEL in README.md for the
   *  derivation. This is the single number that sets load level. */
  arrivalRate: num("ARRIVAL_RATE", 2.3),
  preAllocatedVUs: num("PRE_ALLOCATED_VUS", 300),
  maxVUs: num("MAX_VUS", 800),

  /** Registered users the run draws from. 10k is the engineered scale target. */
  userPool: num("USER_POOL", 10_000),

  // Session shape. Defaults encode the plan's model: 1 feed load, ~15 preview
  // resolves, a few wishlist writes.
  actionsPerSession: num("ACTIONS_PER_SESSION", SMOKE ? 4 : 20),

  /** Multiplier on every think-time. 1 is human paced. 0 removes think time
   *  entirely, which is a max-pressure run and NOT a realistic one. */
  thinkScale: num("THINK_SCALE", SMOKE ? 0.2 : 1),

  /** Popularity head. Real music catalogs are extremely head-heavy, and the
   *  ">90% warm cache" gate is only meaningful against traffic that has a
   *  realistic head/tail split. Uniform sampling over 2M tracks would make a
   *  100% correct cache look like a 1% hit rate.
   *
   *  2,000 head items at a 95% share is a curated-feed distribution, not a raw
   *  catalog one: what 2,000 DAU actually see is whatever the recommender
   *  surfaces, which is far more concentrated than the catalog. */
  hotSetSize: num("HOT_SET_SIZE", 2_000),
  hotSetShare: num("HOT_SET_SHARE", 0.95),

  /** Universe the 5% tail is drawn from in WARM scenarios. Bounded, not the
   *  full catalog, because the crosswalk is permanent: by the time a warm
   *  measurement is meaningful, the tail a real population reaches has already
   *  been resolved once. cold-cache overrides this to the full catalog. */
  tailSetSize: num("TAIL_SET_SIZE", 100_000),

  /** 'hot'  pick preview targets from the modeled popularity head
   *  'feed'  preview whatever the feed actually returned (more realistic once
   *          the real ranking exists; against a stub it produces a meaningless
   *          cache hit rate because the stub's feed is uniform random) */
  previewSource: env("PREVIEW_SOURCE", "hot"),

  /** Fetch the resolved preview URL as a browser would. This is what catches a
   *  wrongly cached Deezer URL: the mock's CDN verifies the signature. */
  verifyPreviewUrl: bool("VERIFY_PREVIEW_URL", false),

  /** Shifts the catalog window so a cold-cache run touches MBIDs nothing has
   *  resolved before, without needing the cache flushed first. */
  coldOffset: num("COLD_OFFSET", 0),

  /** Staging-only bearer token. The BFF must accept it ONLY when its own
   *  LOAD_TEST_MODE flag is on. See README, "Auth". */
  authToken: env("LOAD_AUTH_TOKEN", ""),

  resultsDir: env("RESULTS_DIR", "k6-results"),

  /** Relaxes thresholds and shortens sessions so a 30 second shakeout does not
   *  fail on a cold JIT and an empty cache. A run with SMOKE=1 is marked
   *  unusable for a gate record. */
  smoke: SMOKE,

  /** Continue even if the BFF does not answer /healthz. Useful only for
   *  inspecting the scenario's own behavior. */
  allowUnreachable: bool("ALLOW_UNREACHABLE", false),

  acknowledgedProd: bool("I_KNOW_THIS_IS_PROD", false),
  acknowledgedBurst: bool("I_UNDERSTAND_BURST_50K_IS_DEFERRED", false),
};

function hostOf(url) {
  // k6 has no URL class in the init context, so parse by hand.
  const m = /^[a-z]+:\/\/([^/:]+)/i.exec(url);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Refuses to run against a real upstream, always. Refuses to run against
 * anything that is not obviously non-production unless explicitly acknowledged.
 *
 * Called from every scenario's init context, so the process dies before a
 * single request leaves.
 */
export function assertSafeTarget(url = CONFIG.baseUrl) {
  const host = hostOf(url);
  if (!host) {
    throw new Error(`BASE_URL does not look like a URL: ${url}`);
  }
  for (const forbidden of FORBIDDEN_HOSTS) {
    if (host === forbidden || host.endsWith(`.${forbidden}`)) {
      throw new Error(
        [
          "",
          "REFUSING TO RUN.",
          `  Target host ${host} is a real upstream provider.`,
          "  Load testing real providers is what PLAN.md section 8 forbids:",
          "  MusicBrainz allows 1 req/s globally and Last.fm revokes access",
          "  without appeal. There is no override for this check.",
          "",
        ].join("\n"),
      );
    }
  }
  if (CONFIG.acknowledgedProd) return;
  if (SAFE_HOST_PATTERNS.some((re) => re.test(host))) return;
  throw new Error(
    [
      "",
      "REFUSING TO RUN.",
      `  BASE_URL host "${host}" is not recognisably a local or staging target.`,
      "  This suite generates sustained load and writes to /v1/wishlist.",
      "  If you really mean it, set I_KNOW_THIS_IS_PROD=1.",
      "",
    ].join("\n"),
  );
}

/**
 * Preflight against /healthz. Aborts with an actionable message rather than
 * letting the run produce 30 minutes of connection errors, which is the usual
 * outcome when the BFF is not up yet.
 *
 * @param {typeof import('k6/http').default} http
 */
export function preflight(http, { requireMock = false } = {}) {
  const health = http.get(`${CONFIG.baseUrl}/healthz`, {
    timeout: "5s",
    tags: { endpoint: "healthz", slo: "no" },
  });

  if (health.status !== 200) {
    const message = [
      "",
      `BFF unreachable at ${CONFIG.baseUrl}/healthz (status ${health.status}${health.error ? `, ${health.error}` : ""}).`,
      "",
      "  apps/bff does not exist yet, which is expected this early in the plan.",
      "  To exercise the suite anyway, start the mock with the fake BFF attached:",
      "",
      "    node load/mock-upstreams/server.js --bff-stub",
      "    BASE_URL=http://127.0.0.1:8787 k6 run load/scenarios/steady-10k.js",
      "",
      "  Or set ALLOW_UNREACHABLE=1 to continue and watch it fail on purpose.",
      "",
    ].join("\n");
    if (!CONFIG.allowUnreachable) exec.test.abort(message);
    console.warn(message);
  }

  let mockOk = false;
  const mock = http.get(`${CONFIG.mockUrl}/__admin/health`, {
    timeout: "5s",
    tags: { endpoint: "mock_admin", slo: "no" },
  });
  mockOk = mock.status === 200;
  if (requireMock && !mockOk) {
    exec.test.abort(
      [
        "",
        `Mock upstream control plane unreachable at ${CONFIG.mockUrl}/__admin/health.`,
        "  This scenario drives upstream faults, so it cannot run without it.",
        "",
        "    node load/mock-upstreams/server.js",
        "",
      ].join("\n"),
    );
  }

  // A stub run must never be filed as gate evidence. Detected here and carried
  // into the summary rather than trusted to the operator's memory.
  const stubbed = String(health.headers["X-Pullfm-Stub"] ?? "") === "1";

  return {
    healthy: health.status === 200,
    mockAvailable: mockOk,
    stubbed,
    startedAt: new Date().toISOString(),
  };
}

/** Parse a k6 duration string ("30m", "4h", "90s", "1h30m") into seconds.
 *  Needed because scenarios have to reason about their own length (the soak
 *  splits itself into early and late phases) and k6 exposes no parser. */
export function durationSeconds(str) {
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g;
  let total = 0;
  let m;
  let matched = false;
  while ((m = re.exec(str)) !== null) {
    matched = true;
    const n = Number(m[1]);
    total +=
      m[2] === "h"
        ? n * 3600
        : m[2] === "m"
          ? n * 60
          : m[2] === "ms"
            ? n / 1000
            : n;
  }
  if (!matched) throw new Error(`cannot parse duration: ${str}`);
  return total;
}

/** Trend statistics the summary reports. p(99) is not in k6's default set and
 *  the SLO table has a p99 row, so it has to be requested explicitly. */
export const SUMMARY_TREND_STATS = [
  "avg",
  "min",
  "med",
  "p(90)",
  "p(95)",
  "p(99)",
  "max",
  "count",
];
