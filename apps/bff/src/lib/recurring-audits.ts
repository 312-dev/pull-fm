/**
 * Obligations that lapse with time rather than with a code change.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE NEED A MECHANISM AT ALL
 *
 * `legal-triggers.ts` intercepts the moment a capability is switched on.
 * `legal-claims.test.ts` intercepts a change to the system that falsifies a
 * document. Neither can see the third way a legal position goes wrong, which is
 * that nothing changes here and the world moves anyway.
 *
 * Two of those are live today. SeatGeek's own terms permit them to change their
 * terms at any time, with continued use as acceptance and no notice to us, so
 * the cap our clause has to match can drop below USD 50 while this repository
 * sits untouched. And state privacy statutes are amended on their own schedule:
 * Connecticut removed the volume threshold from two of its three applicability
 * triggers on 1 July 2026, which converted "we are below the threshold" from an
 * argument into a non-sequitur, and nothing in this repository would have
 * noticed.
 *
 * The existing answer was "re-audit quarterly", written in a checklist. An
 * intention with no trigger is the thing this codebase keeps rejecting
 * everywhere else, so it is rejected here too.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAILING TEST AND NOT A REMINDER
 *
 * Because a reminder is another intention. A test that goes red on a date is
 * the same shape as a certificate expiry check: disruptive exactly in
 * proportion to how overdue it is, impossible to not notice, and cleared by
 * doing the work rather than by dismissing a notification.
 *
 * The remedy is always the same and is stated in the failure: do the audit,
 * record the date and who did it, and if the audit found something, fix that
 * first. Moving the date without doing the audit is possible, as it is with
 * every control that ends in a human, but it is a lie told in a reviewable diff
 * rather than a task quietly not done.
 */

export interface RecurringAudit {
  readonly id: string;
  /** What has to be re-checked, specifically enough to act on. */
  readonly what: string;
  /** What goes wrong if it lapses. The reason somebody should care today. */
  readonly why: string;
  readonly intervalDays: number;
  /** ISO date the audit was last actually performed. */
  readonly lastCompletedOn: string;
  readonly lastCompletedBy: string;
  /** Where the result of the last one is recorded. */
  readonly evidence: string;
  /** The item in docs/compliance/publication-checklist.md that tracks it. */
  readonly blocks: string;
}

export const RECURRING_AUDITS: readonly RecurringAudit[] = [
  {
    id: "seatgeek-api-terms",
    what:
      "Re-read SeatGeek's API Terms of Use against the transcript in " +
      "packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md. In " +
      "particular clause 8.2, the cap they place on themselves, and clause 4.3, " +
      "the protections our EULA has to match.",
    why:
      "Their section 1 lets them change their terms at any time with continued " +
      "use as acceptance and no notice to us. If their 8.2 cap drops below USD " +
      "50, the fourth bullet of terms section 13 is immediately less protective " +
      "than 4.3 requires, and we would not know. The predicate in " +
      "legal-triggers.ts catches OUR figure moving and cannot catch theirs; " +
      "this is the other half of that control.",
    intervalDays: 90,
    lastCompletedOn: "2026-07-29",
    lastCompletedBy: "operator",
    evidence: "packages/upstream/vendor-specs/seatgeek-api-terms-2025-03-17.md",
    blocks: "B8",
  },
  {
    id: "state-privacy-law-survey",
    what:
      "Re-check the state comprehensive privacy statutes against primary " +
      "sources: applicability thresholds, the definition of sensitive data, and " +
      "any statute newly in force. Privacy policy section 10.2 states a " +
      "position on all of them.",
    why:
      "Connecticut removed the volume threshold from two of its three " +
      "applicability triggers on 1 July 2026, so the reasoning that Pull.fm is " +
      "below every threshold stopped reaching it. That amendment was signed in " +
      "2025 and took effect a year later; nothing here would have surfaced it. " +
      "Indiana, Kentucky and Rhode Island took effect on 1 January 2026 and " +
      "more are scheduled.",
    intervalDays: 180,
    lastCompletedOn: "2026-07-30",
    lastCompletedBy: "operator",
    evidence: "legal/privacy-policy.md section 10.2",
    blocks: "A6",
  },
];

export interface OverdueAudit {
  readonly audit: RecurringAudit;
  readonly dueOn: string;
  readonly daysOverdue: number;
}

const DAY_MS = 86_400_000;

/** The date an audit next falls due, as an ISO date. */
export function dueDate(audit: RecurringAudit): string {
  const last = Date.parse(`${audit.lastCompletedOn}T00:00:00Z`);
  return new Date(last + audit.intervalDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Audits that are past due at `now`.
 *
 * `now` is a parameter rather than read from the clock so the overdue
 * arithmetic can be tested against fixed dates. A function that read the clock
 * itself could only ever be tested on the one day the suite happened to run,
 * which for a date-based check is no test at all.
 */
export function overdueAudits(
  now: Date,
  audits: readonly RecurringAudit[] = RECURRING_AUDITS,
): OverdueAudit[] {
  const out: OverdueAudit[] = [];
  for (const audit of audits) {
    const due = Date.parse(`${dueDate(audit)}T00:00:00Z`);
    if (now.getTime() > due) {
      out.push({
        audit,
        dueOn: dueDate(audit),
        daysOverdue: Math.floor((now.getTime() - due) / DAY_MS),
      });
    }
  }
  return out;
}

/** A failure message that says what to do, not merely what is wrong. */
export function describeOverdue(overdue: readonly OverdueAudit[]): string {
  return overdue
    .map(
      (o) =>
        `  ${o.audit.id} was due ${o.dueOn} and is ${String(o.daysOverdue)} day(s) ` +
        `overdue.\n    What: ${o.audit.what}\n    Why it matters: ${o.audit.why}\n` +
        `    Evidence lives in: ${o.audit.evidence}\n` +
        `    Tracked as checklist item ${o.audit.blocks}.\n` +
        `    To clear: perform the audit, fix anything it finds FIRST, then ` +
        `update lastCompletedOn and lastCompletedBy in lib/recurring-audits.ts.`,
    )
    .join("\n\n");
}
