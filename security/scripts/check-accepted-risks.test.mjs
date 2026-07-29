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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = resolve(HERE, "check-accepted-risks.mjs");
const FIXTURES = resolve(HERE, "..", "testdata", "accepted-risks");

// The real register moved to a private repository on 2026-07-29 (see
// security/README.md), so a public checkout usually does not have one. The
// fixtures below are committed here and always run: they are what proves the
// validator still catches each way a register can be wrong, and they are the
// reason this file can skip the two live-register cases without the suite
// becoming decorative.
//
// Resolution deliberately mirrors the validator's own order, so "the tests
// looked at a different file than the gate does" cannot happen quietly.
const REGISTER =
  process.env.PULLFM_RISK_REGISTER ??
  [
    resolve(HERE, "..", "private", "accepted-risks.md"),
    resolve(HERE, "..", "accepted-risks.md"),
  ].find((p) => existsSync(p)) ??
  null;

const NO_REGISTER =
  REGISTER === null || !existsSync(REGISTER)
    ? "no accepted-risk register in this checkout; it is held privately. Set PULLFM_RISK_REGISTER to run these two."
    : false;

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

test("the real register is valid today", { skip: NO_REGISTER }, () => {
  const r = run(["--file", REGISTER]);
  assert.equal(r.code, 0, `real register failed validation:\n${r.stderr}`);
});

test(
  "the real register still parses as strict JSON output",
  { skip: NO_REGISTER },
  () => {
    const r = run(["--file", REGISTER, "--json"]);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.entries >= 1);
  },
);

// The two cases above can skip, so the behaviour that lets them skip has to be
// tested itself, or "the register is private" becomes a way for the gate to
// stop running without anyone noticing.
test("a register that cannot be found is a failure, not a pass", () => {
  const r = run(["--file", resolve(FIXTURES, "does-not-exist.md")]);
  assert.equal(r.code, 2, r.stderr);
});

test("--allow-missing exits 0 only when no register is found at all", () => {
  const missing = run(["--allow-missing", "--json"]);
  // In a checkout that HAS a register this validates it; in one that does not,
  // it skips. Both are exit 0, and the JSON says which happened.
  assert.equal(missing.code, 0, missing.stderr);
  const parsed = JSON.parse(missing.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skipped === true, NO_REGISTER !== false);

  // --allow-missing must not soften a register that exists and is broken.
  const broken = run([
    "--allow-missing",
    "--file",
    resolve(FIXTURES, "expired.md"),
    "--now",
    NOW,
  ]);
  assert.equal(broken.code, 1, broken.stdout);
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

// The two cases below are regressions found by the Phase 8 audit on
// 2026-07-29. Both emptied the register while exiting 0, which is the worst
// available outcome for this gate: it does not merely miss a finding, it
// asserts that every accepted risk is valid when none was read at all. They
// are grouped here because they share that shape and neither is caught by any
// per-entry rule, only by counting what the parser actually saw.
test("a duplicate top-level key cannot silently empty the register", () => {
  const r = check("duplicate-root-key.md");
  assert.equal(r.code, 1);
  assert.ok(
    findings(r).some((x) => /duplicate top-level key/.test(x.message)),
    "a second `register:` must be rejected, not allowed to blank the first",
  );
});

test("a stray `---` cannot truncate the register", () => {
  const r = check("early-fence.md");
  assert.equal(r.code, 1);
  assert.ok(
    findings(r).some((x) => /outside the frontmatter/.test(x.message)),
    "entries after an early fence must be counted and reported, not dropped",
  );
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
