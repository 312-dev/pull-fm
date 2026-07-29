#!/usr/bin/env node
/**
 * Proves that the four background jobs are actually scheduled, on the cadence
 * their entrypoints say they need, and that a job which CANNOT RUN is treated
 * differently from one that ran.
 *
 *   node infra/scripts/check-job-schedule.mjs      (or: make jobs)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The four jobs were written, tested, and shipped as pnpm commands, and for a
 * while NOTHING INVOKED THEM. That is not a small gap: three of the four are
 * what make the retention windows in legal/privacy-policy.md true statements
 * rather than intentions, and the fourth is what keeps the request path from
 * spending a global 1 req/s provider budget on a page render.
 *
 * A schedule nobody verified is the same class of defect as a backup nobody
 * restored, and it fails the same way: silently, and only when it matters. So
 * every claim this repository makes about the schedule is asserted here.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PROVABLE WITHOUT INFRASTRUCTURE, AND WHAT IS NOT
 *
 * Nothing is deployed. What can be proved from a checkout:
 *
 *   - the unit files exist, are installed by bootstrap.sh, and are ENABLED
 *     there rather than merely copied (a timer that is installed and not
 *     enabled is the exact shape of this bug, one layer down)
 *   - each service carries the exit-code contract: SuccessExitStatus=2 so a
 *     "ran, with something to look at" is not an alert, and OnFailure so a
 *     "could not run, changed nothing" is
 *   - each command the timers invoke resolves to a real entrypoint
 *   - the calendar expressions expand to the instants intended, checked against
 *     systemd's own parser wherever systemd exists
 *   - no run can be started before the previous one is bounded to finish
 *
 * What CANNOT be proved here, and is not claimed anywhere: that any of it has
 * ever fired. It has not. There is no compute. See docs/RUNBOOK-JOBS.md.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UNIT_DIR = join(ROOT, "infra", "staging", "app", "systemd");
const BOOTSTRAP = join(ROOT, "infra", "staging", "app", "bootstrap.sh");
const RUNNER = join(ROOT, "infra", "staging", "app", "pullfm-job");
const RUNBOOK = join(ROOT, "docs", "RUNBOOK-JOBS.md");
const BFF_PKG = join(ROOT, "apps", "bff", "package.json");

/**
 * The authoritative table. Every number here is derived from the reasoning in
 * the entrypoint's own header, and the `why` field is what a reader gets when
 * this check fails.
 */
const JOBS = [
  {
    job: "warm-cache",
    unit: "pullfm-warm-cache",
    command: "warm:cache",
    script: "warm-cache",
    onCalendar: "*-*-* *:10/30:00",
    intervalSec: 30 * 60,
    runtimeMaxSec: 1320,
    persistent: false,
    why: "The warmer's own whole-run deadline is 20 minutes and the MusicBrainz budget is per IP and global, so two overlapping runs on one egress address would double the observed rate against a limit that does not care they are separate jobs.",
  },
  {
    job: "sweep-expired",
    unit: "pullfm-sweep-expired",
    command: "sweep:expired",
    script: "sweep-expired",
    onCalendar: "*-*-* *:05:00",
    intervalSec: 60 * 60,
    runtimeMaxSec: 600,
    persistent: true,
    why: "idempotency_keys.expires_at is 24 hours and the privacy policy says so. Daily would make the worst case 48 hours against a 24-hour promise; hourly makes it 25, which is the schema's number plus the hour of clock-skew slack.",
  },
  {
    job: "reap-unverified",
    unit: "pullfm-reap-unverified",
    command: "reap:unverified",
    script: "reap-unverified",
    onCalendar: "*-*-* *:35:00",
    intervalSec: 60 * 60,
    runtimeMaxSec: 900,
    persistent: true,
    why: "AUTH_UNVERIFIED_REAP_AFTER_S is 24 hours. Running daily would make the true upper bound on an unconsented record's life 48 hours, and the stated window would bound nothing.",
  },
  {
    job: "purge-audit",
    unit: "pullfm-purge-audit",
    command: "purge:audit",
    script: "purge-audit",
    onCalendar: "*-*-* 06:17:00 UTC",
    intervalSec: 24 * 60 * 60,
    runtimeMaxSec: 1800,
    persistent: true,
    why: "Every window this job enforces is measured in tens of days, so a day is the finest granularity that means anything. Weekly would falsify the published sentence 'normally within 24 hours'.",
  },
];

const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

/** Parses an ini-ish systemd unit into { SECTION: { Key: [values] } }. */
function parseUnit(text) {
  const out = {};
  let section = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      out[section] = out[section] ?? {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || section === null) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (out[section][key] ??= []).push(value);
  }
  return out;
}

function one(unit, section, key) {
  const values = unit[section]?.[key];
  return values && values.length === 1 ? values[0] : undefined;
}

// ---------------------------------------------------------------------------
// A deliberately narrow OnCalendar expander.
//
// It supports exactly the subset used above: `*-*-* H:M:S` with each time field
// either `*`, a two-digit number, or `n/step`, plus an optional UTC suffix.
// Anything else throws rather than being guessed at, because a calendar
// expression this cannot parse is one nobody should be relying on either.
//
// Its answers are cross-checked against `systemd-analyze calendar` below
// wherever systemd exists, which is what makes it evidence rather than a second
// opinion from the same author.
// ---------------------------------------------------------------------------
function parseField(spec, max) {
  if (spec === "*") return null; // matches everything
  const step = spec.split("/");
  if (step.length === 2) {
    const start = Number(step[0]);
    const by = Number(step[1]);
    if (!Number.isInteger(start) || !Number.isInteger(by) || by <= 0) {
      throw new Error(`unsupported stepped field: ${spec}`);
    }
    const values = [];
    for (let v = start; v <= max; v += by) values.push(v);
    return values;
  }
  const n = Number(spec);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(`unsupported field: ${spec}`);
  }
  return [n];
}

function expand(expression, fromUtcMs, days) {
  const parts = expression.split(/\s+/);
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`unsupported OnCalendar shape: ${expression}`);
  }
  const [date, time, zone] = parts;
  if (date !== "*-*-*") {
    throw new Error(`only *-*-* date specs are supported, got: ${date}`);
  }
  if (zone !== undefined && zone !== "UTC") {
    throw new Error(`only a UTC timezone suffix is supported, got: ${zone}`);
  }
  const [h, m, s] = time.split(":");
  const hours = parseField(h, 23);
  const minutes = parseField(m, 59);
  const seconds = parseField(s, 59);
  if (seconds === null || seconds.length !== 1 || seconds[0] !== 0) {
    throw new Error(`expected an explicit :00 seconds field, got: ${s}`);
  }

  const hits = [];
  const end = fromUtcMs + days * 86400_000;
  for (let t = fromUtcMs; t < end; t += 60_000) {
    const d = new Date(t);
    if (hours !== null && !hours.includes(d.getUTCHours())) continue;
    if (minutes !== null && !minutes.includes(d.getUTCMinutes())) continue;
    hits.push(t);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 1. The unit files say what the table says
// ---------------------------------------------------------------------------
for (const j of JOBS) {
  const servicePath = join(UNIT_DIR, `${j.unit}.service`);
  const timerPath = join(UNIT_DIR, `${j.unit}.timer`);

  if (!existsSync(servicePath) || !existsSync(timerPath)) {
    failures.push(
      `${j.unit}: missing a .service or .timer. The command exists and nothing runs it, which is the bug this check was written for.`,
    );
    continue;
  }

  const service = parseUnit(read(servicePath));
  const timer = parseUnit(read(timerPath));

  check(
    one(service, "Service", "Type") === "oneshot",
    `${j.unit}.service: Type must be oneshot. systemd will not start a second copy of a running oneshot, and that is one of the two things keeping runs from overlapping.`,
  );

  check(
    one(service, "Service", "ExecStart") ===
      `/usr/local/bin/pullfm-job ${j.job}`,
    `${j.unit}.service: ExecStart must be "/usr/local/bin/pullfm-job ${j.job}".`,
  );

  // The exit-code contract, which is the whole point of using a scheduler that
  // can tell 0, 1 and 2 apart.
  check(
    one(service, "Service", "SuccessExitStatus") === "2",
    `${j.unit}.service: SuccessExitStatus=2 is missing. Without it, exit 2 (ran, something to look at) alerts exactly like exit 1 (could not run, nothing changed), and an operator who is paged for both stops reading either.`,
  );
  check(
    one(service, "Service", "OnFailure") === "pullfm-job-alert@%n.service",
    `${j.unit}.service: OnFailure=pullfm-job-alert@%n.service is missing. Exit 1 would then be a silent failed unit, which is indistinguishable from a healthy job that had nothing to do.`,
  );

  check(
    one(service, "Unit", "ConditionPathExists") === "/etc/pullfm/deploy.env",
    `${j.unit}.service: ConditionPathExists=/etc/pullfm/deploy.env is missing. A node in its first minute has no image pinned, and every timer would fire an alert about it.`,
  );

  const runtimeMax = Number(one(service, "Service", "RuntimeMaxSec"));
  check(
    runtimeMax === j.runtimeMaxSec,
    `${j.unit}.service: RuntimeMaxSec should be ${j.runtimeMaxSec}, found ${one(service, "Service", "RuntimeMaxSec")}.`,
  );
  check(
    runtimeMax < j.intervalSec,
    `${j.unit}.service: RuntimeMaxSec (${runtimeMax}s) is not shorter than the firing interval (${j.intervalSec}s), so a wedged run can still be running when the next one is due. ${j.why}`,
  );

  check(
    one(timer, "Timer", "OnCalendar") === j.onCalendar,
    `${j.unit}.timer: OnCalendar should be "${j.onCalendar}", found "${one(timer, "Timer", "OnCalendar")}". ${j.why}`,
  );
  check(
    one(timer, "Timer", "AccuracySec") === "1s",
    `${j.unit}.timer: AccuracySec=1s is missing. systemd's default one-minute window lets it coalesce timers, which is exactly what puts two job containers on one 4 GB node at the same instant.`,
  );
  check(
    one(timer, "Timer", "Persistent") === String(j.persistent),
    `${j.unit}.timer: Persistent should be ${j.persistent}.`,
  );
  check(
    one(timer, "Install", "WantedBy") === "timers.target",
    `${j.unit}.timer: [Install] WantedBy=timers.target is missing, so "systemctl enable" would do nothing and the timer would never start at boot.`,
  );
}

// ---------------------------------------------------------------------------
// 2. bootstrap.sh installs AND enables every one of them
//
// Installed-but-not-enabled is the same failure as not-scheduled-at-all, and it
// looks like progress in a diff.
// ---------------------------------------------------------------------------
const bootstrap = read(BOOTSTRAP);
for (const j of JOBS) {
  check(
    bootstrap.includes(`systemctl enable --now ${j.unit}.timer`),
    `bootstrap.sh never runs "systemctl enable --now ${j.unit}.timer". The unit would be installed and dormant.`,
  );
  check(
    !bootstrap.includes(`systemctl enable --now ${j.unit}.service`),
    `bootstrap.sh enables ${j.unit}.service directly. Enabling the service rather than the timer runs the job once during bootstrap, before the first deploy has pinned an image.`,
  );
}
check(
  /install -m 0644 "systemd\/pullfm-\$\{job\}\.(service|timer)"/.test(
    bootstrap,
  ) || JOBS.every((j) => bootstrap.includes(`${j.unit}.service`)),
  "bootstrap.sh does not install the job unit files.",
);
check(
  bootstrap.includes("install -m 0755 pullfm-job /usr/local/bin/pullfm-job"),
  "bootstrap.sh does not install /usr/local/bin/pullfm-job, which every unit's ExecStart points at.",
);
check(
  bootstrap.includes(
    "install -m 0755 pullfm-job-alert /usr/local/bin/pullfm-job-alert",
  ),
  "bootstrap.sh does not install /usr/local/bin/pullfm-job-alert, so OnFailure would point at a missing binary and the failure would fail.",
);
check(
  bootstrap.includes("install -m 0644 systemd/pullfm-job-alert@.service"),
  "bootstrap.sh does not install the pullfm-job-alert@ template unit.",
);

// ---------------------------------------------------------------------------
// 3. Every job name the runner accepts resolves to something real
//
// This is the check that catches a renamed entrypoint. A timer pointing at a
// script that no longer exists fails as exit 1 forever, which is at least loud;
// a timer whose job name was quietly dropped from the runner's case statement
// fails as exit 1 too. Either way the retention window stops being enforced, so
// both ends are asserted against the package manifest.
// ---------------------------------------------------------------------------
const runner = read(RUNNER);
const pkg = JSON.parse(read(BFF_PKG));
for (const j of JOBS) {
  check(
    runner.includes(`${j.job}) ENTRYPOINT=dist/scripts/${j.script}.js ;;`),
    `pullfm-job does not map "${j.job}" to dist/scripts/${j.script}.js.`,
  );
  check(
    pkg.scripts?.[j.command] === `node dist/scripts/${j.script}.js`,
    `apps/bff/package.json: "${j.command}" should be "node dist/scripts/${j.script}.js", found "${pkg.scripts?.[j.command]}". The scheduled container and the documented pnpm command must run the same file.`,
  );
  check(
    existsSync(join(ROOT, "apps", "bff", "src", "scripts", `${j.script}.ts`)),
    `apps/bff/src/scripts/${j.script}.ts does not exist, so ${j.unit}.timer schedules nothing.`,
  );
}

// ---------------------------------------------------------------------------
// 4. The calendars expand to the instants intended
// ---------------------------------------------------------------------------
const FROM = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAYS = 8;
const firedMinutes = new Map();

for (const j of JOBS) {
  let hits;
  try {
    hits = expand(j.onCalendar, FROM, DAYS);
  } catch (err) {
    failures.push(`${j.unit}.timer: ${err.message}`);
    continue;
  }

  const expected = (DAYS * 86400) / j.intervalSec;
  check(
    hits.length === expected,
    `${j.unit}.timer: "${j.onCalendar}" fires ${hits.length} times in ${DAYS} days, expected ${expected} for a ${j.intervalSec}s cadence.`,
  );

  const gaps = new Set();
  for (let i = 1; i < hits.length; i += 1)
    gaps.add((hits[i] - hits[i - 1]) / 1000);
  check(
    gaps.size === 1 && gaps.has(j.intervalSec),
    `${j.unit}.timer: gaps between runs are ${[...gaps].join(", ")}s, expected a constant ${j.intervalSec}s. An uneven cadence means the shortest gap is the real bound, not the nominal one.`,
  );

  // Distinct minutes across every job. Three job containers starting in the
  // same second on a 4 GB node that is also running the BFF, nginx and two
  // Redis instances is a memory problem nobody would diagnose as a scheduling
  // one.
  for (const t of hits) {
    const minute = new Date(t).getUTCMinutes();
    const owner = firedMinutes.get(minute);
    check(
      owner === undefined || owner === j.unit,
      `${j.unit}.timer and ${owner} both fire at minute :${String(minute).padStart(2, "0")}. Give every job its own minute.`,
    );
    firedMinutes.set(minute, j.unit);
  }
}

// ---------------------------------------------------------------------------
// 5. Cross-check against systemd's own parser, where one exists
//
// The expander above and the table it is checked against were written by the
// same hand, so on its own it proves only self-consistency. systemd-analyze is
// the authority. It is absent on macOS and present on the Linux runners, so
// this is a hard assertion where it can be one and an explicit note where it
// cannot.
// ---------------------------------------------------------------------------
let systemdAvailable = true;
try {
  execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" });
} catch {
  systemdAvailable = false;
}

if (systemdAvailable) {
  for (const j of JOBS) {
    let output;
    try {
      output = execFileSync(
        "systemd-analyze",
        [
          "calendar",
          "--iterations=5",
          "--base-time=2026-01-01 00:00:00 UTC",
          j.onCalendar,
        ],
        { encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
      );
    } catch (err) {
      failures.push(
        `${j.unit}.timer: systemd-analyze rejected "${j.onCalendar}": ${String(err.stderr ?? err.message).trim()}`,
      );
      continue;
    }

    // `Next elapse:` for the first instant and `Iteration #N:` for the rest,
    // both as "Thu 2026-01-01 00:10:00 UTC". The UTC suffix is asserted rather
    // than assumed: TZ is forced above, and a match that lost it would silently
    // compare local instants against UTC ones.
    const iso = [
      ...output.matchAll(
        /(?:Next elapse|Iteration #\d+): +[A-Za-z]{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/g,
      ),
    ]
      .map((m) => Date.parse(`${m[1].replace(" ", "T")}Z`))
      .sort((a, b) => a - b);

    if (iso.length < 2) {
      failures.push(
        `${j.unit}.timer: could not read firing instants out of systemd-analyze. Output was:\n${output}`,
      );
      continue;
    }

    const mine = expand(j.onCalendar, FROM, DAYS).slice(0, iso.length);
    check(
      JSON.stringify(mine) === JSON.stringify(iso),
      `${j.unit}.timer: this repository's expansion of "${j.onCalendar}" disagrees with systemd's.\n    systemd: ${iso.map((t) => new Date(t).toISOString()).join(", ")}\n    here:    ${mine.map((t) => new Date(t).toISOString()).join(", ")}`,
    );
  }
  notes.push("calendar expressions cross-checked against systemd-analyze");
} else {
  notes.push(
    "systemd-analyze is not installed, so the calendar expansions were checked against this file's own parser only. Run this on Linux (CI does) for the authoritative comparison.",
  );
}

// ---------------------------------------------------------------------------
// 6. The runbook and the units agree
//
// One authoritative place for the schedule is only useful if it is the same
// schedule. A runbook that drifts is worse than no runbook: it is consulted.
// ---------------------------------------------------------------------------
if (!existsSync(RUNBOOK)) {
  failures.push(
    "docs/RUNBOOK-JOBS.md is missing. The schedule has no authoritative home.",
  );
} else {
  const runbook = read(RUNBOOK);
  for (const j of JOBS) {
    check(
      runbook.includes(j.onCalendar),
      `docs/RUNBOOK-JOBS.md does not quote "${j.onCalendar}" for ${j.unit}. The runbook and the unit have drifted.`,
    );
    check(
      runbook.includes(`${j.unit}.timer`),
      `docs/RUNBOOK-JOBS.md does not mention ${j.unit}.timer.`,
    );
    check(
      runbook.includes(j.command),
      `docs/RUNBOOK-JOBS.md does not mention the ${j.command} command.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log("scheduled background jobs\n");
const width = Math.max(...JOBS.map((j) => j.unit.length));
for (const j of JOBS) {
  console.log(
    `  ${j.unit.padEnd(width)}  ${j.onCalendar.padEnd(22)}  runs <= ${String(j.runtimeMaxSec).padStart(4)}s of ${j.intervalSec}s`,
  );
}
console.log();
for (const n of notes) console.log(`  note: ${n}`);
console.log();

if (failures.length > 0) {
  console.error(`FAILED (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  "PASS: every job is scheduled, enabled, bounded, and exit 1 reaches the alert path.",
);
console.log(
  "      NOT running: nothing is deployed. See docs/RUNBOOK-JOBS.md, 'What is actually running'.",
);
