#!/usr/bin/env node
/**
 * Proves the server-side query ceilings are REAL on a live deployment, by
 * measuring them rather than by reading them back.
 *
 *   PGURL_ITEM=pull-fm/staging/DATABASE_URL_US node packages/db/scripts/verify-query-ceilings.mjs
 *   DATABASE_URL='postgres://...' node packages/db/scripts/verify-query-ceilings.mjs
 *
 * Point it at the POOLED endpoint with the APPLICATION role. That is the only
 * combination that reproduces the request path, and it is the combination every
 * other check in this repository cannot see.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE SCRIPT, WHEN verify-app-role.sql ALREADY ASSERTS THE VALUES
 * ---------------------------------------------------------------------------
 *
 * `infra/neon/sql/verify-app-role.sql` group 4b reads `pg_db_role_setting` and
 * asserts the four expected rows are present. That is worth having and it is
 * NOT sufficient, because the failure this whole control exists to prevent is
 * "a setting that is recorded, reads back correctly, and does not fire".
 *
 * Measured on 2026-07-29 against both Neon branches, this is not hypothetical:
 * the catalog rows were present AND `current_setting('statement_timeout')`
 * returned '30s' on the pooled endpoint, and neither fact would have changed if
 * the backend had ignored the value. Only `SELECT pg_sleep(35)` coming back as
 * `canceling statement due to statement timeout`, after 30 seconds, settles it.
 *
 * So this script asserts three things in order, and the third is the one that
 * cannot be faked:
 *
 *   1. the value the backend reports, in milliseconds, from `pg_settings`
 *   2. that it reports the same value on MANY concurrent sessions, not one
 *   3. that a statement exceeding it is actually killed, and when
 *
 * ---------------------------------------------------------------------------
 * WHY THE FAN-OUT IN STEP 2
 * ---------------------------------------------------------------------------
 *
 * A role default is read by the backend at session start, and both Neon's
 * pooler and Neon's proxy PARK a server backend after the client disconnects
 * and hand it, with its session state intact, to a later connection. A single
 * probe run shortly after `ALTER ROLE` can therefore be served by a backend
 * that predates the change and report the old value while nothing is wrong.
 * Measured on staging on 2026-07-29: one connection reported 0, and opening 20
 * concurrent sessions forced new backends of which 19 of 20 reported the new
 * value.
 *
 * The fan-out is what turns that transient into a signal instead of a coin
 * flip. All sessions must agree; a disagreement is reported with the count, so
 * "I ran this ten seconds after applying it" reads differently from "the
 * setting is gone".
 *
 * ---------------------------------------------------------------------------
 * WHERE THE EXPECTED NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 *
 * Parsed out of the `ALTER ROLE` statements in
 * `infra/neon/sql/set-role-timeouts.sql` (and, for the local stack, out of
 * `infra/local/postgres-init/01-role-timeouts.sql`), keyed by the role in the
 * connection string. Nothing is hard-coded here on purpose: a script with its
 * own copy of the numbers is a second source of truth that can agree with
 * itself while disagreeing with what is applied.
 *
 * ---------------------------------------------------------------------------
 * CREDENTIAL HANDLING
 * ---------------------------------------------------------------------------
 *
 * The connection string is decomposed into PGHOST/PGUSER/PGPASSWORD/... and
 * handed to psql through the ENVIRONMENT, never through argv. This script is
 * meant to be pointed at production, and argv is readable by every process on
 * the host; `packages/db/scripts/verify-migrations.mjs` passes a URL on the
 * command line and scrubs its output, which is the weaker of the two and is
 * only acceptable there because that script targets a scratch database.
 *
 * Output is scrubbed as well, on the same reasoning as verify-migrations.mjs:
 * the point is that a future edit cannot reintroduce the disclosure by logging
 * a field nobody thought about.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const NEON_TIMEOUTS_SQL = join(
  REPO,
  "infra",
  "neon",
  "sql",
  "set-role-timeouts.sql",
);
const LOCAL_TIMEOUTS_SQL = join(
  REPO,
  "infra",
  "local",
  "postgres-init",
  "01-role-timeouts.sql",
);

/** How many concurrent sessions the fan-out opens. See the header. */
const FANOUT = Number(process.env["CEILING_FANOUT"] ?? 20);

/**
 * Seconds added to a ceiling before asking the server to exceed it.
 *
 * Small on purpose. A generous margin makes the test slower without making it
 * stronger: what is being proved is that the kill happens, and the elapsed
 * assertion below is what proves it happened at the right time rather than
 * because something else gave up.
 */
const OVERSHOOT_SECONDS = 5;

let failures = 0;

const scrub = (s) =>
  String(s).replace(
    /(postgres(?:ql)?:\/\/[^:@/\s]+:)[^@\s]*@/gi,
    "$1<REDACTED>@",
  );

const pass = (m) => console.log(`  PASS  ${scrub(m)}`);
const fail = (m, detail) => {
  failures++;
  console.error(`  FAIL  ${scrub(m)}`);
  if (detail) console.error(`        ${scrub(detail).split("\n")[0]}`);
};

// ---------------------------------------------------------------------------
// Expected values, read from the files that apply them.
// ---------------------------------------------------------------------------

/**
 * Postgres time units, in milliseconds.
 *
 * `statement_timeout` has a unit of `ms`, so a bare integer in an `ALTER ROLE`
 * means milliseconds and `'30s'` means 30000. Both spellings are accepted here
 * because both are legal in the SQL files and a reader should not have to know
 * which one is currently in use.
 */
const UNITS = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000 };

function durationToMs(text) {
  const m = /^\s*'?\s*(\d+)\s*([a-z]*)\s*'?\s*$/i.exec(text);
  if (!m) return null;
  const unit = (m[2] || "ms").toLowerCase();
  if (!(unit in UNITS)) return null;
  return Number(m[1]) * UNITS[unit];
}

/**
 * Every `ALTER ROLE <role> SET <setting> = <value>` in a file, as
 * `{ role: { setting: ms } }`.
 *
 * Deliberately a parse of the real statements rather than a lookup table. If
 * somebody edits the ceiling, this follows; if somebody deletes the statement,
 * this reports the role as unconfigured instead of asserting a number nothing
 * applies.
 */
function parseRoleDefaults(path, into = {}) {
  const text = readFileSync(path, "utf8");
  const re =
    /^[^\S\n]*ALTER\s+ROLE\s+(\w+)\s+SET\s+(statement_timeout|idle_in_transaction_session_timeout)\s*=\s*([^;]+);/gim;
  for (const m of text.matchAll(re)) {
    const ms = durationToMs(m[3]);
    if (ms === null) continue;
    // The source path travels with the numbers so a failure can name the file
    // to edit. Two files define ceilings for two different roles, and telling
    // somebody to fix the Neon one when the local mirror is what disagrees
    // sends them to the wrong place.
    const entry = (into[m[1]] ??= { source: path, settings: {} });
    entry.source = path;
    entry.settings[m[2]] = ms;
  }
  return into;
}

/** `infra/neon/sql/...` rather than the absolute path, for a readable message. */
const rel = (p) => p.slice(REPO.length + 1);

// ---------------------------------------------------------------------------
// Connection handling.
// ---------------------------------------------------------------------------

/**
 * A connection string as libpq environment variables.
 *
 * Returns the env WITHOUT the password folded into any string that could be
 * logged, and the role name separately so the caller can pick its expectations.
 */
function toPgEnv(url) {
  const u = new URL(url);
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ""),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "require",
    // Names the prober in pg_stat_activity, so a session this script leaves
    // behind is attributable rather than mysterious.
    PGAPPNAME: "pullfm-verify-query-ceilings",
  };
  // Nothing downstream should be able to reconstruct the URL from the env.
  delete env["DATABASE_URL"];
  delete env["PGURL"];
  return { env, role: env.PGUSER, host: env.PGHOST };
}

function psql(env, sql, args = []) {
  return execFileSync(
    "psql",
    ["-qtAX", "-v", "ON_ERROR_STOP=1", ...args, "-c", sql],
    {
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
}

/**
 * psql as a promise, resolving rather than rejecting on a non-zero exit.
 *
 * `spawn` and not `promisify(execFile)`, because two of the three checks need
 * to write a script to psql's STDIN and execFile has no way to do that without
 * going synchronous - and the fan-out check needs them concurrent.
 *
 * A failure is a RESULT here, not an exception. Every interesting outcome in
 * this file is a psql that exited non-zero, so treating that as control flow
 * rather than as an error keeps the assertion logic in one place.
 */
function psqlAsync(env, argv, input) {
  return new Promise((resolve) => {
    const child = spawn("psql", argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) =>
      resolve({ ok: false, out: `${out}${String(err.message)}` }),
    );
    child.on("close", (code) => resolve({ ok: code === 0, out }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

/**
 * Step 1: THE CATALOG, which is the only authority a parked backend cannot
 * forge.
 *
 * THIS CHECK WAS ADDED BECAUSE THE SCRIPT WITHOUT IT REPORTED PASS ON A
 * DATABASE WHOSE CEILING HAD BEEN DELETED. Measured on 2026-07-29 against the
 * local stack, which is PgBouncer in front of Postgres exactly as Neon is:
 *
 *   1. `ALTER ROLE pullfm SET statement_timeout = 0`  (the regression, by hand)
 *   2. `pg_db_role_setting` confirms `statement_timeout=0` is now what is
 *      recorded, so the role really is unbounded from the next connection on
 *   3. this script, fanning out over 8 concurrent sessions, reported
 *      `statement_timeout=10000ms` on all 8, cancelled `pg_sleep(15)` at
 *      10020ms, and exited 0
 *
 * Every session had been served by a server connection PgBouncer had parked
 * before step 1, and a parked backend keeps the value it started with. So the
 * fan-out described in the header narrows the window and does not close it: it
 * only forces new backends when the pooler has fewer parked ones than the
 * fan-out asks for, and after any normal amount of traffic it does not.
 *
 * A verification script that passes on the exact regression it exists to catch
 * is worse than no script, so the reported value is no longer the authority.
 * `pg_db_role_setting` is: it is what a backend reads at session start, it is
 * updated by `ALTER ROLE` immediately, and no amount of connection reuse can
 * make it lie. `pullfm_app` can read it - verified against staging - so this
 * check needs no extra privilege.
 *
 * The live checks below did not become pointless; they became corroboration.
 * The catalog says what WILL be applied; the sessions say what IS applied; the
 * firing test says the applied value is real. All three, or the run does not
 * mean anything.
 */
function checkCatalog(env, role, expected, source) {
  const rows = psql(
    env,
    `SELECT split_part(cfg, '=', 1) || ' ' || split_part(cfg, '=', 2)
       FROM pg_roles r
       JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0,
            unnest(s.setconfig) AS cfg
      WHERE r.rolname = '${role}'
        AND split_part(cfg, '=', 1) IN ('statement_timeout',
                                        'idle_in_transaction_session_timeout')`,
  );

  const recorded = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [name, ...rest] = line.trim().split(" ");
    recorded[name] = durationToMs(rest.join(" "));
  }

  let ok = true;
  for (const [setting, wantMs] of Object.entries(expected)) {
    const gotMs = recorded[setting];
    if (gotMs === undefined) {
      fail(
        `pg_db_role_setting has NO ${setting} for ${role}: this role is UNBOUNDED`,
        `${source} says it should be ${String(wantMs)}ms. Apply that file to ` +
          `this branch; it is idempotent and re-running it is the documented ` +
          `repair.`,
      );
      ok = false;
    } else if (gotMs !== wantMs) {
      fail(
        `pg_db_role_setting records ${setting} = ${String(gotMs)}ms for ${role}, ` +
          `not the ${String(wantMs)}ms in ${source}`,
        gotMs === 0
          ? "0 means UNBOUNDED. This role has no ceiling at all."
          : "The applied value and the file have drifted; one of them is wrong.",
      );
      ok = false;
    } else {
      pass(
        `pg_db_role_setting records ${setting} = ${String(wantMs)}ms for ${role}`,
      );
    }
  }
  return ok;
}

/**
 * Step 2: what the backend reports, on many sessions at once.
 *
 * Read from `pg_settings.setting`, which is normalised to the GUC's own unit
 * (milliseconds for both of these), NOT from `current_setting()`, which returns
 * whatever spelling Postgres chose to display. `ALTER ROLE ... SET
 * idle_in_transaction_session_timeout = '60s'` is reported by
 * `current_setting()` as `1min`, and a check comparing that text to '60s' fails
 * while the setting is perfectly correct. Comparing integers removes a whole
 * category of false failure.
 */
async function checkReportedValues(env, expected) {
  const settings = Object.keys(expected);
  const sql = `select ${settings
    .map((s) => `(select setting from pg_settings where name = '${s}')`)
    .join(" || '|' || ")}`;

  const results = await Promise.all(
    Array.from({ length: FANOUT }, () =>
      psqlAsync(env, ["-qtAX", "-v", "ON_ERROR_STOP=1", "-c", sql]),
    ),
  );

  const tally = new Map();
  for (const r of results) {
    const key = r.ok ? r.out.trim() : `ERROR: ${r.out.trim().split("\n")[0]}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  const want = settings.map((s) => String(expected[s])).join("|");
  const agreeing = tally.get(want) ?? 0;

  if (agreeing === FANOUT) {
    pass(
      `all ${String(FANOUT)} concurrent sessions report ${settings
        .map((s) => `${s}=${String(expected[s])}ms`)
        .join(", ")}`,
    );
    return true;
  }

  const seen = [...tally.entries()]
    .map(([k, n]) => `${String(n)}x ${k}`)
    .join("; ");
  fail(
    `only ${String(agreeing)} of ${String(FANOUT)} sessions report the expected ${want}`,
    `observed: ${seen}. If this ran within a minute or two of applying ` +
      `set-role-timeouts.sql, some of these were served by a PARKED backend ` +
      `that predates it, which ages out on its own - re-run. If it persists, ` +
      `the role default is not what this repository says it is.`,
  );
  return false;
}

/**
 * Step 3a: a statement that exceeds the ceiling is KILLED, and at the right
 * time.
 *
 * The elapsed assertion is not decoration. Without it, any failure at all
 * counts as a pass: a dropped connection, a proxy idle timeout, or psql giving
 * up all produce an error from `pg_sleep`, and none of them is a statement
 * timeout. So both the message AND the timing have to be right.
 */
async function checkStatementTimeoutFires(env, expectedMs) {
  const sleepFor = expectedMs / 1000 + OVERSHOOT_SECONDS;
  const t0 = Date.now();
  const r = await psqlAsync(env, [
    "-qtAX",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `select pg_sleep(${String(sleepFor)})`,
  ]);
  const elapsed = Date.now() - t0;

  if (r.ok) {
    fail(
      `pg_sleep(${String(sleepFor)}) COMPLETED in ${String(elapsed)}ms - ` +
        `statement_timeout did not fire and this connection is UNBOUNDED`,
    );
    return;
  }
  if (!/canceling statement due to statement timeout/i.test(r.out)) {
    fail(
      `pg_sleep(${String(sleepFor)}) failed for the wrong reason after ${String(elapsed)}ms`,
      r.out,
    );
    return;
  }
  // Connection setup, TLS, and a cold Neon compute all land before the clock
  // the server starts, so the floor is generous and the ceiling is what
  // actually pins the number down.
  if (elapsed < expectedMs * 0.75 || elapsed > expectedMs + 15_000) {
    fail(
      `the statement was cancelled but after ${String(elapsed)}ms, not near the ` +
        `${String(expectedMs)}ms ceiling`,
    );
    return;
  }
  pass(
    `pg_sleep(${String(sleepFor)}) was cancelled by statement_timeout after ${String(elapsed)}ms`,
  );
}

/**
 * Step 3b: a session left idle inside a transaction is TERMINATED.
 *
 * `\! sleep` rather than `pg_sleep`, and the difference is the entire test:
 * `pg_sleep` inside a transaction is a RUNNING STATEMENT, which is what
 * statement_timeout governs. `idle_in_transaction_session_timeout` only fires
 * while the session is idle AND in a transaction, which means the wait has to
 * happen on the CLIENT side. `\!` shells out while the connection sits exactly
 * there.
 *
 * The expected outcome is a FATAL and a lost connection, not an ERROR: this
 * timeout terminates the backend rather than cancelling a statement.
 */
async function checkIdleInTransactionFires(env, expectedMs) {
  const sleepFor = Math.ceil(expectedMs / 1000) + OVERSHOOT_SECONDS + 5;
  const script = [
    "begin;",
    "select 1;",
    `\\! sleep ${String(sleepFor)}`,
    "select 'STILL ALIVE' as verdict;",
    "",
  ].join("\n");

  const t0 = Date.now();
  const r = await psqlAsync(
    env,
    ["-qAX", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    script,
  );
  const elapsed = Date.now() - t0;

  if (r.ok || /STILL ALIVE/.test(r.out)) {
    fail(
      `a session sat idle in a transaction for ${String(sleepFor)}s and SURVIVED - ` +
        `idle_in_transaction_session_timeout did not fire, so a leaked BEGIN ` +
        `can hold a pooled connection and its locks indefinitely`,
    );
    return;
  }
  if (!/idle[- ]in[- ]transaction timeout/i.test(r.out)) {
    fail(
      `the idle session died after ${String(elapsed)}ms for the wrong reason`,
      r.out,
    );
    return;
  }
  pass(
    `a session idle in a transaction was terminated by ` +
      `idle_in_transaction_session_timeout (waited ${String(sleepFor)}s against a ` +
      `${String(expectedMs)}ms ceiling)`,
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Resolves the connection string.
 *
 * `PGURL_ITEM` reads it out of 1Password at the moment of use, which is the
 * preferred form: it keeps the string out of the shell history, out of the
 * environment of every other process the shell spawns, and off disk. A literal
 * `DATABASE_URL` is accepted for the local stack and for CI-shaped use.
 */
function resolveUrl() {
  const item = process.env["PGURL_ITEM"];
  if (item) {
    return execFileSync(
      "op",
      [
        "item",
        "get",
        item,
        "--vault",
        process.env["PULLFM_OP_VAULT"] ?? "MCP",
        "--fields",
        "label=credential",
        "--reveal",
      ],
      { encoding: "utf8" },
    ).trim();
  }
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error(
      "set PGURL_ITEM (a 1Password item title) or DATABASE_URL.\n" +
        "Point it at the POOLED endpoint as the APPLICATION role: that is the\n" +
        "path a startup parameter cannot reach and the only one worth proving.",
    );
    process.exit(2);
  }
  return url;
}

const { env, role, host } = toPgEnv(resolveUrl());

const defaults = parseRoleDefaults(
  LOCAL_TIMEOUTS_SQL,
  parseRoleDefaults(NEON_TIMEOUTS_SQL),
);
const entry = defaults[role];

console.log(`\nServer-side query ceilings: ${role}@${host}\n`);

if (!entry) {
  console.error(
    `  FAIL  no ALTER ROLE for '${role}' in either\n` +
      `        ${rel(NEON_TIMEOUTS_SQL)} or\n` +
      `        ${rel(LOCAL_TIMEOUTS_SQL)}.\n` +
      `        This role has no ceiling that this repository knows about.`,
  );
  process.exit(1);
}

const expected = entry.settings;
const source = rel(entry.source);

// A ceiling of 0 is UNBOUNDED, so an EXPECTATION of 0 would make every check
// below confirm the absence of the control. Refused here rather than compared,
// because a comparison passes when both sides are wrong the same way and this
// script would then certify a database with no ceiling as correct.
const unbounded = Object.entries(expected).filter(([, ms]) => ms === 0);
if (unbounded.length > 0) {
  console.error(
    `  FAIL  ${source} sets ${unbounded.map(([k]) => k).join(", ")} to 0 for ` +
      `'${role}'.\n` +
      `        0 is not a large timeout, it is the absence of one. There is\n` +
      `        nothing here for this script to prove.`,
  );
  process.exit(1);
}

// A pooled endpoint is the case that matters, so say so when it is not being
// tested. Not a failure: proving the direct endpoint is still worth doing, it
// just proves less.
//
// Two spellings because there are two poolers. Neon's is a hostname with
// `-pooler` in it; the local stack's is PgBouncer on 6432 (docker-compose.dev.yml
// maps 6432 to the pooler and 5432 to Postgres directly). Recognising only the
// Neon one would print this warning on every local run and train the reader to
// ignore it.
if (!/-pooler\./.test(host) && env.PGPORT !== "6432") {
  console.log(
    `  NOTE  ${host}:${env.PGPORT} is not a pooled endpoint. The request path\n` +
      `        goes through a pooler; this run cannot speak for it.\n`,
  );
}

const stmtMs = expected["statement_timeout"];
const idleMs = expected["idle_in_transaction_session_timeout"];

// A connectivity failure must not look like a timeout finding.
try {
  psql(env, "select 1");
} catch (err) {
  console.error(`  FAIL  cannot connect as ${role}: ${scrub(err.message)}`);
  process.exit(1);
}

// ORDER MATTERS. The catalog is checked FIRST and everything else is gated on
// it, because everything else can be served by a parked backend carrying the
// previous configuration and would then confirm a ceiling that no longer
// exists. See the comment on checkCatalog.
const configured = checkCatalog(env, role, expected, source);
const agreed = configured && (await checkReportedValues(env, expected));

// The firing tests are minutes of wall clock, and running them against a value
// that is either not recorded or not agreed on measures nothing. Skipped LOUDLY
// rather than quietly, because a skipped check that prints nothing is how this
// control got into the state it was in.
if (!configured) {
  console.error(
    "  SKIP  the live checks. The recorded role default is not what this\n" +
      "        repository says it should be, so measuring the sessions would\n" +
      "        only report how stale they are.",
  );
} else if (!agreed) {
  console.error(
    "  SKIP  the firing tests, because the sessions do not agree on the value\n" +
      "        they would be testing. Fix the reported value first.",
  );
} else {
  if (stmtMs !== undefined) await checkStatementTimeoutFires(env, stmtMs);
  if (idleMs !== undefined) await checkIdleInTransactionFires(env, idleMs);
}

console.log(
  failures === 0
    ? `\nQuery ceilings on ${role}@${host}: PASS\n`
    : `\nQuery ceilings on ${role}@${host}: FAIL (${String(failures)} failure(s))\n`,
);
process.exit(failures === 0 ? 0 : 1);
