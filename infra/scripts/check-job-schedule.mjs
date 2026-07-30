#!/usr/bin/env node
/**
 * Proves what a CHECKOUT can prove about every scheduled unit in this
 * repository, and says out loud what it cannot.
 *
 *   node infra/scripts/check-job-schedule.mjs      (or: make jobs)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT WAS REWRITTEN
 *
 * The four application jobs were written, tested, and shipped as pnpm commands,
 * and for a while NOTHING INVOKED THEM. That is what this check was written for.
 *
 * IT THEN BECAME AN INSTANCE OF THE SAME DEFECT. `UNIT_DIR` and a hand-written
 * `JOBS` table pinned it to `infra/staging/app/systemd/` and to four unit names,
 * so the four `infra/backup/` units, the `infra/mb-loader/` pair and the two
 * `infra/observability/` units were never looked at. It printed
 * "PASS: every job is scheduled" while asserting over 4 of the 13 timers in the
 * tree. A check that covers a third of its subject and reports success is the
 * defect it exists to catch, one level up.
 *
 * PULLFM-RISK-012 is the proof that this matters: a backup timer fully written,
 * committed, and installed nowhere. It was found by enumerating timers on the
 * machine, not by reading the repository, and a hardcoded list could never have
 * found it because the unit was not on the list.
 *
 * So this file DISCOVERS. Every `*.timer` under any directory named `systemd`
 * anywhere in `infra/` is in scope, and a newly added timer is covered the
 * moment it is committed, with no edit here.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REPOSITORY CAN ANSWER, AND WHAT ONLY A NODE CAN
 *
 * This distinction is the whole design, because collapsing it is how the old
 * version came to claim things it had not checked.
 *
 * PROVABLE HERE, and asserted below:
 *
 *   - a `.timer` has a `.service` beside it, and the timer is installable
 *     (`[Install] WantedBy=timers.target`) rather than inert
 *   - the timer declares a trigger at all
 *   - every `OnCalendar=` is VALID, according to systemd's own parser, and
 *     actually yields future instants
 *   - the start-time bound is shorter than the gap between firings, so a wedged
 *     run is killed before the next one is due
 *   - the failure path is wired: `OnFailure=` in `[Unit]` where systemd reads it
 *     and not in `[Service]` where it is silently ignored
 *   - a unit that needs an environment file skips rather than fails when the
 *     file is absent
 *   - SOME INSTALLER IN THIS REPOSITORY ENABLES THE TIMER. This is the
 *     RISK-012 assertion and it is the one worth having: a unit no installer
 *     enables is a control that exists only in git.
 *
 * NOT PROVABLE HERE, and therefore NOT CLAIMED ANYWHERE IN THE OUTPUT:
 *
 *   - whether any unit is enabled on any machine right now
 *   - whether any timer has a NEXT, or has ever fired, or what it exited
 *   - whether the node a bootstrap ran on still matches the bootstrap
 *
 * A repository cannot tell an installed timer from an uninstalled one. It can
 * only tell whether the repository ASKS for it to be installed. Those are
 * different claims and the report keeps them apart: `make jobs` being green
 * means "the schedule this repository describes is coherent and asks to be
 * installed", never "the schedule is running". The second question is answered
 * by `systemctl list-timers` on the node and by nothing else.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INFRA = join(ROOT, "infra");
const RUNBOOK = join(ROOT, "docs", "RUNBOOK-JOBS.md");
const BFF_PKG = join(ROOT, "apps", "bff", "package.json");
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

// The base instant every calendar expansion is measured from, so two runs of
// this check on different days compare the same numbers.
const BASE = "2026-01-01 00:00:00 UTC";
const ITERATIONS = 8;

// systemd's own default when a unit sets no TimeoutStartSec=. A unit without
// one is BOUNDED BY THIS, not unbounded, and reporting it as unbounded would be
// a false alarm.
const DEFAULT_TIMEOUT_START_SEC = 90;

// ---------------------------------------------------------------------------
// TIMERS THIS REPOSITORY DELIBERATELY DOES NOT SCHEDULE.
//
// A timer that no installer enables is a FAILURE unless it is written down
// here with a reason. That is the RISK-012 gate: the failure mode being
// prevented is a unit committed with every directive correct that nothing ever
// installs, which reads as done in a diff and in a file listing.
//
// This list may only SHRINK. An entry for a unit that some installer now
// enables is stale and fails, on the same principle as
// tools/public-identifiers-baseline.json: an exemption that outlived its reason
// is a standing exemption nobody reads.
//
// `open: true` means the gap is NOT a decision. It is reported under its own
// heading, loudly, and it is somebody's outstanding work rather than a settled
// trade-off.
// ---------------------------------------------------------------------------
const NOT_SCHEDULED = [
  {
    unit: "pullfm-backup-retention",
    why: "Cannot work with the node's credential, measured rather than assumed: on 2026-07-29 it reported four MISSING lifecycle rules where the real answer was AccessDenied on GetBucketLifecycleConfiguration. Lifecycle is a bucket-ADMIN operation and the node holds a bucket-scoped OBJECT token, which is the point of PULLFM-RISK-013. Widening the token to satisfy a weekly check would undo the fix that risk records. Reasoning in infra/staging/app/bootstrap.sh and docs/RUNBOOK-DR.md section 6.",
  },
  {
    unit: "pullfm-restore-drill",
    why: "DESTROYS DATA on the staging branch and needs a Neon API key that can delete branches. Monthly drilling is a Gate 4 obligation, but arming it on a node that has never run it once unattended is how a drill becomes an incident. It stays an operator-run script.",
  },
  {
    unit: "pullfm-deletion-ledger",
    why: "Superseded for its original purpose: apps/bff writes the ledger object inline with the deletion cascade and refuses the delete if that write fails, so erasure durability is synchronous with the request. What is left is a reconciler, and running it here would put a SECOND R2 credential on the node to backfill rows that no longer accumulate.",
  },
  {
    unit: "pullfm-heartbeat",
    open: true,
    why: "NO REASON IS RECORDED ANYWHERE IN THIS REPOSITORY, and this is the inverse of PULLFM-RISK-012 rather than an instance of it. Enumerated on the staging node on 2026-07-30, pullfm-heartbeat.timer is ENABLED and firing every five minutes, and nothing under infra/ installs or enables it, so it was armed by hand. The consequence is the one that matters: a node rebuild drops the dead man's switch silently, and the thing that would have told somebody is the thing that went away. Owned by the alerting-decoupling work (PULLFM-RISK-014). This entry is not an exemption, it is an open finding parked where the check can see it.",
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Every directory named `systemd` anywhere under infra/. */
function unitDirs(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.name === "systemd") found.push(abs);
    else unitDirs(abs, found);
  }
  return found;
}

/**
 * Every file under infra/ that ENABLES a systemd unit.
 *
 * TWO EXCLUSIONS, AND BOTH ARE FALSE POSITIVES THIS CHECK ALREADY PRODUCED.
 *
 * Markdown is skipped. `infra/observability/README.md` documents
 * `systemctl enable --now pullfm-heartbeat.timer` in a fenced block, and the
 * first version of this walk counted that as coverage - which turned the one
 * genuine RISK-012-shaped finding in the tree into a green line. A document
 * describing an install is the opposite of an install: it is the thing that
 * exists when nothing automated does.
 *
 * Comment lines are stripped, because a shell script that explains why it does
 * NOT enable a unit would otherwise read as enabling it.
 *
 * THIS FILE IS SKIPPED TOO, and that was a third false positive rather than a
 * theoretical one: the failure message below quotes
 * `systemctl enable --now <unit>.timer` so an operator can paste it, and the
 * walk read its own error string as an installation. A checker that counts
 * itself as coverage is the purest form of the bug this file exists to catch.
 */
const SELF_ABS = fileURLToPath(import.meta.url);
function installerScripts(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      installerScripts(abs, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (abs === SELF_ABS) continue;
    if (/\.(md|markdown|txt)$/i.test(entry.name)) continue;
    if (statSync(abs).size > 2 * 1024 * 1024) continue;
    let raw;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const text = raw
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    if (/systemctl\s+enable/.test(text)) found.push({ path: abs, text });
  }
  return found;
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

function all(unit, section, key) {
  return unit[section]?.[key] ?? [];
}

/**
 * systemd time spans: a bare number is SECONDS, otherwise a sum of suffixed
 * parts. Returns undefined for anything unrecognised rather than guessing,
 * because a bound this cannot read is a bound nobody should trust either.
 */
function parseTimeSpan(spec) {
  if (spec === undefined) return undefined;
  const t = String(spec).trim();
  if (/^\d+$/.test(t)) return Number(t);
  const units = {
    ms: 1e-3,
    s: 1,
    sec: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hour: 3600,
    hours: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
    w: 604800,
    week: 604800,
    weeks: 604800,
  };
  let total = 0;
  let matched = false;
  const re = /(\d+)\s*([a-z]+)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const mult = units[m[2]];
    if (mult === undefined) return undefined;
    total += Number(m[1]) * mult;
    matched = true;
  }
  return matched ? total : undefined;
}

// ---------------------------------------------------------------------------
// systemd-analyze is the authority on a calendar expression.
//
// The previous version of this file carried a hand-written OnCalendar expander
// that supported exactly the four shapes the four hardcoded jobs used, and
// threw on anything else. Discovery immediately produces four shapes it could
// not parse (`Mon *-*-* 07:11:00 UTC`, `*:0/10`, `*-*-01 04:47:00 UTC`, and the
// shorthand `daily`), so a bespoke parser would now be the thing deciding which
// timers get checked - which is the hardcoding this rewrite removes, wearing a
// different hat.
//
// systemd's own parser has no such limit and is the thing that will actually run
// these expressions. Where it is absent (macOS) nothing is asserted about
// calendars and the report SAYS SO rather than passing quietly.
// ---------------------------------------------------------------------------
let systemdAvailable = true;
try {
  execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" });
} catch {
  systemdAvailable = false;
}

/** Future firing instants for an OnCalendar expression, in ms, ascending. */
function elapses(expression) {
  const output = execFileSync(
    "systemd-analyze",
    [
      "calendar",
      `--iterations=${ITERATIONS}`,
      `--base-time=${BASE}`,
      expression,
    ],
    { encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
  );
  return [
    ...output.matchAll(
      /(?:Next elapse|Iteration #\d+): +[A-Za-z]{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/g,
    ),
  ]
    .map((m) => Date.parse(`${m[1].replace(" ", "T")}Z`))
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Build the unit table by discovery
// ---------------------------------------------------------------------------
const dirs = unitDirs(INFRA).sort();
if (dirs.length === 0) {
  console.error(
    "FAIL  found no systemd unit directories under infra/.\n\n" +
      "That is not a clean tree, it is a broken scan: this repository has\n" +
      "several. A green result from a walk that found nothing would mean nothing.",
  );
  process.exit(1);
}

const units = [];
for (const dir of dirs) {
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".timer")) continue;
    const name = basename(file, ".timer");
    const timerPath = join(dir, file);
    const servicePath = join(dir, `${name}.service`);
    units.push({
      name,
      dir: relative(ROOT, dir),
      timerPath,
      servicePath,
      hasService: existsSync(servicePath),
      timer: parseUnit(read(timerPath)),
      service: existsSync(servicePath) ? parseUnit(read(servicePath)) : null,
    });
  }
}

if (units.length === 0) {
  console.error(
    "FAIL  discovered no .timer units at all under infra/**/systemd/.\n\n" +
      "This repository has several, so an empty discovery is a broken walk and\n" +
      "not a clean tree.",
  );
  process.exit(1);
}

// Which timers does this repository ask to have enabled, and from where.
const installers = installerScripts(INFRA);
const enabledBy = new Map();
for (const { path, text } of installers) {
  for (const m of text.matchAll(
    /systemctl\s+enable\s+[^\n]*?([\w@.-]+)\.timer/g,
  )) {
    const list = enabledBy.get(m[1]) ?? [];
    const rel = relative(ROOT, path);
    if (!list.includes(rel)) list.push(rel);
    enabledBy.set(m[1], list);
  }
}
// Enabling the SERVICE rather than the timer runs the job once at bootstrap,
// before the first deploy has pinned an image. Tracked separately so it is
// reported as the mistake it is rather than counted as coverage.
const serviceEnabled = new Set();
for (const { text } of installers) {
  for (const m of text.matchAll(
    /systemctl\s+enable\s+[^\n]*?([\w@.-]+)\.service/g,
  )) {
    serviceEnabled.add(m[1]);
  }
}

// ---------------------------------------------------------------------------
// 1. Structure. Every discovered timer, no exceptions.
// ---------------------------------------------------------------------------
for (const u of units) {
  check(
    u.hasService,
    `${u.dir}/${u.name}.timer has no ${u.name}.service beside it. A timer that activates a unit which does not exist fails on every firing.`,
  );
  if (!u.hasService) continue;

  check(
    one(u.timer, "Install", "WantedBy") === "timers.target",
    `${u.dir}/${u.name}.timer: [Install] WantedBy=timers.target is missing, so "systemctl enable" would do nothing and the timer would never start at boot.`,
  );

  const onCalendar = all(u.timer, "Timer", "OnCalendar");
  const onBoot = one(u.timer, "Timer", "OnBootSec");
  const onActive = one(u.timer, "Timer", "OnUnitActiveSec");
  check(
    onCalendar.length > 0 || onBoot !== undefined || onActive !== undefined,
    `${u.dir}/${u.name}.timer declares no trigger at all: no OnCalendar=, no OnBootSec=, no OnUnitActiveSec=. It is installable and will never fire.`,
  );

  // AccuracySec= or RandomizedDelaySec=. systemd's default accuracy is one
  // MINUTE, and it coalesces timers inside that window, which is what puts two
  // job containers on one small node at the same instant. Either directive makes
  // the firing spread a decision instead of a default.
  check(
    one(u.timer, "Timer", "AccuracySec") !== undefined ||
      one(u.timer, "Timer", "RandomizedDelaySec") !== undefined,
    `${u.dir}/${u.name}.timer sets neither AccuracySec= nor RandomizedDelaySec=. systemd's default one-minute accuracy window lets it coalesce this timer with others, so the firing spread is whatever the manager decides.`,
  );

  check(
    one(u.service, "Service", "Type") !== undefined,
    `${u.dir}/${u.name}.service sets no Type=.`,
  );
  check(
    all(u.service, "Service", "ExecStart").length > 0,
    `${u.dir}/${u.name}.service has no ExecStart=.`,
  );

  // RuntimeMaxSec= applies to a service that has REACHED the running state. A
  // Type=oneshot never does, so systemd discards it with "RuntimeMaxSec= has no
  // effect in combination with Type=oneshot. Ignoring." on every reload. The
  // window a oneshot spends in "activating" is bounded by TimeoutStartSec=.
  if (one(u.service, "Service", "Type") === "oneshot") {
    check(
      one(u.service, "Service", "RuntimeMaxSec") === undefined,
      `${u.dir}/${u.name}.service: RuntimeMaxSec= is set on a Type=oneshot unit, where systemd ignores it. The bound that works is TimeoutStartSec=.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. The failure path, where the unit has one.
//
// Asserted BY SECTION rather than by presence, because that is the assertion
// that catches the real bug: OnFailure= is a [Unit] directive, and in [Service]
// systemd parses it, logs "Unknown key name 'OnFailure' in section 'Service',
// ignoring", and wires nothing. This check asserted the broken placement until
// 2026-07-29, so it passed for exactly as long as the units were wrong.
// ---------------------------------------------------------------------------
for (const u of units) {
  if (!u.hasService) continue;

  check(
    one(u.service, "Service", "OnFailure") === undefined,
    `${u.dir}/${u.name}.service: OnFailure= is in [Service], where systemd ignores it with a log line and wires nothing. Move it to [Unit].`,
  );

  const onFailure = one(u.service, "Unit", "OnFailure");
  if (onFailure !== undefined) {
    // The handler must exist in this repository, or the failure fails.
    const template = `${onFailure.replace(/@.*$/, "@")}.service`.replace(
      /\.service\.service$/,
      ".service",
    );
    const found = dirs.some((d) => existsSync(join(d, template)));
    check(
      found,
      `${u.dir}/${u.name}.service: OnFailure=${onFailure} names a unit (${template}) that exists nowhere under infra/**/systemd/. The failure handler would itself fail to start, so a failed run would be silent.`,
    );
  }

  // Units that spawn a job container through the runner carry an exit-code
  // contract, and that contract is the reason for using a scheduler which can
  // tell 0, 1 and 2 apart. Derived from ExecStart rather than from a list, so a
  // new job added to the runner inherits the assertion.
  const exec = all(u.service, "Service", "ExecStart").join(" ");
  if (/\/usr\/local\/bin\/pullfm-job\s+\S/.test(exec)) {
    check(
      one(u.service, "Service", "SuccessExitStatus") === "2",
      `${u.dir}/${u.name}.service: SuccessExitStatus=2 is missing. Without it, exit 2 (ran, something to look at) alerts exactly like exit 1 (could not run, nothing changed), and an operator paged for both stops reading either.`,
    );
    check(
      one(u.service, "Unit", "OnFailure") !== undefined,
      `${u.dir}/${u.name}.service: no OnFailure= in [Unit]. Exit 1 would be a silent failed unit, indistinguishable from a healthy job that had nothing to do.`,
    );
  }

  // A REQUIRED EnvironmentFile= without a matching ConditionPathExists= is a
  // unit that FAILS on an unconfigured node instead of skipping, so every timer
  // on a fresh node fires an alert about the node being fresh. The `-` prefix
  // marks the file optional, so those are exempt by their own declaration rather
  // than by an exception here.
  for (const envFile of all(u.service, "Service", "EnvironmentFile")) {
    if (envFile.startsWith("-")) continue;
    check(
      all(u.service, "Unit", "ConditionPathExists").includes(envFile),
      `${u.dir}/${u.name}.service: EnvironmentFile=${envFile} is required but no ConditionPathExists=${envFile} guards it. On a node where that file is absent the unit FAILS rather than skipping, and every firing becomes an alert about an unconfigured node.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. The schedules are valid and the bounds are shorter than the gaps.
//
// THE BOUND CHECK APPLIES TO CALENDAR TIMERS ONLY, and that is systemd
// semantics rather than laziness. OnUnitActiveSec= rearms from the moment the
// unit goes INACTIVE, so a monotonic timer cannot overlap its own run however
// long that run takes; OnCalendar= fires on wall-clock instants and can.
// Asserting a bound against OnUnitActiveSec= would fail pullfm-deploy for a race
// it is structurally incapable of having.
// ---------------------------------------------------------------------------
for (const u of units) {
  if (!u.hasService) continue;

  const expressions = all(u.timer, "Timer", "OnCalendar");
  const timeoutRaw = one(u.service, "Service", "TimeoutStartSec");
  u.timeoutSec = parseTimeSpan(timeoutRaw) ?? DEFAULT_TIMEOUT_START_SEC;
  u.timeoutIsDefault = timeoutRaw === undefined;

  if (timeoutRaw !== undefined && parseTimeSpan(timeoutRaw) === undefined) {
    failures.push(
      `${u.dir}/${u.name}.service: TimeoutStartSec=${timeoutRaw} is not a time span this check can read, so the bound cannot be compared against the firing interval.`,
    );
  }

  if (expressions.length === 0) {
    u.kind = "monotonic";
    u.cadence = one(u.timer, "Timer", "OnUnitActiveSec") ?? "boot only";
    u.gapSec = parseTimeSpan(one(u.timer, "Timer", "OnUnitActiveSec"));
    continue;
  }

  u.kind = "calendar";
  u.cadence = expressions.join(" + ");

  if (!systemdAvailable) continue;

  const instants = [];
  let broke = false;
  for (const expression of expressions) {
    let hits;
    try {
      hits = elapses(expression);
    } catch (err) {
      failures.push(
        `${u.dir}/${u.name}.timer: systemd-analyze rejected OnCalendar="${expression}": ${String(err.stderr ?? err.message).trim()}`,
      );
      broke = true;
      continue;
    }
    if (hits.length < 2) {
      failures.push(
        `${u.dir}/${u.name}.timer: OnCalendar="${expression}" yields fewer than two future instants from ${BASE}, so it does not describe a recurring schedule.`,
      );
      broke = true;
      continue;
    }
    instants.push(...hits);
  }
  if (broke) continue;

  instants.sort((a, b) => a - b);
  u.instants = instants;

  let minGap = Infinity;
  for (let i = 1; i < instants.length; i += 1) {
    minGap = Math.min(minGap, (instants[i] - instants[i - 1]) / 1000);
  }
  u.gapSec = minGap;

  // The assertion that makes the bound mean something: a wedged run must be
  // KILLED before the timer is due again, because systemd refuses to start a
  // second copy of a oneshot that is still activating. An unbounded job does not
  // miss one run, it suppresses every later run.
  check(
    u.timeoutSec < minGap,
    `${u.dir}/${u.name}: the start-time bound (${u.timeoutSec}s${u.timeoutIsDefault ? ", systemd's default since TimeoutStartSec= is unset" : ""}) is not shorter than the shortest gap between firings (${minGap}s). A wedged run can still be activating when the next firing is due, systemd will refuse to start it, and one stuck run then suppresses every later one.`,
  );
}

// ---------------------------------------------------------------------------
// 4. No two timers this repository ENABLES fire at the same instant.
//
// Scoped to the enabled set on purpose. Three job containers starting in the
// same second on a small node that is also running the BFF, nginx and two Redis
// instances is a memory problem nobody would diagnose as a scheduling one - but
// a unit nothing installs cannot contend for memory with anything, and failing
// on a collision between two timers that never run together would be a false
// alarm that teaches people to ignore this check.
// ---------------------------------------------------------------------------
const owners = new Map();
for (const u of units) {
  if (u.kind !== "calendar" || !u.instants) continue;
  if (!enabledBy.has(u.name)) continue;
  for (const t of u.instants) {
    const owner = owners.get(t);
    check(
      owner === undefined || owner === u.name,
      `${u.name}.timer and ${owner}.timer both fire at ${new Date(t).toISOString()}. Both are enabled by an installer in this repository, so on a node they land together. Give every enabled timer its own instant.`,
    );
    owners.set(t, u.name);
  }
}

// ---------------------------------------------------------------------------
// 5. THE RISK-012 GATE. Every discovered timer is either enabled by an
//    installer in this repository, or written down above with a reason.
// ---------------------------------------------------------------------------
const acknowledged = new Map(NOT_SCHEDULED.map((n) => [n.unit, n]));

for (const u of units) {
  const enablers = enabledBy.get(u.name);
  const ack = acknowledged.get(u.name);

  if (enablers && enablers.length > 0) {
    u.enabledBy = enablers;
    check(
      ack === undefined,
      `${u.name}: NOT_SCHEDULED in ${SELF} claims this timer is deliberately not installed, but ${enablers.join(", ")} enables it. Remove the entry: an exemption that outlived its reason is a standing exemption nobody reads.`,
    );
  } else {
    check(
      ack !== undefined,
      `${u.name}.timer is enabled by NOTHING in this repository. Nothing under infra/ runs "systemctl enable --now ${u.name}.timer", so the unit exists in git and is scheduled on no machine. That is PULLFM-RISK-012 exactly: a control that reads as present because the repository contains it. Either enable it from a bootstrap script, or add it to NOT_SCHEDULED in ${SELF} WITH A REASON.`,
    );
  }

  check(
    !serviceEnabled.has(u.name),
    `${u.name}: an installer runs "systemctl enable" on ${u.name}.service rather than the .timer. Enabling the service runs the job once during bootstrap, before the first deploy has pinned an image.`,
  );
}

// A NOT_SCHEDULED entry for a unit that no longer exists is also stale.
for (const n of NOT_SCHEDULED) {
  check(
    units.some((u) => u.name === n.unit),
    `NOT_SCHEDULED names "${n.unit}", which has no .timer anywhere under infra/**/systemd/. Remove the entry.`,
  );
  check(
    typeof n.why === "string" && n.why.trim().length > 0,
    `NOT_SCHEDULED entry for "${n.unit}" carries no reason. An unexplained exemption is the thing this list exists to prevent.`,
  );
}

// ---------------------------------------------------------------------------
// 6. The job runner and the package manifest agree, for units that use it.
//
// Discovered from ExecStart rather than from a table, so a job added to the
// runner is checked without editing this file. Catches a renamed entrypoint: a
// timer whose job name was quietly dropped from the runner's case statement
// fails as exit 1 forever, and the retention window it enforces stops being
// enforced.
// ---------------------------------------------------------------------------
const RUNNER = join(ROOT, "infra", "staging", "app", "pullfm-job");
if (existsSync(RUNNER) && existsSync(BFF_PKG)) {
  const runner = read(RUNNER);
  const pkg = JSON.parse(read(BFF_PKG));
  for (const u of units) {
    if (!u.hasService) continue;
    const exec = all(u.service, "Service", "ExecStart").join(" ");
    const m = exec.match(/\/usr\/local\/bin\/pullfm-job\s+(\S+)/);
    if (!m) continue;
    const job = m[1];
    u.job = job;
    const entry = runner.match(
      new RegExp(`${job}\\)\\s*ENTRYPOINT=dist/scripts/([\\w-]+)\\.js`),
    );
    check(
      entry !== null,
      `pullfm-job does not map "${job}" to any dist/scripts entrypoint, but ${u.dir}/${u.name}.service invokes it. The unit would fail as exit 1 on every firing.`,
    );
    if (!entry) continue;
    const script = entry[1];
    check(
      existsSync(join(ROOT, "apps", "bff", "src", "scripts", `${script}.ts`)),
      `apps/bff/src/scripts/${script}.ts does not exist, so ${u.name}.timer schedules nothing.`,
    );
    const command = Object.keys(pkg.scripts ?? {}).find(
      (k) => pkg.scripts[k] === `node dist/scripts/${script}.js`,
    );
    check(
      command !== undefined,
      `apps/bff/package.json has no script running "node dist/scripts/${script}.js". The scheduled container and the documented pnpm command must run the same file.`,
    );
    u.command = command;
  }
}

// ---------------------------------------------------------------------------
// 7. Drift against the runbook, WHERE THE RUNBOOK ALREADY SPEAKS.
//
// Conditional on purpose. Requiring every discovered unit to appear in
// docs/RUNBOOK-JOBS.md would make this check demand documentation edits, and a
// check that fails until somebody writes prose gets silenced. What is asserted
// is narrower and always meaningful: if the runbook quotes a unit, it must quote
// the schedule that unit actually carries. Units the runbook does not mention
// are REPORTED, not failed.
// ---------------------------------------------------------------------------
const undocumented = [];
if (!existsSync(RUNBOOK)) {
  failures.push(
    "docs/RUNBOOK-JOBS.md is missing. The schedule has no authoritative home.",
  );
} else {
  const runbook = read(RUNBOOK);
  for (const u of units) {
    if (!runbook.includes(`${u.name}.timer`)) {
      undocumented.push(u.name);
      continue;
    }
    for (const expression of all(u.timer, "Timer", "OnCalendar")) {
      check(
        runbook.includes(expression),
        `docs/RUNBOOK-JOBS.md mentions ${u.name}.timer but does not quote its OnCalendar "${expression}". The runbook and the unit have drifted, and a runbook that drifts is worse than none: it is consulted.`,
      );
    }
    if (u.command !== undefined) {
      check(
        runbook.includes(u.command),
        `docs/RUNBOOK-JOBS.md mentions ${u.name}.timer but not the ${u.command} command it corresponds to.`,
      );
    }
  }
}

if (systemdAvailable) {
  notes.push(
    `every OnCalendar expression was validated and expanded by systemd-analyze (${ITERATIONS} iterations from ${BASE})`,
  );
} else {
  notes.push(
    "systemd-analyze is NOT INSTALLED, so no OnCalendar expression was validated and no firing interval was derived. The bound-shorter-than-gap assertion and the collision check did not run. Run this on Linux, which CI does.",
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const nameW = Math.max(...units.map((u) => u.name.length), 4);
const dirW = Math.max(...units.map((u) => u.dir.length), 9);

console.log(`scheduled units discovered in this repository: ${units.length}\n`);
console.log(
  `  ${pad("UNIT", nameW)}  ${pad("DIRECTORY", dirW)}  ${pad("TRIGGER", 9)}  ${pad("CADENCE", 24)}  BOUND / GAP`,
);
for (const u of units) {
  const gap = u.gapSec === undefined ? "?" : `${u.gapSec}s`;
  const bound = `${u.timeoutSec}s${u.timeoutIsDefault ? "*" : ""}`;
  // A monotonic timer rearms only after its unit goes inactive, so its bound is
  // not compared against its interval and the row says so rather than showing
  // two numbers that look like a violation.
  const relation = u.kind === "calendar" ? "of" : "per (not compared,";
  const tail = u.kind === "calendar" ? "" : " see below)";
  console.log(
    `  ${pad(u.name, nameW)}  ${pad(u.dir, dirW)}  ${pad(u.kind ?? "?", 9)}  ${pad(u.cadence ?? "?", 24)}  ${bound} ${relation} ${gap}${tail}`,
  );
}
console.log(
  "\n  * bound is systemd's DefaultTimeoutStartSec; the unit sets no TimeoutStartSec=.\n" +
    "  A monotonic timer (OnUnitActiveSec=) rearms from the moment its unit goes\n" +
    "  INACTIVE, so it cannot overlap its own run and its bound is deliberately not\n" +
    "  compared against its interval. Only calendar timers can collide with themselves.",
);

const scheduled = units.filter((u) => u.enabledBy);
console.log(
  `\nasked to be installed by an installer in this repository: ${scheduled.length} of ${units.length}\n`,
);
for (const u of scheduled) {
  console.log(`  ${pad(u.name, nameW)}  <- ${u.enabledBy.join(", ")}`);
}

const parked = units.filter((u) => !u.enabledBy);
if (parked.length > 0) {
  const settled = parked.filter((u) => !acknowledged.get(u.name)?.open);
  const open = parked.filter((u) => acknowledged.get(u.name)?.open);

  if (settled.length > 0) {
    console.log(
      `\nIN THE REPOSITORY AND DELIBERATELY NOT SCHEDULED: ${settled.length}\n`,
    );
    for (const u of settled) {
      console.log(`  ${u.name}`);
      console.log(`    ${acknowledged.get(u.name)?.why ?? "(no reason)"}\n`);
    }
  }

  if (open.length > 0) {
    console.log(
      `\nOPEN FINDINGS - IN THE REPOSITORY, SCHEDULED BY NOTHING, NOT A DECISION: ${open.length}\n`,
    );
    for (const u of open) {
      console.log(`  ${u.name}`);
      console.log(`    ${acknowledged.get(u.name)?.why ?? "(no reason)"}\n`);
    }
  }
}

if (undocumented.length > 0) {
  console.log(
    `not mentioned in docs/RUNBOOK-JOBS.md, so no drift check ran against it: ${undocumented.length}`,
  );
  console.log(`  ${undocumented.join(", ")}\n`);
}

for (const n of notes) console.log(`  note: ${n}`);
console.log();

if (failures.length > 0) {
  console.error(`FAILED (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The pass message is deliberately narrow. The previous one read "PASS: every
// job is scheduled, enabled, bounded, and exit 1 reaches the alert path" while
// asserting over four of thirteen units and while having no way whatsoever to
// know whether anything was enabled anywhere. Both halves of that were wrong.
// ---------------------------------------------------------------------------
console.log(
  `PASS  ${units.length} timers discovered; each has a service, a valid schedule, a bound\n` +
    "      shorter than its own firing gap, a wired failure path where it declares one,\n" +
    `      and is either enabled by an installer here (${scheduled.length}) or written down with a\n` +
    `      reason (${parked.length}).`,
);
console.log(
  "\nWHAT THIS DID NOT CHECK, because a checkout cannot:\n" +
    "      whether any of these is enabled on any machine, whether any timer has a\n" +
    "      NEXT, whether any has ever fired, and what it exited. This proves the\n" +
    "      repository ASKS for a schedule; it cannot prove a machine HAS one. The only\n" +
    "      answer to that is `systemctl list-timers --all 'pullfm-*'` on the node.\n" +
    "      PULLFM-RISK-012 was a unit that would have passed every repository-side\n" +
    "      assertion above and was installed nowhere; it was found by enumerating the\n" +
    "      machine, and pullfm-heartbeat is the same gap in the other direction.",
);
