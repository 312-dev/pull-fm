// ---------------------------------------------------------------------------
// Pull.fm - tests for the accepted-risk register validator.
//
// A validator that gates a build has to be tested against the failures it is
// supposed to catch, otherwise "the gate is green" only means "the gate ran".
// Every fixture in security/testdata/accepted-risks/ encodes one way a register
// can be wrong, and each case here asserts the validator notices.
//
// Run:  node --test security/scripts/
//
// node:test and node:assert are built in, so this needs no dependencies and no
// prior `pnpm install`, matching the constraint on the validator itself.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = resolve(HERE, "check-accepted-risks.mjs");
const FIXTURES = resolve(HERE, "..", "testdata", "accepted-risks");
const REGISTER = resolve(HERE, "..", "accepted-risks.md");

// A date well before every fixture expiry, so "expired" cases fail for the
// reason under test rather than because real time moved on.
const NOW = "2026-07-28";

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? -1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function check(fixture, extra = []) {
  return run([
    "--file",
    resolve(FIXTURES, fixture),
    "--now",
    NOW,
    "--json",
    ...extra,
  ]);
}

function findings(result) {
  return JSON.parse(result.stdout).findings;
}

const fieldsIn = (result) => findings(result).map((f) => f.field);

test("the real register is valid today", () => {
  const r = run(["--file", REGISTER]);
  assert.equal(r.code, 0, `real register failed validation:\n${r.stderr}`);
});

test("the real register still parses as strict JSON output", () => {
  const r = run(["--file", REGISTER, "--json"]);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.entries >= 1);
});

test("a well-formed register passes, and a retired entry is exempt from expiry", () => {
  const r = check("valid.md");
  assert.equal(r.code, 0, r.stdout);
  // PULLFM-RISK-002 in the fixture expired 2026-03-01 but is retired.
  assert.deepEqual(findings(r), []);
});

test("an empty register passes", () => {
  // Failing here would create pressure to keep stale entries around just to
  // keep the file non-empty, which is the opposite of the intent.
  const r = check("empty-register.md");
  assert.equal(r.code, 0, r.stdout);
});

test("an expired entry fails the build", () => {
  const r = check("expired.md");
  assert.equal(r.code, 1);
  const f = findings(r);
  assert.ok(
    f.some((x) => x.field === "expires_on" && /EXPIRED/.test(x.message)),
  );
});

test("a missing owner or expiry fails", () => {
  const r = check("missing-field.md");
  assert.equal(r.code, 1);
  const fields = fieldsIn(r);
  for (const required of ["owner", "accepted_on", "expires_on"]) {
    assert.ok(fields.includes(required), `expected a finding for ${required}`);
  }
});

test("an unknown field fails, so a typo cannot silently disable a check", () => {
  const r = check("unknown-field.md");
  assert.equal(r.code, 1);
  assert.ok(fieldsIn(r).includes("expiry_date"));
});

test("dates that do not exist on a calendar fail", () => {
  const r = check("bad-date.md");
  assert.equal(r.code, 1);
  const fields = fieldsIn(r);
  assert.ok(fields.includes("accepted_on")); // 2026-02-30
  assert.ok(fields.includes("expires_on")); // 2026-13-01
});

test("a duplicate id fails", () => {
  const r = check("duplicate-id.md");
  assert.equal(r.code, 1);
  assert.ok(
    findings(r).some((x) => x.field === "id" && /duplicate/.test(x.message)),
  );
});

test("an acceptance window longer than the severity allows fails", () => {
  const r = check("lifetime-too-long.md");
  assert.equal(r.code, 1);
  assert.ok(
    findings(r).some(
      (x) =>
        x.field === "expires_on" &&
        /maximum for severity "critical"/.test(x.message),
    ),
    "expected the severity-scaled lifetime ceiling to trip",
  );
});

test("non-answers for justification and review notes fail", () => {
  const r = check("thin-justification.md");
  assert.equal(r.code, 1);
  const fields = fieldsIn(r);
  assert.ok(fields.includes("justification"));
  assert.ok(fields.includes("review_notes"));
  assert.ok(fields.includes("compensating_controls"));
});

test("an entry accepted in the future fails", () => {
  const r = check("future-accepted.md");
  assert.equal(r.code, 1);
  assert.ok(
    findings(r).some(
      (x) => x.field === "accepted_on" && /future/.test(x.message),
    ),
  );
});

test("YAML outside the documented subset fails closed rather than being guessed at", () => {
  const r = check("malformed-yaml.md");
  assert.equal(r.code, 1);
  assert.ok(findings(r).some((x) => x.field === "<parse>"));
});

test("a file with no frontmatter fence fails", () => {
  const r = check("no-frontmatter.md");
  assert.equal(r.code, 1);
  assert.ok(findings(r).some((x) => x.field === "<parse>"));
});

test("a missing register file is a usage error (exit 2), not a pass", () => {
  const r = run(["--file", resolve(FIXTURES, "does-not-exist.md"), "--json"]);
  assert.equal(
    r.code,
    2,
    "a missing register must never be treated as an empty one",
  );
});

test("an unknown option is a usage error (exit 2)", () => {
  const r = run(["--nope"]);
  assert.equal(r.code, 2);
});

test("--warn-days surfaces an entry that is close to expiry without failing", () => {
  // valid.md's live entry expires 2026-12-01.
  const r = check("valid.md", ["--warn-days", "400"]);
  assert.equal(r.code, 0);
  assert.ok(
    findings(r).some(
      (x) => x.level === "warning" && /expires in/.test(x.message),
    ),
  );
});
