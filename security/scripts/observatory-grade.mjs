#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - measure the Gate 8 Observatory clause
//
// Gate 8 (docs/PLAN.md section 7) ends with "Observatory >= A+". That clause has
// never been measured. security/AUDIT-2026-07-29.md recorded it as "FAIL,
// unmeasurable" because the staging origin answered 521, so an Observatory grade
// would have described a Cloudflare error page.
//
// The origin is up now, and the clause is STILL not measurable by the official
// scanner, for a different and more specific reason. This tool does two things
// and keeps them clearly apart:
//
//   1. Calls the official MDN Observatory v2 API and reports its verdict
//      verbatim, including a refusal. That is the authoritative answer to
//      "what grade does Observatory give us".
//
//   2. Computes an Observatory-EQUIVALENT score locally from the live response
//      headers, using the documented modifiers, so there is a number and a
//      per-test breakdown even when the official scanner will not run. This is
//      an approximation and says so on every run. It is not a substitute for
//      clause 1 and must never be recorded as "the Observatory grade".
//
// WHY THE OFFICIAL SCANNER REFUSES
//
// Observatory fetches `/` and rejects a host whose root does not answer with a
// success or redirect. `GET https://api-staging.pull.fm/` returns 404 (correctly:
// the API declares no root operation), so the scan aborts with
// "Site did respond with an unexpected HTTP status code 404" before any header
// is examined. Every header Observatory grades is present and correct on that
// very response; only the status code stops it.
//
// Usage:
//   node security/scripts/observatory-grade.mjs <origin> [--path /] [--json]
// Exit: 0 the local score grades A+ or better, 1 below A+, 2 could not measure.
// ---------------------------------------------------------------------------

/**
 * Observatory grade boundaries. Lowest score that earns each grade, and the
 * scale is uncapped above 100: MDN's own site scores 110.
 */
const GRADE_CHART = [
  [100, "A+"],
  [95, "A"],
  [90, "A-"],
  [85, "B+"],
  [80, "B"],
  [75, "B-"],
  [70, "C+"],
  [65, "C"],
  [60, "C-"],
  [55, "D+"],
  [50, "D"],
  [45, "D-"],
  [0, "F"],
];

export function toGrade(score) {
  for (const [floor, grade] of GRADE_CHART) if (score >= floor) return grade;
  return "F";
}

/**
 * Six months in seconds, which is Observatory's HSTS threshold exactly.
 *
 * Worth spelling out because the live value is 15,552,000 (180 days) and the
 * threshold is 15,768,000 (182.5 days). The two look interchangeable and are
 * not: the shorter one costs 10 points every scan.
 */
const SIX_MONTHS = 15_768_000;

const lower = (headers) => {
  const out = {};
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
  return out;
};

// --- individual tests ------------------------------------------------------

export function scoreCsp(h) {
  const csp = h["content-security-policy"];
  if (!csp)
    return {
      name: "content-security-policy",
      modifier: -25,
      reason: "csp-not-implemented",
    };
  const v = csp.toLowerCase();
  const unsafe =
    v.includes("'unsafe-inline'") ||
    v.includes("'unsafe-eval'") ||
    v.includes("http:");
  if (unsafe) {
    return {
      name: "content-security-policy",
      modifier: v.includes("'unsafe-inline'") ? -20 : -10,
      reason: "csp-implemented-with-unsafe-directives",
    };
  }
  if (/default-src\s+'none'/.test(v)) {
    return {
      name: "content-security-policy",
      modifier: 10,
      reason: "csp-implemented-with-no-unsafe-default-src-none",
    };
  }
  return {
    name: "content-security-policy",
    modifier: 5,
    reason: "csp-implemented-with-no-unsafe",
  };
}

export function scoreCookies(h) {
  const setCookie = h["set-cookie"];
  if (!setCookie)
    return { name: "cookies", modifier: 0, reason: "cookies-not-found" };
  const v = setCookie.toLowerCase();
  if (!v.includes("secure"))
    return {
      name: "cookies",
      modifier: -20,
      reason: "cookies-without-secure-flag",
    };
  if (!v.includes("httponly"))
    return {
      name: "cookies",
      modifier: -30,
      reason: "cookies-session-without-httponly-flag",
    };
  if (!v.includes("samesite"))
    return {
      name: "cookies",
      modifier: 0,
      reason: "cookies-secure-with-httponly-sessions",
    };
  return {
    name: "cookies",
    modifier: 5,
    reason: "cookies-secure-with-httponly-sessions-and-samesite",
  };
}

export function scoreCors(foreignAcao) {
  if (!foreignAcao)
    return {
      name: "cross-origin-resource-sharing",
      modifier: 0,
      reason: "cross-origin-resource-sharing-not-implemented",
    };
  if (foreignAcao === "*")
    return {
      name: "cross-origin-resource-sharing",
      modifier: 0,
      reason: "cross-origin-resource-sharing-implemented-with-public-access",
    };
  // Reflecting an arbitrary origin is the -50 case, and it is the one that
  // matters most for a bearer-token API: with credentials allowed it turns any
  // page on the internet into an authenticated client.
  return {
    name: "cross-origin-resource-sharing",
    modifier: -50,
    reason: "cross-origin-resource-sharing-implemented-with-universal-access",
  };
}

export function scoreRedirection(result) {
  if (result === "same-host-https")
    return { name: "redirection", modifier: 0, reason: "redirection-to-https" };
  if (result === "off-host")
    return {
      name: "redirection",
      modifier: -5,
      reason: "redirection-off-host-from-http",
    };
  if (result === "not-https")
    return {
      name: "redirection",
      modifier: -20,
      reason: "redirection-not-to-https",
    };
  return { name: "redirection", modifier: -20, reason: "redirection-missing" };
}

export function scoreReferrerPolicy(h) {
  const rp = h["referrer-policy"];
  if (!rp)
    return {
      name: "referrer-policy",
      modifier: 0,
      reason: "referrer-policy-not-implemented",
    };
  const v = rp.toLowerCase().trim();
  const priv = [
    "no-referrer",
    "same-origin",
    "strict-origin",
    "strict-origin-when-cross-origin",
  ];
  if (priv.includes(v))
    return {
      name: "referrer-policy",
      modifier: 5,
      reason: "referrer-policy-private",
    };
  if (
    [
      "unsafe-url",
      "origin-when-cross-origin",
      "no-referrer-when-downgrade",
    ].includes(v)
  )
    return {
      name: "referrer-policy",
      modifier: -5,
      reason: "referrer-policy-unsafe",
    };
  return {
    name: "referrer-policy",
    modifier: 0,
    reason: "referrer-policy-not-implemented",
  };
}

export function scoreHsts(h) {
  const hsts = h["strict-transport-security"];
  if (!hsts)
    return {
      name: "strict-transport-security",
      modifier: -20,
      reason: "hsts-not-implemented",
    };
  const m = /max-age\s*=\s*"?(\d+)"?/i.exec(hsts);
  if (!m)
    return {
      name: "strict-transport-security",
      modifier: -20,
      reason: "hsts-header-invalid",
    };
  const maxAge = Number(m[1]);
  const sub = /includesubdomains/i.test(hsts);
  const preload = /preload/i.test(hsts);
  if (maxAge < SIX_MONTHS) {
    return {
      name: "strict-transport-security",
      modifier: -10,
      reason: `hsts-implemented-max-age-less-than-six-months (max-age=${maxAge}, needs >= ${SIX_MONTHS})`,
    };
  }
  if (preload && sub)
    return {
      name: "strict-transport-security",
      modifier: 5,
      reason: "hsts-preloaded",
    };
  return {
    name: "strict-transport-security",
    modifier: 0,
    reason: "hsts-implemented-max-age-at-least-six-months",
  };
}

export function scoreSri(h) {
  const ct = (h["content-type"] ?? "").toLowerCase();
  if (!ct.includes("text/html"))
    return {
      name: "subresource-integrity",
      modifier: 0,
      reason: "sri-not-implemented-response-not-html",
    };
  return {
    name: "subresource-integrity",
    modifier: 0,
    reason:
      "sri-not-implemented-but-no-scripts-loaded (not evaluated by this tool)",
  };
}

export function scoreXcto(h) {
  const v = (h["x-content-type-options"] ?? "").toLowerCase().trim();
  if (v === "nosniff")
    return {
      name: "x-content-type-options",
      modifier: 0,
      reason: "x-content-type-options-nosniff",
    };
  if (!v)
    return {
      name: "x-content-type-options",
      modifier: -5,
      reason: "x-content-type-options-not-implemented",
    };
  return {
    name: "x-content-type-options",
    modifier: -5,
    reason: "x-content-type-options-header-invalid",
  };
}

export function scoreXfo(h) {
  const csp = (h["content-security-policy"] ?? "").toLowerCase();
  if (
    /frame-ancestors\s+'none'/.test(csp) ||
    /frame-ancestors\s+'self'/.test(csp)
  )
    return {
      name: "x-frame-options",
      modifier: 5,
      reason: "x-frame-options-implemented-via-csp",
    };
  const v = (h["x-frame-options"] ?? "").toLowerCase().trim();
  if (v === "deny" || v === "sameorigin")
    return {
      name: "x-frame-options",
      modifier: 0,
      reason: "x-frame-options-sameorigin-or-deny",
    };
  return {
    name: "x-frame-options",
    modifier: -20,
    reason: "x-frame-options-not-implemented",
  };
}

export function scoreAll({ headers, foreignAcao, redirection }) {
  const tests = [
    scoreCsp(headers),
    scoreCookies(headers),
    scoreCors(foreignAcao),
    scoreRedirection(redirection),
    scoreReferrerPolicy(headers),
    scoreHsts(headers),
    scoreSri(headers),
    scoreXcto(headers),
    scoreXfo(headers),
  ];
  const score = tests.reduce((acc, t) => acc + t.modifier, 100);
  return { tests, score, grade: toGrade(score) };
}

// --- live probes -----------------------------------------------------------

async function probe(origin, path) {
  const url = new URL(path, origin).toString();
  const res = await fetch(url, { redirect: "manual" });
  return { url, status: res.status, headers: lower(res.headers) };
}

async function probeCors(origin, path) {
  const res = await fetch(new URL(path, origin).toString(), {
    headers: { Origin: "https://observatory-probe.invalid" },
    redirect: "manual",
  });
  return res.headers.get("access-control-allow-origin");
}

async function probeRedirection(origin) {
  const host = new URL(origin).host;
  try {
    const res = await fetch(`http://${host}/`, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc) return res.status < 400 ? "not-https" : "missing";
    const target = new URL(loc, `http://${host}/`);
    if (target.protocol !== "https:") return "not-https";
    return target.host === host ? "same-host-https" : "off-host";
  } catch {
    return "missing";
  }
}

async function official(host) {
  try {
    const res = await fetch(
      `https://observatory-api.mdn.mozilla.net/api/v2/scan?host=${encodeURIComponent(host)}`,
      { method: "POST" },
    );
    return await res.json();
  } catch (err) {
    return { error: "unreachable", message: String(err) };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const pathIdx = argv.indexOf("--path");
  const path = pathIdx === -1 ? "/" : argv[pathIdx + 1];
  const origin = argv.find((a) => !a.startsWith("--") && a !== path);
  if (!origin) {
    process.stderr.write(
      "Usage: node security/scripts/observatory-grade.mjs <origin> [--path /] [--json]\n",
    );
    process.exit(2);
  }

  const host = new URL(origin).host;
  const [live, foreignAcao, redirection, api] = await Promise.all([
    probe(origin, path),
    probeCors(origin, path),
    probeRedirection(origin),
    official(host),
  ]);

  const local = scoreAll({ headers: live.headers, foreignAcao, redirection });
  const out = { host, path, observedStatus: live.status, official: api, local };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(local.grade === "A+" ? 0 : 1);
  }

  process.stdout.write(`\nOfficial MDN Observatory (authoritative)\n`);
  if (api.grade) {
    process.stdout.write(
      `  grade ${api.grade}, score ${api.score}, ${api.tests_passed}/${api.tests_quantity} passed\n`,
    );
  } else {
    process.stdout.write(
      `  NO GRADE: ${api.error ?? "unknown"} - ${api.message ?? ""}\n` +
        `  Observatory fetches / and refuses a host whose root is not a success or\n` +
        `  redirect. This is a measurement blocker, NOT a passing grade and NOT a\n` +
        `  failing one. Gate 8's Observatory clause stays unmeasured until it is fixed.\n`,
    );
  }

  process.stdout.write(
    `\nLocal Observatory-equivalent score against ${live.url} (HTTP ${live.status})\n` +
      `  APPROXIMATION. Implements the documented modifiers; not the official scanner.\n`,
  );
  for (const t of local.tests) {
    const sign = t.modifier > 0 ? `+${t.modifier}` : String(t.modifier);
    process.stdout.write(
      `  ${sign.padStart(4)}  ${t.name.padEnd(30)} ${t.reason}\n`,
    );
  }
  process.stdout.write(
    `  ----  score ${local.score}, grade ${local.grade}\n\n`,
  );

  process.exit(local.grade === "A+" ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("observatory-grade.mjs")) {
  main().catch((err) => {
    process.stderr.write(`FAIL    ${err.stack ?? err}\n`);
    process.exit(2);
  });
}
