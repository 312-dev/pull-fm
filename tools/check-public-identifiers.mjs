#!/usr/bin/env node
/**
 * Fails CI when a live infrastructure identifier appears in a tracked file.
 *
 *   node tools/check-public-identifiers.mjs        (or: make identifiers)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * This repository is PUBLIC. Over its short life it has published, in tracked
 * files, the staging origin IP, a tailnet address, a Neon project id, a Neon
 * endpoint hostname, a Cloudflare account id, password-manager item ids, and
 * the operator's personal email address. Every one of them was written by
 * someone documenting a real procedure accurately, which is exactly why a
 * review checklist does not catch them: the author was being helpful and the
 * reviewer was reading for correctness, not for disclosure.
 *
 * Some of those are in git history and cannot be unpublished. What this check
 * buys is the other half: they stop being RE-added, and the next class of
 * identifier never gets its first commit.
 *
 * ---------------------------------------------------------------------------
 * WHY IT CANNOT SILENTLY PASS OVER NOTHING
 *
 * This project has shipped four checks that reported green while measuring
 * nothing: a k6 threshold over a metric with no samples, a cache gate over an
 * `x-cache` header that is never emitted, a job-schedule guard written against
 * the broken form of the units, and ZAP fragment reconciliation that was wired
 * into no workflow at all. A scanner is the easiest possible member of that
 * family: narrow a regex by one character, or point the file walk at a
 * directory that no longer exists, and it passes forever.
 *
 * So this script refuses to report success unless it has proved, in the same
 * run, that it still works:
 *
 *   1. POSITIVE CONTROL. Every detector carries `mustMatch` samples. Before the
 *      corpus is read, each detector is run against its own samples. A detector
 *      that fails to fire on its own sample fails the build and says so. This
 *      is the defence against a regex that has been narrowed into uselessness.
 *
 *   2. NEGATIVE CONTROL. Every detector carries `mustNotMatch` samples, which
 *      are the near-misses that make the check tolerable to live with:
 *      documentation IPs, placeholder emails, private ranges. A detector that
 *      fires on those fails the build too, because a check everyone silences is
 *      a check nobody has.
 *
 *   3. CORPUS FLOOR. The scan asserts that it actually read a plausible number
 *      of files. If the file list collapses (a bad `git ls-files`, a
 *      pathological ignore rule, a rename of the repository root), the run
 *      fails with "scanned N files" rather than reporting a clean tree.
 *
 * Break any one of those three deliberately and this script goes red. That is
 * the property that distinguishes it from the four checks above.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 *
 * It is not a secret scanner. gitleaks owns credentials and runs beside it.
 * This finds the things that are not secret and are still a gift to an
 * attacker: where the infrastructure is, what it is called, and who runs it.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The ratchet.
 *
 * When this check was written the tree already contained findings, most of them
 * in `infra/` and `security/`, which belong to other work streams. Shipping the
 * check as an immediate hard failure would have meant either not shipping it or
 * editing someone else's files mid-flight, so the outstanding set is recorded
 * in this file and the check fails on anything NEW.
 *
 * Two properties keep that from becoming a permanent ignore list:
 *
 *   - A baseline entry that no longer matches anything FAILS the run. Fixing a
 *     finding is therefore a two-line change (fix it, drop the entry) and a
 *     baseline cannot quietly outlive the problem it records.
 *   - The count only goes down. `--update-baseline` refuses to add entries; it
 *     exists to prune ones that have been fixed.
 */
const BASELINE_PATH = join(ROOT, "tools", "public-identifiers-baseline.json");

/**
 * The minimum number of files a healthy run reads.
 *
 * Deliberately well under the real count so ordinary deletions do not trip it,
 * and far enough above zero that a broken file walk cannot pass. Raise it if
 * the repository grows a lot; never lower it to make a run go green.
 */
const MIN_FILES_SCANNED = 120;

/** Binary and generated files, which are noise rather than documentation. */
const SKIP_PATHS = [
  /^pnpm-lock\.yaml$/,
  /^k6-results\//,
  /^load\/results\//,
  /(^|\/)node_modules\//,
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|zip|gz|tgz)$/i,
  // This file is the one place every pattern is written out on purpose.
  /^tools\/check-public-identifiers\.mjs$/,
  // Holds hashes and file names only, never a value, so it has nothing to
  // find. Skipped so a hash that happens to look like one of these shapes does
  // not produce a finding nobody can act on.
  /^tools\/public-identifiers-baseline\.json$/,
];

/**
 * Literal strings that look like a finding and are not one.
 *
 * Every entry needs a reason. An entry without one is how an allowlist becomes
 * the place real findings go to be ignored, which is the failure mode
 * `docs/api/personal-api-tokens.md` warns about for the gitleaks path
 * allowlist. Keep this list short and specific: prefer a `mustNotMatch` sample
 * on the detector over an entry here, because that fixes the class rather than
 * the instance.
 */
const ALLOW = [
  {
    value: "ope@312.dev",
    why: "the published contact address in legal/ and SECURITY.md; it is meant to be public",
  },
  {
    value: "security@312.dev",
    why: "the published vulnerability-report address in SECURITY.md",
  },
  {
    value: "partners@last.fm",
    why: "Last.fm's own published partner contact, quoted from their terms in docs/UPSTREAM-TERMS.md. Not our infrastructure and not a person here.",
  },
  {
    value: "support@metabrainz.org",
    why: "MetaBrainz's own published support address, quoted from their terms in docs/compliance/",
  },
  {
    value: "api@songstats.com",
    why: "a vendor's published sales contact, quoted in a sourcing review",
  },
  {
    value: "security@better-auth.com",
    why: "a third-party project's published security contact, quoted in an auth landscape review",
  },
];

/**
 * Address ranges that are reserved for documentation, private use, or the
 * local host, and are therefore safe to write down.
 */
function isNonRoutableOrDocumentationIPv4(octets) {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // RFC 5737 documentation ranges.
  if (a === 192 && b === 0) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  // RFC 2544 benchmarking.
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

const EMAIL_ALLOWED_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "312.dev",
  "pull.fm",
  "localhost",
]);

/** Reserved top-level labels that cannot resolve, per RFC 2606 and RFC 6761. */
const EMAIL_ALLOWED_TLDS = new Set(["test", "invalid", "example", "localhost"]);

/**
 * The detectors.
 *
 * `mustMatch` and `mustNotMatch` are not documentation. They are executed on
 * every run, before the corpus, and a detector that gets either wrong fails the
 * build. Adding a detector without samples is refused.
 */
const DETECTORS = [
  {
    id: "tailnet-ipv4",
    why: "A Tailscale CGNAT address names the admin path to a node. Publishing one turns 'find the node' into 'join the tailnet'.",
    pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    mustMatch: ["100.121.161.79", "ssh user@100.64.0.1"],
    mustNotMatch: ["100.1.2.3", "100.128.0.1", "10.0.0.1", "1.100.64.1"],
  },
  {
    id: "public-ipv4",
    why: "A routable address is the one fact a Cloudflare-range origin firewall depends on staying unpublished.",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    accept(match, line, index) {
      const octets = match.split(".").map(Number);
      if (octets.some((n) => n > 255)) return false;
      if (isNonRoutableOrDocumentationIPv4(octets)) return false;
      // A four-part dotted number is also how software versions are written.
      // Separating the two needs the surrounding words, not the digits.
      if (
        /\b(?:version|semver|release|tag|image|digest|v)\s*$/i.test(
          line.slice(0, index),
        )
      )
        return false;
      if (/\b(?:version|semver|changelog)\b/i.test(line)) return false;
      return true;
    },
    mustMatch: ["104.58.94.69", "the origin is at 5.75.129.4 today"],
    mustNotMatch: [
      "127.0.0.1",
      "10.20.1.21",
      "192.168.1.1",
      "172.16.0.9",
      "203.0.113.7",
      "198.51.100.4",
      "192.0.2.1",
      "0.0.0.0",
      "255.255.255.256",
      "version 1.2.3.4 of the tool",
    ],
  },
  {
    id: "neon-endpoint-id",
    why: "The database endpoint hostname is reachable from the public internet and the credential is the only network control on the current plan, so the hostname is a genuine discovery aid.",
    pattern: /\bep-[a-z]+-[a-z]+-[a-z0-9]{8,}\b/g,
    mustMatch: [
      "ep-red-wave-as1i96ei",
      "host ep-super-wind-asbuczm7-pooler.example",
    ],
    mustNotMatch: ["ep-red-wave", "step-frost-1234", "endpoint-name-here"],
  },
  {
    id: "neon-branch-id",
    why: "A branch id addresses a restorable copy of production data through the provider control plane.",
    pattern: /\bbr-[a-z]+-[a-z]+-[a-z0-9]{8,}\b/g,
    mustMatch: ["br-calm-morning-asjr2h1v", "br-curly-wave-as91izv6"],
    mustNotMatch: ["br-main", "branch-name", "br-calm-morning"],
  },
  {
    id: "cloudflare-resource-id",
    why: "Cloudflare account, zone and tunnel ids are 32 hex characters. With the operator's email address they are most of an account-recovery social-engineering attempt.",
    pattern: /\b[0-9a-f]{32}\b/g,
    accept(_match, line) {
      // A 32-hex string is equally an MD5 of drill data. Only the surrounding
      // words separate a resource id from a content digest, so this detector
      // asks for the word rather than guessing from shape and producing
      // findings that get silenced wholesale.
      return /\b(?:account|zone|tunnel|cloudflare|cf[_-])/i.test(line);
    },
    mustMatch: [
      "alerts are armed on account d463203cc84c2ef8ebd1b8f656ee66db",
      "CF_ZONE=70f6a577591a0cf4813b0e1456699a28",
    ],
    mustNotMatch: [
      "marker fingerprint BEFORE = 3e4c0173f515c895ae8792f0aa9b0104",
      "account d463203cc84c2ef8ebd1b8f656ee66d",
      "the zone id is D463203CC84C2EF8EBD1B8F656EE66DB",
    ],
  },
  {
    id: "password-manager-item-id",
    why: "A vault item id is a direct object reference to a specific credential. It turns any vault access from a search problem into a fetch.",
    pattern: /\b[a-z2-7]{26}\b/g,
    accept(match) {
      // Base32 ids mix digits through the string. A 26-letter English word does
      // not, and `supercalifragilisticexpial` is otherwise a perfect match.
      return (match.match(/[2-7]/g) ?? []).length >= 2;
    },
    mustMatch: ["krqfwafozazi7xq6ftq4s35rba", "qr6sfpfzskhpqtzbehw7kdheti"],
    mustNotMatch: [
      "krqfwafozazi7xq6ftq4s35rb",
      "abcdefghijklmnopqrstuvwxyz1",
      "supercalifragilisticexpial",
    ],
  },
  {
    id: "operator-email",
    why: "A named human with an inbox is the target of every account-recovery and phishing path around the technical controls.",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept(match) {
      const domain = match.split("@")[1].toLowerCase().replace(/\.$/, "");
      if (EMAIL_ALLOWED_DOMAINS.has(domain)) return false;
      const tld = domain.split(".").pop();
      return !EMAIL_ALLOWED_TLDS.has(tld);
    },
    mustMatch: ["gray@grayada.ms", "someone@gmail.com"],
    mustNotMatch: [
      "you@example.com",
      "ope@312.dev",
      "no-reply@pull.fm",
      "leak@example.test",
      "drill-erase-c@pull.fm.invalid",
    ],
  },
];

// ---------------------------------------------------------------------------
// Control 1 and 2: prove every detector still works, before reading anything.

/**
 * `accept` receives the match, the whole line, and the match offset, because
 * some of these classes are only separable from their near-misses by context:
 * `1.2.3.4` is an address or a version number depending on what surrounds it.
 */
function runDetector(detector, text) {
  const hits = [];
  detector.pattern.lastIndex = 0;
  for (const m of text.matchAll(detector.pattern)) {
    if (detector.accept && !detector.accept(m[0], text, m.index ?? 0)) continue;
    hits.push(m[0]);
  }
  return hits;
}

function selfTest() {
  const failures = [];
  for (const d of DETECTORS) {
    if (!d.mustMatch?.length || !d.mustNotMatch?.length) {
      failures.push(
        `${d.id}: a detector without both mustMatch and mustNotMatch samples cannot be shown to work`,
      );
      continue;
    }
    for (const sample of d.mustMatch) {
      if (runDetector(d, sample).length === 0) {
        failures.push(
          `${d.id}: FAILED TO DETECT its own sample ${JSON.stringify(sample)}. ` +
            `The detector has been narrowed into uselessness and this check is now passing over nothing.`,
        );
      }
    }
    for (const sample of d.mustNotMatch) {
      const hits = runDetector(d, sample);
      if (hits.length > 0) {
        failures.push(
          `${d.id}: fired on ${JSON.stringify(sample)} (matched ${JSON.stringify(hits)}), ` +
            `which is a false positive the check must not produce.`,
        );
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Control 3: read the corpus, and prove there was one.

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((p) => !SKIP_PATHS.some((re) => re.test(p)));
}

function isProbablyText(path) {
  try {
    if (statSync(path).size > 4 * 1024 * 1024) return false;
  } catch {
    return false;
  }
  return true;
}

const allowValues = new Set(ALLOW.map((a) => a.value));

function main() {
  const selfTestFailures = selfTest();
  if (selfTestFailures.length > 0) {
    console.error("FAIL  the identifier scanner is broken:\n");
    for (const f of selfTestFailures) console.error(`  - ${f}`);
    console.error(
      "\nFix the detector. Do NOT delete the sample to make this pass: the sample\n" +
        "is the only thing proving the scanner still detects anything at all.",
    );
    process.exit(1);
  }

  const files = trackedFiles();
  const findings = [];
  let scanned = 0;

  for (const rel of files) {
    const abs = join(ROOT, rel);
    if (!isProbablyText(abs)) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    const lines = text.split("\n");
    for (const d of DETECTORS) {
      lines.forEach((line, i) => {
        for (const hit of runDetector(d, line)) {
          if (allowValues.has(hit)) continue;
          findings.push({ file: rel, line: i + 1, detector: d, hit });
        }
      });
    }
  }

  if (scanned < MIN_FILES_SCANNED) {
    console.error(
      `FAIL  scanned only ${scanned} file(s), which is below the floor of ${MIN_FILES_SCANNED}.\n\n` +
        "That is not a clean tree, it is a broken scan: the file walk found almost\n" +
        "nothing, so a green result here would mean nothing. Check `git ls-files`\n" +
        "and SKIP_PATHS before touching the floor.",
    );
    process.exit(1);
  }

  // Keyed without the line number, so moving a known finding down a file is not
  // reported as a new one and reformatting does not turn the check red.
  //
  // The key is HASHED, and that is not decoration. The first version of this
  // baseline stored `detector|file|value` in the clear, which meant a tracked
  // file in a public repository listing every identifier the check exists to
  // keep out of tracked files in a public repository. The check found it, on
  // itself, on the run after it was committed. A hash records the same fact
  // ("this file still has a finding of this class") and discloses nothing.
  //
  // Grouped with dashes, and truncated to 64 bits, because a bare 32-character
  // hex string is exactly what gitleaks' generic high-entropy rule is looking
  // for. Left unformatted, every entry in this file is a gitleaks finding, and
  // the fix somebody reaches for is a path allowlist over `tools/`, which is
  // how a real leak eventually gets ignored. 64 bits over a few dozen entries
  // has no collision to worry about.
  const keyOf = (f) =>
    (
      createHash("sha256")
        .update(`${f.detector.id}|${f.file}|${f.hit}`)
        .digest("hex")
        .slice(0, 16)
        .match(/.{4}/g) ?? []
    ).join("-");

  let baselineDoc = { known: [] };
  try {
    baselineDoc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    baselineDoc = { known: [] };
  }
  const baseline = baselineDoc.known ?? [];
  const baselineKeys = new Set(baseline.map((b) => b.fingerprint));
  const seenKeys = new Set(findings.map(keyOf));

  if (process.argv.includes("--update-baseline")) {
    const kept = baseline.filter((b) => seenKeys.has(b.fingerprint));
    const removed = baseline.length - kept.length;
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ ...baselineDoc, known: kept }, null, 2)}\n`,
    );
    console.log(
      `pruned ${removed} fixed finding(s); ${kept.length} still outstanding. ` +
        "New findings are never added automatically: fix them.",
    );
    return;
  }

  const stale = baseline.filter((b) => !seenKeys.has(b.fingerprint));
  const fresh = findings.filter((f) => !baselineKeys.has(keyOf(f)));

  if (fresh.length > 0) {
    console.error(
      `FAIL  ${fresh.length} NEW live infrastructure identifier(s) in tracked files.\n` +
        "This repository is public. Each of these is something an attacker would\n" +
        "otherwise have to discover.\n",
    );
    const byDetector = new Map();
    for (const f of fresh) {
      if (!byDetector.has(f.detector.id)) byDetector.set(f.detector.id, []);
      byDetector.get(f.detector.id).push(f);
    }
    for (const [id, group] of byDetector) {
      console.error(`  ${id}: ${group[0].detector.why}`);
      for (const f of group) {
        console.error(`    ${f.file}:${f.line}  ${f.hit}`);
      }
      console.error("");
    }
    console.error(
      "Replace the value with a placeholder and read the real one from\n" +
        "`terraform output`, the provider API, or the operator vault at the point\n" +
        "of use. If a value genuinely belongs in the open, add it to ALLOW in\n" +
        "tools/check-public-identifiers.mjs WITH A REASON. Adding it to the\n" +
        "baseline is not an option: the baseline only shrinks.",
    );
    process.exit(1);
  }

  if (stale.length > 0) {
    console.error(
      `FAIL  ${stale.length} baseline entr(ies) no longer match anything:\n`,
    );
    for (const s of stale) console.error(`    ${s.fingerprint}`);
    console.error(
      "\nThat is good news badly recorded. The finding is fixed, so remove the\n" +
        "entry: `node tools/check-public-identifiers.mjs --update-baseline`.\n" +
        "A baseline that outlives its finding is a standing exemption nobody reads.",
    );
    process.exit(1);
  }

  console.log(
    `PASS  ${DETECTORS.length} detectors self-tested, ${scanned} tracked files scanned, ` +
      `0 new findings, ${baseline.length} known and outstanding.`,
  );
}

main();
