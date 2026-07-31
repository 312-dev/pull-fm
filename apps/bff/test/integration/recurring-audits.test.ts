/**
 * The recurring audits are performed, and the check that says so can fail.
 *
 * The overdue arithmetic takes `now` as a parameter precisely so it can be
 * tested against fixed dates. A date-based check exercised only on the day the
 * suite happens to run is not a test; it is a coincidence.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  RECURRING_AUDITS,
  describeOverdue,
  dueDate,
  overdueAudits,
  type RecurringAudit,
} from "../../src/lib/recurring-audits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

const sample: RecurringAudit = {
  id: "sample",
  what: "Re-read a thing that changes without telling us",
  why: "Because it changes without telling us",
  intervalDays: 90,
  lastCompletedOn: "2026-01-01",
  lastCompletedBy: "operator",
  evidence: "somewhere",
  blocks: "B8",
};

describe("the overdue arithmetic", () => {
  test("computes the due date from the interval", () => {
    expect(dueDate(sample)).toBe("2026-04-01");
  });

  test("an audit inside its interval is not overdue", () => {
    expect(overdueAudits(new Date("2026-03-31T00:00:00Z"), [sample])).toEqual(
      [],
    );
  });

  test("an audit exactly on its due date is not yet overdue", () => {
    // The boundary matters: firing on the due date would make every interval
    // one day shorter than it says, and a check whose stated interval is not
    // its real interval is a small lie that compounds.
    expect(overdueAudits(new Date("2026-04-01T00:00:00Z"), [sample])).toEqual(
      [],
    );
  });

  test("an audit past its due date IS overdue, with the day count", () => {
    const overdue = overdueAudits(new Date("2026-04-11T00:00:00Z"), [sample]);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.daysOverdue).toBe(10);
    expect(overdue[0]!.dueOn).toBe("2026-04-01");
  });

  test("the failure text says what to do, not just what is wrong", () => {
    const text = describeOverdue(
      overdueAudits(new Date("2026-04-11T00:00:00Z"), [sample]),
    );
    expect(text).toContain("What:");
    expect(text).toContain("Why it matters:");
    expect(text).toContain("To clear:");
    expect(text).toContain("fix anything it finds FIRST");
  });
});

describe("the registry is well formed", () => {
  test("ids are unique", () => {
    const ids = RECURRING_AUDITS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("dates are ISO and not in the future", () => {
    // A future completion date would silently extend every interval.
    const today = new Date().toISOString().slice(0, 10);
    for (const a of RECURRING_AUDITS) {
      expect(a.lastCompletedOn, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        a.lastCompletedOn <= today,
        `${a.id} claims to have been completed on ${a.lastCompletedOn}, which ` +
          `is in the future`,
      ).toBe(true);
    }
  });

  test("intervals are sane", () => {
    for (const a of RECURRING_AUDITS) {
      expect(a.intervalDays, a.id).toBeGreaterThanOrEqual(7);
      expect(a.intervalDays, a.id).toBeLessThanOrEqual(365);
    }
  });

  test("each names a checklist item that exists", () => {
    const checklist = readFileSync(
      join(REPO, "docs/compliance/publication-checklist.md"),
      "utf8",
    );
    for (const a of RECURRING_AUDITS) {
      expect(a.blocks).toMatch(/^[A-F]\d+$/);
      expect(
        checklist.includes(`### ${a.blocks}.`) ||
          checklist.includes(`| ${a.blocks} `),
        `${a.id} points at checklist item ${a.blocks}, which is not in the checklist`,
      ).toBe(true);
    }
  });

  test("each names evidence that exists, where the evidence is a file", () => {
    for (const a of RECURRING_AUDITS) {
      const file = a.evidence.split(" ")[0]!;
      if (!file.includes("/")) continue;
      expect(
        existsSync(join(REPO, file)),
        `${a.id} cites evidence at ${file}, which does not exist`,
      ).toBe(true);
    }
  });

  test("the why is specific enough to justify the interruption", () => {
    // A build that fails on a date has to explain itself or it gets suppressed.
    for (const a of RECURRING_AUDITS) {
      expect(a.why.length, `${a.id} why is too vague`).toBeGreaterThan(80);
      expect(a.what.length, `${a.id} what is too vague`).toBeGreaterThan(80);
    }
  });
});

describe("nothing is currently overdue", () => {
  test("every recurring audit is within its interval", () => {
    const overdue = overdueAudits(new Date());
    expect(
      overdue.length,
      `\n\nA recurring legal audit is overdue. These lapse with time rather ` +
        `than with a code change, so nothing else in this repository will ` +
        `notice.\n\n${describeOverdue(overdue)}\n`,
    ).toBe(0);
  });

  test("that assertion is not vacuous", () => {
    // Proves the registry is non-empty and the checker returns findings for a
    // date far enough forward, so a green result above means "all current"
    // rather than "nothing configured".
    expect(RECURRING_AUDITS.length).toBeGreaterThan(0);
    const farFuture = new Date("2099-01-01T00:00:00Z");
    expect(overdueAudits(farFuture)).toHaveLength(RECURRING_AUDITS.length);
  });
});
