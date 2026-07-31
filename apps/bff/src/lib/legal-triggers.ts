/**
 * Legal triggers: what becomes load-bearing when a capability is switched on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The rest of the legal machinery answers "did the document change?". Digests
 * are pinned, epochs are guarded, a formatter run is not an amendment. All of
 * it protects the DOCUMENT from drifting.
 *
 * None of it protects the document from the CODE. Every claim in
 * `legal/privacy-policy.md` is true today because somebody wrote it after
 * reading the system, and stays true only for as long as nobody changes the
 * system without rereading it. Enabling a feature is the single moment where
 * the largest number of those claims can become false at once, and it is
 * usually one boolean.
 *
 * So this is the interception point. A capability declares, in code, what has
 * to be true before it may be on. Turning it on without those things is a
 * startup failure rather than a discovery made later by a regulator.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT A COMMENT
 *
 * Because a comment was tried and it rotted inside a day.
 *
 * `SEATGEEK_ENABLED` in `config.ts` carried exactly this reasoning, written
 * carefully by somebody who understood it, listing the preconditions for
 * enabling events: the DPAs unsigned, no Article 27 representative appointed,
 * the EULA unpublished. Two of those three were false within twenty-four
 * hours. All four processor agreements were executed on 2026-07-30, and the
 * Article 27 representative became moot when the service moved to a United
 * States posture and the GDPR stopped applying.
 *
 * Nothing failed. Nothing could have failed, because prose has no relationship
 * to the thing it describes. A registry that tests read cannot rot that way.
 *
 * ---------------------------------------------------------------------------
 * THE TWO KINDS OF PRECONDITION, AND WHY THE SECOND ONE EXISTS
 *
 * A `checkable` precondition is proved by a predicate. It is worth exactly as
 * much as its ability to FAIL, so every one of them has a test that mutates
 * the input and asserts it goes red. A predicate that cannot fail is the house
 * defect of this repository and is not permitted here.
 *
 * An `attested` precondition is one no code can prove: that a screen exists and
 * a human saw it, that a document is published at a URL somebody will keep
 * alive. Rather than omit these, which would let a capability look fully gated
 * while its most important condition went unrecorded, they are satisfied only
 * by a dated attestation written into this file. That makes enabling such a
 * capability a reviewed code change rather than an environment variable flip,
 * and it leaves an audit trail naming who checked and when.
 *
 * An attested precondition with `attestedOn: null` BLOCKS. That is the point.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config.js";
import { resolveLegalRoot } from "./legal-source.js";

/** The result of evaluating one precondition. */
export type PreconditionOutcome =
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly because: string };

export const SATISFIED: PreconditionOutcome = { satisfied: true };

export function unsatisfied(because: string): PreconditionOutcome {
  return { satisfied: false, because };
}

/**
 * Everything a precondition may look at.
 *
 * Legal documents are read through an injected reader rather than from disk
 * directly, so a test can hand a predicate a mutated document and prove the
 * predicate notices. A predicate that read the real file itself could only ever
 * be tested against the one input that makes it pass.
 */
export interface TriggerContext {
  readonly config: Config;
  /** Reads a repository-relative path, for example `legal/terms-of-service.md`. */
  readonly readLegal: (relativePath: string) => string;
}

export interface CheckablePrecondition {
  readonly kind: "checkable";
  readonly id: string;
  /** What must be true, as a sentence, for an error message a human can act on. */
  readonly requirement: string;
  readonly check: (ctx: TriggerContext) => PreconditionOutcome;
}

export interface AttestedPrecondition {
  readonly kind: "attested";
  readonly id: string;
  readonly requirement: string;
  /**
   * The item in `docs/compliance/publication-checklist.md` that tracks this,
   * so an unsatisfied attestation points at the work rather than at a wall.
   */
  readonly blocks: string;
  /** ISO date on which a human verified it. `null` blocks the capability. */
  readonly attestedOn: string | null;
  /** Who verified it. Meaningless without `attestedOn` and required with it. */
  readonly attestedBy: string | null;
}

export type Precondition = CheckablePrecondition | AttestedPrecondition;

export interface LegalTrigger {
  /** What the capability is, in a reader's words. */
  readonly capability: string;
  /** The environment variable that turns it on. */
  readonly flag: string;
  /** Whether the capability is live in a resolved configuration. */
  readonly isEnabled: (config: Config) => boolean;
  /**
   * Whether switching this on changes what a user agreed to. `material` means
   * the consent epoch has to move and every user must accept again.
   */
  readonly enabling: "material" | "cosmetic";
  /**
   * Document sections that become load-bearing once this is on. Free text by
   * design: these are pointers for a human reviewer, and a test asserts the
   * documents they name exist.
   */
  readonly documents: readonly string[];
  readonly preconditions: readonly Precondition[];
  /**
   * Why a capability with no preconditions has none. Required exactly when
   * `preconditions` is empty, so "nothing to check" is always a recorded
   * decision and never an oversight.
   */
  readonly inertBecause?: string;
}

// ---------------------------------------------------------------------------
// Predicates.
//
// Each is exported so its own non-vacuity test can reach it, and each looks at
// one thing. A predicate that checked several would report a failure that does
// not say which.
// ---------------------------------------------------------------------------

const TERMS = "legal/terms-of-service.md";
const PRIVACY = "legal/privacy-policy.md";

/**
 * Our cap on the SeatGeek Entities must still be the figure their own terms set
 * for themselves.
 *
 * Their clause 4.3 requires terms "at least as protective of the SeatGeek
 * Entities as the terms hereof" and names limitations of liability as an
 * express example. Their clause 8.2 caps them at USD 50. This was USD 100 until
 * 2026-07-29, which meant our clause left them at twice the exposure their own
 * contract permits, in the one respect 4.3 calls out by name.
 *
 * The honest limit of this check: it catches OUR figure moving. It cannot catch
 * THEIRS moving, because their terms let them change without notice to us. That
 * is why checklist item B8 requires a quarterly re-audit, and why this predicate
 * is not the whole control.
 */
export const seatgeekCapMatchesTheirs: CheckablePrecondition = {
  kind: "checkable",
  id: "seatgeek-cap-is-fifty",
  requirement:
    "Terms section 13 must cap the SeatGeek Entities at USD 50.00, the figure " +
    "their own clause 8.2 sets, in a bullet naming them",
  check: ({ readLegal }) => {
    const terms = readLegal(TERMS);
    // `\s+` rather than a literal space: the formatter owns line breaks, and a
    // predicate that failed when Prettier rewrapped a paragraph would be
    // disabled within a week.
    if (!/FIFTY UNITED STATES\s+DOLLARS \(USD 50\.00\)/.test(terms)) {
      return unsatisfied(
        "Terms section 13 no longer states a USD 50.00 cap for the SeatGeek " +
          "Entities. Their clause 8.2 caps them at that figure and their 4.3 " +
          "requires ours to be at least as protective.",
      );
    }
    if (!/SEATGEEK ENTITIES/.test(terms)) {
      return unsatisfied(
        "The USD 50.00 cap is present but no longer names the SeatGeek " +
          "Entities. Protection extended to a third-party beneficiary must be " +
          "findable by searching for that beneficiary's name (Sosa v. Onfido).",
      );
    }
    return SATISFIED;
  },
};

/**
 * The third-party beneficiary grant must survive, and must still enumerate the
 * limitation-of-liability section.
 *
 * `Sosa v. Onfido`, 8 F.4th 631 (7th Cir. 2021) turned on a third party falling
 * outside the class a limitation protected. Illinois requires third-party
 * benefit to be practically an express declaration, so an enumeration that
 * points at the wrong section is the specific defect that decided that case.
 */
export const seatgeekBeneficiaryGrantIntact: CheckablePrecondition = {
  kind: "checkable",
  id: "seatgeek-beneficiary-grant-intact",
  requirement:
    "Terms section 9 must name the SeatGeek Entities as express third-party " +
    "beneficiaries and enumerate the limitation-of-liability section",
  check: ({ readLegal }) => {
    const terms = readLegal(TERMS);
    if (!/express third-party\s+beneficiaries/.test(terms)) {
      return unsatisfied(
        "Terms section 9 no longer grants the SeatGeek Entities express " +
          "third-party beneficiary status, which SeatGeek clause 4.3 requires.",
      );
    }
    if (!/section 13 \(limitation of liability\)/.test(terms)) {
      return unsatisfied(
        "The beneficiary grant no longer enumerates section 13 (limitation of " +
          "liability). An enumeration pointing away from the cap is the defect " +
          "that decided Sosa v. Onfido.",
      );
    }
    return SATISFIED;
  },
};

/**
 * The events feature must not be able to receive precise location, and the
 * privacy policy must still say so.
 *
 * SeatGeek's terms forbid personal data reaching their API. The service-side
 * control is a validator; this predicate guards the disclosure that describes
 * it, so the two cannot drift apart silently.
 */
export const privacyDisclaimsPreciseLocation: CheckablePrecondition = {
  kind: "checkable",
  id: "privacy-disclaims-precise-location",
  requirement:
    "Privacy policy section 3.6 must still disclaim precise location and state " +
    "that the events feature accepts a city name only",
  check: ({ readLegal }) => {
    const privacy = readLegal(PRIVACY);
    if (!/No precise location/.test(privacy)) {
      return unsatisfied(
        "Privacy policy section 3.6 no longer disclaims precise location, " +
          "which the events feature depends on being true.",
      );
    }
    if (!/city name only/.test(privacy)) {
      return unsatisfied(
        "Privacy policy section 3.6 no longer states that the events feature " +
          "accepts a city name only. SeatGeek's terms forbid personal data " +
          "reaching their API.",
      );
    }
    return SATISFIED;
  },
};

/**
 * Events may not be served without the credential that fetches them.
 *
 * A deployment with `SEATGEEK_ENABLED=true` and no client id would report the
 * capability as on while serving nothing, which makes every other check here a
 * statement about a feature that is not running.
 */
export const eventsCredentialPresent: CheckablePrecondition = {
  kind: "checkable",
  id: "events-credential-present",
  requirement: "SEATGEEK_CLIENT_ID must be set when SEATGEEK_ENABLED is true",
  check: ({ config }) =>
    config.SEATGEEK_CLIENT_ID === undefined
      ? unsatisfied(
          "SEATGEEK_ENABLED is true but SEATGEEK_CLIENT_ID is unset, so the " +
            "capability reports as enabled while serving nothing.",
        )
      : SATISFIED,
};

/**
 * The MusicBrainz mirror must not be used without the attribution the upstream
 * licence requires.
 */
export const musicbrainzAttributionPresent: CheckablePrecondition = {
  kind: "checkable",
  id: "musicbrainz-attribution-present",
  requirement:
    "legal/attribution.md must credit MusicBrainz when the local mirror is used",
  check: ({ readLegal }) => {
    let attribution: string;
    try {
      attribution = readLegal("legal/attribution.md");
    } catch {
      return unsatisfied(
        "legal/attribution.md is missing, and the MusicBrainz licence requires " +
          "attribution wherever its data is used.",
      );
    }
    return /MusicBrainz/i.test(attribution)
      ? SATISFIED
      : unsatisfied(
          "legal/attribution.md no longer credits MusicBrainz, which its " +
            "licence requires.",
        );
  },
};

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const LEGAL_TRIGGERS: readonly LegalTrigger[] = [
  {
    capability: "Live event data from SeatGeek",
    flag: "SEATGEEK_ENABLED",
    isEnabled: (config) => config.eventsEnabled,
    enabling: "material",
    documents: [
      "legal/terms-of-service.md#8",
      "legal/terms-of-service.md#9",
      "legal/terms-of-service.md#13",
      "legal/privacy-policy.md#3.6",
      "legal/privacy-policy.md#9.3",
    ],
    preconditions: [
      eventsCredentialPresent,
      seatgeekCapMatchesTheirs,
      seatgeekBeneficiaryGrantIntact,
      privacyDisclaimsPreciseLocation,
      {
        kind: "attested",
        id: "consent-gate-presents-documents",
        requirement:
          "A Pull.fm client must display these documents and require an " +
          "affirmative acceptance before use. SeatGeek clause 4.3 requires the " +
          "Application to display the EULA, requires each End User to accept it " +
          "before using the Application, obliges us to use all reasonable " +
          "efforts to enforce it, and separately forbids collecting information " +
          "from an End User who has not affirmatively authorised it. Enabling " +
          "events without the screen breaches that clause in three places at " +
          "once, and the third is not limited to SeatGeek data.",
        blocks: "B6",
        attestedOn: null,
        attestedBy: null,
      },
      {
        kind: "attested",
        id: "documents-published-at-stable-url",
        requirement:
          "Both documents must be served at a stable URL, byte-identical to the " +
          "canonical source, because the API refuses an acceptance whose digest " +
          "does not match the version it publishes. A rendered page whose bytes " +
          "differ makes acceptance impossible rather than merely inconsistent.",
        blocks: "B6",
        attestedOn: null,
        attestedBy: null,
      },
      {
        kind: "attested",
        id: "counsel-confirmed-seatgeek-clauses",
        requirement:
          "Counsel must confirm that sections 9 and 13 are effective under " +
          "Illinois law and satisfy SeatGeek clause 4.3, addressing whether " +
          "matching their USD 50 figure discharges it, whether 'at least as " +
          "protective' reaches conspicuousness, and whether the drafting " +
          "survives Sosa v. Onfido.",
        blocks: "B7",
        attestedOn: null,
        attestedBy: null,
      },
    ],
  },
  {
    capability: "Local MusicBrainz mirror",
    flag: "MB_LOCAL_ENABLED",
    isEnabled: (config) => config.MB_LOCAL_ENABLED,
    enabling: "cosmetic",
    documents: ["legal/attribution.md", "legal/privacy-policy.md#9.3"],
    preconditions: [musicbrainzAttributionPresent],
  },
  {
    capability: "Public API documentation",
    flag: "DOCS_ENABLED",
    isEnabled: (config) => config.DOCS_ENABLED,
    enabling: "cosmetic",
    documents: [],
    preconditions: [],
    inertBecause:
      "Serving the OpenAPI description discloses the shape of the API and no " +
      "personal information, creates no obligation to a user or an upstream " +
      "provider, and changes nothing a user agreed to. Recorded as inert rather " +
      "than omitted so that 'nothing to check' is a decision on the record.",
  },
];

// ---------------------------------------------------------------------------
// Enforcement.
// ---------------------------------------------------------------------------

/**
 * The context a running service uses.
 *
 * Legal documents are resolved through `resolveLegalRoot`, the same helper that
 * serves the canonical bytes and seeds `legal_document_revisions.content`, so
 * there is one answer to "where do the legal documents live" rather than two
 * that can disagree. `legal/` is copied into the runtime image deliberately;
 * the Dockerfile records what broke when it was not.
 */
export function realTriggerContext(config: Config): TriggerContext {
  return {
    config,
    readLegal: (relativePath) => {
      // Resolved per read rather than once, so constructing a context never
      // throws. A deployment with every gated capability switched off has no
      // reason to fail here, and the error should belong to the capability that
      // actually needed the document.
      const root = resolveLegalRoot();
      if (root === null) {
        throw new Error(
          `cannot verify legal preconditions: the legal/ directory was not ` +
            `found, so ${relativePath} cannot be read. It is copied into the ` +
            `runtime image deliberately (see apps/bff/Dockerfile); its absence ` +
            `is a packaging defect, not a reason to proceed unverified. Set ` +
            `LEGAL_SOURCE_DIR if this deployment's layout is unusual.`,
        );
      }
      return readFileSync(join(root, relativePath), "utf8");
    },
  };
}

export interface TriggerFailure {
  readonly capability: string;
  readonly flag: string;
  readonly preconditionId: string;
  readonly because: string;
}

/**
 * Evaluates every enabled capability and returns what is not satisfied.
 *
 * Disabled capabilities are not evaluated. A precondition on something that is
 * off is a statement about a hypothetical, and failing a deployment for it
 * would train people to disable the check rather than to satisfy it.
 */
export function evaluateLegalTriggers(ctx: TriggerContext): TriggerFailure[] {
  const failures: TriggerFailure[] = [];
  for (const trigger of LEGAL_TRIGGERS) {
    if (!trigger.isEnabled(ctx.config)) continue;
    for (const pre of trigger.preconditions) {
      if (pre.kind === "attested") {
        if (pre.attestedOn === null) {
          failures.push({
            capability: trigger.capability,
            flag: trigger.flag,
            preconditionId: pre.id,
            because:
              `${pre.requirement}\n    Nobody has attested this. It is tracked ` +
              `as checklist item ${pre.blocks}. To proceed, verify it and record ` +
              `attestedOn and attestedBy in legal-triggers.ts, which is a ` +
              `reviewed change rather than a configuration flip.`,
          });
        }
        continue;
      }
      const outcome = pre.check(ctx);
      if (!outcome.satisfied) {
        failures.push({
          capability: trigger.capability,
          flag: trigger.flag,
          preconditionId: pre.id,
          because: outcome.because,
        });
      }
    }
  }
  return failures;
}

/**
 * Refuses to start when an enabled capability has an unsatisfied precondition.
 *
 * Fail-closed, matching the webhook signing secret: the failure mode of a
 * forgotten step must be "off", because the alternative is a service that
 * breaches an upstream agreement quietly and for as long as nobody looks.
 */
export function assertLegalTriggersSatisfied(ctx: TriggerContext): void {
  const failures = evaluateLegalTriggers(ctx);
  if (failures.length === 0) return;
  const detail = failures
    .map(
      (f) =>
        `  ${f.flag} (${f.capability})\n    [${f.preconditionId}] ${f.because}`,
    )
    .join("\n\n");
  throw new Error(
    `refusing to start: ${failures.length} legal precondition(s) are not ` +
      `satisfied for capabilities that are switched on.\n\n${detail}\n\n` +
      `Each of these is a condition of a published legal document or an ` +
      `upstream agreement, not an engineering preference. Turn the capability ` +
      `off, or satisfy the condition.`,
  );
}
