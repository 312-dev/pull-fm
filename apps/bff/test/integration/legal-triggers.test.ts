/**
 * Tests for the legal trigger registry.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE ENFORCES ON ITSELF
 *
 * A precondition is worth exactly as much as its ability to fail. A predicate
 * that returns `satisfied: true` unconditionally passes every test written the
 * obvious way, reports success forever, and checks nothing. That defect has
 * been found repeatedly in this repository and it is the reason the legal suite
 * already carries "a real edit IS an amendment, so the check is not vacuous".
 *
 * So every checkable precondition here is tested twice: once against the real
 * documents, to prove it does not fail a correct system, and once against a
 * mutated copy, to prove it fails a broken one. A predicate with only the first
 * test is indistinguishable from `() => SATISFIED`.
 *
 * The registry is enumerated rather than listed by hand, so a predicate added
 * later without a mutation test fails this suite instead of slipping through.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { loadConfig, type Config } from "../../src/config.js";
import {
  assertLegalTriggersSatisfied,
  evaluateLegalTriggers,
  LEGAL_TRIGGERS,
  type CheckablePrecondition,
  type LegalTrigger,
  type TriggerContext,
} from "../../src/lib/legal-triggers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");

const readReal = (relative: string): string =>
  readFileSync(join(REPO, relative), "utf8");

/** A configuration with every legally triggered capability switched off. */
function baseConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DEPLOY_ENV: "local",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://u:p@127.0.0.1:5432/pullfm_triggers",
    REDIS_URL: "redis://127.0.0.1:6379",
    REDIS_QUOTA_URL: "redis://127.0.0.1:6380",
    CREDENTIAL_KEKS: `kek:triggers=${Buffer.alloc(32, 1).toString("base64")}`,
    CREDENTIAL_ACTIVE_KEK_ID: "kek:triggers",
    WORKOS_CLIENT_ID: "client_triggers",
    WORKOS_API_KEY: "sk_test_triggers_only",
    MUSICBRAINZ_USER_AGENT: "PullFM/0.1.0 (triggers@pull.fm)",
    SEATGEEK_ENABLED: "false",
    MB_LOCAL_ENABLED: "false",
    DOCS_ENABLED: "false",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function ctx(
  config: Config,
  readLegal: (p: string) => string = readReal,
): TriggerContext {
  return { config, readLegal };
}

/** Reads the real document, applies one substitution, returns the rest intact. */
function mutating(
  path: string,
  find: string | RegExp,
  replace: string,
): (p: string) => string {
  return (requested) => {
    const raw = readReal(requested);
    if (requested !== path) return raw;
    const next = raw.replace(find as RegExp, replace);
    if (next === raw) {
      throw new Error(
        `mutation of ${path} changed nothing: the fixture no longer matches ` +
          `the document, so any test using it proves nothing`,
      );
    }
    return next;
  };
}

const checkable = (t: LegalTrigger): CheckablePrecondition[] =>
  t.preconditions.filter(
    (p): p is CheckablePrecondition => p.kind === "checkable",
  );

const allCheckable = LEGAL_TRIGGERS.flatMap(checkable);

// ---------------------------------------------------------------------------

describe("the trigger registry is well formed", () => {
  test("capability and flag names are unique", () => {
    const flags = LEGAL_TRIGGERS.map((t) => t.flag);
    expect(new Set(flags).size).toBe(flags.length);
    const names = LEGAL_TRIGGERS.map((t) => t.capability);
    expect(new Set(names).size).toBe(names.length);
  });

  test("precondition ids are unique across the whole registry", () => {
    // Ids appear in startup failures and in the checklist. Two preconditions
    // sharing one id makes a failure message ambiguous about which broke.
    const ids = LEGAL_TRIGGERS.flatMap((t) => t.preconditions.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a capability with no preconditions says why it has none", () => {
    // "Nothing to check" must be a decision on the record. Without this, an
    // unfinished entry and a deliberately inert one look identical.
    for (const t of LEGAL_TRIGGERS) {
      if (t.preconditions.length === 0) {
        expect(
          t.inertBecause,
          `${t.flag} has no preconditions and no inertBecause`,
        ).toBeTruthy();
        expect(t.inertBecause!.length).toBeGreaterThan(40);
      }
    }
  });

  test("a capability WITH preconditions does not also claim to be inert", () => {
    for (const t of LEGAL_TRIGGERS) {
      if (t.preconditions.length > 0) {
        expect(t.inertBecause, `${t.flag} is both gated and inert`).toBe(
          undefined,
        );
      }
    }
  });

  test("every document a trigger names exists on disk", () => {
    for (const t of LEGAL_TRIGGERS) {
      for (const ref of t.documents) {
        const file = ref.split("#")[0]!;
        expect(
          existsSync(join(REPO, file)),
          `${t.flag} names ${file}, which does not exist`,
        ).toBe(true);
      }
    }
  });

  test("attested preconditions name a checklist item and are self-consistent", () => {
    const checklist = readReal("docs/compliance/publication-checklist.md");
    for (const t of LEGAL_TRIGGERS) {
      for (const p of t.preconditions) {
        if (p.kind !== "attested") continue;
        expect(p.blocks, `${p.id} has no checklist reference`).toMatch(
          /^[A-F]\d+$/,
        );
        expect(
          checklist.includes(`### ${p.blocks}.`) ||
            checklist.includes(`| ${p.blocks} `),
          `${p.id} points at checklist item ${p.blocks}, which is not in the checklist`,
        ).toBe(true);
        // An attestation without a name is an unsigned one.
        if (p.attestedOn === null) {
          expect(p.attestedBy, `${p.id} has a signer but no date`).toBe(null);
        } else {
          expect(p.attestedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(p.attestedBy, `${p.id} is attested but unsigned`).toBeTruthy();
        }
      }
    }
  });

  test("every requirement is a sentence somebody could act on", () => {
    for (const t of LEGAL_TRIGGERS) {
      for (const p of t.preconditions) {
        expect(
          p.requirement.length,
          `${p.id} requirement is too terse`,
        ).toBeGreaterThan(40);
      }
    }
  });
});

describe("every environment flag is mapped to a trigger", () => {
  test("no *_ENABLED flag exists without a registry entry", () => {
    // The catch for the feature nobody thought was a legal event. Parsing the
    // schema rather than a hand-kept list means a new flag cannot be added
    // without either mapping it or failing here.
    const config = readReal("apps/bff/src/config.ts");
    const declared = [
      ...config.matchAll(/^ {2}([A-Z][A-Z0-9_]*_ENABLED):/gm),
    ].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);

    const mapped = new Set(LEGAL_TRIGGERS.map((t) => t.flag));
    const unmapped = declared.filter((f) => !mapped.has(f));
    expect(
      unmapped,
      `these flags have no legal trigger entry: ${unmapped.join(", ")}. ` +
        `Add one, marking it inert with a reason if switching it on creates ` +
        `no obligation.`,
    ).toEqual([]);
  });

  test("the registry does not map a flag that no longer exists", () => {
    const config = readReal("apps/bff/src/config.ts");
    for (const t of LEGAL_TRIGGERS) {
      expect(
        config.includes(`${t.flag}:`),
        `${t.flag} is mapped but is not declared in config.ts`,
      ).toBe(true);
    }
  });
});

describe("preconditions pass against the real repository", () => {
  test.each(allCheckable.map((p) => [p.id, p] as const))(
    "%s is satisfied by the documents as they stand",
    (_id, p) => {
      // Every capability is off here, so this proves the predicate does not
      // fail a correct system. The mutation tests below prove it can fail.
      const outcome = p.check(
        ctx(baseConfig({ SEATGEEK_CLIENT_ID: "sg_client" })),
      );
      expect(outcome.satisfied, outcome.satisfied ? "" : outcome.because).toBe(
        true,
      );
    },
  );
});

describe("preconditions fail when the thing they protect is broken", () => {
  // One case per checkable predicate. The `expectedFailures` list is compared
  // against the registry at the end, so a predicate added without a case here
  // fails the suite rather than going untested.
  const cases: Array<{
    id: string;
    context: TriggerContext;
  }> = [
    {
      id: "events-credential-present",
      context: ctx(baseConfig()), // SEATGEEK_CLIENT_ID unset
    },
    {
      id: "seatgeek-cap-is-fifty",
      context: ctx(
        baseConfig({ SEATGEEK_CLIENT_ID: "sg" }),
        mutating(
          "legal/terms-of-service.md",
          /FIFTY UNITED STATES\s+DOLLARS \(USD 50\.00\)/,
          "ONE HUNDRED UNITED STATES DOLLARS (USD 100.00)",
        ),
      ),
    },
    {
      id: "seatgeek-beneficiary-grant-intact",
      context: ctx(
        baseConfig({ SEATGEEK_CLIENT_ID: "sg" }),
        mutating(
          "legal/terms-of-service.md",
          /section 13 \(limitation of liability\)/,
          "section 12 (limitation of liability)",
        ),
      ),
    },
    {
      id: "privacy-disclaims-precise-location",
      context: ctx(
        baseConfig({ SEATGEEK_CLIENT_ID: "sg" }),
        mutating("legal/privacy-policy.md", /city name only/, "coordinates"),
      ),
    },
    {
      id: "musicbrainz-attribution-present",
      context: ctx(
        baseConfig(),
        // Case-insensitive on purpose. The document carries 13 occurrences of
        // "MusicBrainz" and 5 lowercase ones inside URLs, and the predicate
        // matches case-insensitively because that is the right test for an
        // attribution. Replacing only the exact-case occurrences left the
        // predicate satisfied and this mutation proving nothing, which the
        // suite caught.
        mutating("legal/attribution.md", /MusicBrainz/gi, "SomeOtherDatabase"),
      ),
    },
  ];

  test.each(cases.map((c) => [c.id, c] as const))(
    "%s fails against a mutated input",
    (id, c) => {
      const p = allCheckable.find((x) => x.id === id);
      expect(p, `no checkable precondition with id ${id}`).toBeDefined();
      const outcome = p!.check(c.context);
      expect(
        outcome.satisfied,
        `${id} still reported success against a document that breaks it, ` +
          `which means it checks nothing`,
      ).toBe(false);
      if (!outcome.satisfied) {
        // A failure nobody can act on is barely better than no failure.
        expect(outcome.because.length).toBeGreaterThan(40);
      }
    },
  );

  test("every checkable precondition has a mutation case", () => {
    const covered = new Set(cases.map((c) => c.id));
    const uncovered = allCheckable
      .map((p) => p.id)
      .filter((id) => !covered.has(id));
    expect(
      uncovered,
      `these predicates are never proved able to fail: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });
});

describe("enforcement", () => {
  test("a capability that is off is not evaluated", () => {
    // Failing a deployment over a precondition on something switched off would
    // train people to delete the check rather than satisfy it.
    const failures = evaluateLegalTriggers(ctx(baseConfig()));
    expect(failures).toEqual([]);
    expect(() => assertLegalTriggersSatisfied(ctx(baseConfig()))).not.toThrow();
  });

  test("enabling events today is refused, because the consent gate does not exist", () => {
    // This is the finding the whole registry exists to make mechanical. Three
    // attested preconditions are unsatisfied, and the most important of them is
    // that no client presents the documents, which on the day events are
    // enabled breaches SeatGeek clause 4.3 in three places at once.
    const config = baseConfig({
      SEATGEEK_ENABLED: "true",
      SEATGEEK_CLIENT_ID: "sg_client",
    });
    const failures = evaluateLegalTriggers(ctx(config));
    const ids = failures.map((f) => f.preconditionId);
    expect(ids).toContain("consent-gate-presents-documents");
    expect(ids).toContain("documents-published-at-stable-url");
    expect(ids).toContain("counsel-confirmed-seatgeek-clauses");
    expect(() => assertLegalTriggersSatisfied(ctx(config))).toThrow(
      /refusing to start/,
    );
  });

  test("the refusal names the flag, the capability and what to do", () => {
    const config = baseConfig({
      SEATGEEK_ENABLED: "true",
      SEATGEEK_CLIENT_ID: "sg_client",
    });
    let message = "";
    try {
      assertLegalTriggersSatisfied(ctx(config));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("SEATGEEK_ENABLED");
    expect(message).toContain("Live event data from SeatGeek");
    expect(message).toContain("B6");
    expect(message).toContain(
      "Turn the capability off, or satisfy the condition",
    );
  });

  test("a broken document fails a capability that is on", () => {
    // The MusicBrainz mirror has one checkable precondition and no attested
    // ones, so it is the clean case for proving that enabling something with a
    // broken document is refused.
    const config = baseConfig({ MB_LOCAL_ENABLED: "true" });
    expect(() => assertLegalTriggersSatisfied(ctx(config))).not.toThrow();
    expect(() =>
      assertLegalTriggersSatisfied(
        ctx(
          config,
          // Case-insensitive on purpose. The document carries 13 occurrences of
          // "MusicBrainz" and 5 lowercase ones inside URLs, and the predicate
          // matches case-insensitively because that is the right test for an
          // attribution. Replacing only the exact-case occurrences left the
          // predicate satisfied and this mutation proving nothing, which the
          // suite caught.
          mutating(
            "legal/attribution.md",
            /MusicBrainz/gi,
            "SomeOtherDatabase",
          ),
        ),
      ),
    ).toThrow(/musicbrainz-attribution-present/);
  });

  test("an inert capability can be switched on freely", () => {
    expect(() =>
      assertLegalTriggersSatisfied(ctx(baseConfig({ DOCS_ENABLED: "true" }))),
    ).not.toThrow();
  });
});
