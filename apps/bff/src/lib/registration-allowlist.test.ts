/**
 * The closed-beta allowlist, at the level of the decision and the parse.
 *
 * test/security/registration-allowlist.test.ts proves the gate is WIRED to the
 * routes that form an account, that it runs before the identity provider is
 * touched, and that its refusal is not an oracle. This file proves the two pure
 * functions underneath it are RIGHT, which is a different question over a much
 * larger space of inputs than it is worth driving through HTTP.
 *
 * Three groups here carry more weight than the rest:
 *
 *   THE WIDENING CASES. `owner+anything@`, `o.w.n.e.r@` and `owner@sub.example.test` must
 *   NOT be admitted by an entry that says `owner@example.test`. Every one of them is
 *   a way an allowlist can silently admit an address nobody put on it, which is
 *   the failure mode that cannot be recovered from: the account exists and the
 *   collection has happened. The opposite failure - refusing the owner until he
 *   writes the exact address - is one variable edit.
 *
 *   THE SET-BUT-EMPTY VALUE. `AUTH_REGISTRATION_ALLOWLIST=" "` is the only typo
 *   in this feature that fails in the PERMISSIVE direction, because a list that
 *   collapses to nothing means open. It has to be a startup failure, and there is
 *   a test for it, because "looks configured, is open" is precisely the shape of
 *   the problem the allowlist was added to fix.
 *
 *   THE AGREEMENT WITH `normalizeEmail`. `MagicAuthService.requestCode` hands
 *   WorkOS the value `normalizeEmail` produced. If this module folded addresses
 *   differently, an address could be admitted in one form and a directory record
 *   created in another, and the two would drift the first time either was
 *   touched. The functions are deliberately separate (a pure `lib/` module must
 *   not drag ioredis in through `services/magic-auth.ts`), so the agreement is
 *   PINNED BY A TEST rather than by a comment.
 *
 * `loadConfig` is exercised here rather than in config.test.ts because the parse
 * lives in this module and the schema is a thin adapter over it; testing the
 * adapter next to the thing it adapts is what keeps them from disagreeing.
 */

import { describe, expect, test } from "vitest";

import { loadConfig } from "../config.js";
import { normalizeEmail } from "../services/magic-auth.js";
import {
  decideRegistrationAllowlist,
  normaliseAddress,
  parseRegistrationAllowlist,
} from "./registration-allowlist.js";

/**
 * A stand-in for the one address the closed beta is for.
 *
 * A PLACEHOLDER, NOT THE REAL ADDRESS, and not merely out of taste: this
 * repository is public and tools/check-public-identifiers.mjs fails CI on a named
 * human's address in a tracked file, on the grounds that an inbox is the target of
 * every account-recovery and phishing path around the technical controls. Nothing
 * here depends on the value, only on its shape.
 */
const OWNER = "owner@example.test";

/** A list in force, built through the real parse rather than by hand. */
function listOf(raw: string): ReadonlySet<string> {
  const { addresses, problems } = parseRegistrationAllowlist(raw);
  expect(problems, `parse rejected ${JSON.stringify(raw)}`).toEqual([]);
  return addresses;
}

const inForce = listOf(OWNER);
const open: ReadonlySet<string> = new Set<string>();

describe("an empty list means open, which is the launch state", () => {
  test("admits any address at all", () => {
    // The default has to be open. A control that must be switched OFF on launch
    // day is a control that gets forgotten in the direction that refuses every
    // real user, reported by a counter nobody watches. The argument in full is at
    // the top of registration-allowlist.ts.
    for (const email of [
      OWNER,
      "someone@example.test",
      "totally.unrelated@elsewhere.invalid",
    ]) {
      const decision = decideRegistrationAllowlist(email, open);
      expect(decision.allowed, `${email} was refused`).toBe(true);
      expect(decision.reason).toBe("open");
    }
  });

  test("an empty address is admitted too, because nothing is being checked", () => {
    // Consistency matters more than a special case here: with no list in force
    // there is no comparison to make, so there is no branch that could treat one
    // address differently from another.
    expect(decideRegistrationAllowlist("", open).allowed).toBe(true);
  });
});

describe("a list in force", () => {
  test("admits the address on it", () => {
    const decision = decideRegistrationAllowlist(OWNER, inForce);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowlisted");
  });

  test("refuses an address that is not on it", () => {
    const decision = decideRegistrationAllowlist(
      "stranger@example.test",
      inForce,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("not-allowlisted");
  });

  test("refuses an absent or empty address, so the nullable case fails closed", () => {
    // `GET /v1/auth/callback` reads the address off the provider's response,
    // where it is nullable, and passes `?? ""`. That path must not be a way in.
    for (const email of ["", "   ", "\t\n"]) {
      expect(
        decideRegistrationAllowlist(email, inForce).allowed,
        `${JSON.stringify(email)} was admitted`,
      ).toBe(false);
    }
  });

  test("admits every case and whitespace variant of a listed address", () => {
    // The same person in every mail system in service. Refusing the owner because
    // his keyboard capitalised a letter, or because the address arrived from a
    // clipboard with a space on it, is a support ticket rather than a control.
    for (const variant of [
      "Owner@Example.Test",
      "OWNER@EXAMPLE.TEST",
      "  owner@example.test",
      "owner@example.test\t",
      "\n owner@EXAMPLE.test \n",
    ]) {
      expect(
        decideRegistrationAllowlist(variant, inForce).allowed,
        `${JSON.stringify(variant)} was refused`,
      ).toBe(true);
    }
  });

  test("admits a listed address written in a different case IN THE LIST", () => {
    // The folding happens on the way into the set as well as on the way in from
    // the wire. Otherwise an operator who typed a capital would produce an entry
    // no request could ever match, which is the lockout the parse exists to catch
    // and would be a silent version of it.
    const shouty = listOf("  OWNER@Example.TEST  ");
    expect([...shouty]).toEqual([OWNER]);
    expect(decideRegistrationAllowlist(OWNER, shouty).allowed).toBe(true);
  });

  test("REFUSES A PLUS TAG, and that is the whole argument for not stripping", () => {
    // At Gmail this really is the same mailbox, and refusing it is a small
    // inconvenience fixed by writing the exact address on the list. Stripping it
    // would mean an entry reading `owner@example.test` silently admits every
    // `owner+anything@example.test` a stranger cares to invent - an allowlist
    // WIDENED by a client-controlled string, which is not an allowlist.
    for (const tagged of [
      "owner+seatgeek@example.test",
      "owner+@example.test",
      "owner+OWNER@example.test",
    ]) {
      expect(
        decideRegistrationAllowlist(tagged, inForce).allowed,
        `${tagged} was admitted`,
      ).toBe(false);
    }
  });

  test("REFUSES a dotted local part, for the same reason", () => {
    for (const dotted of ["o.wner@example.test", "o.w.n.e.r@example.test"]) {
      expect(
        decideRegistrationAllowlist(dotted, inForce).allowed,
        `${dotted} was admitted`,
      ).toBe(false);
    }
  });

  test("refuses lookalike domains rather than matching loosely", () => {
    // A substring or suffix comparison would admit all of these. Membership of a
    // set of normalised strings admits none of them.
    for (const near of [
      "owner@example.test.example.test",
      "owner@sub.example.test",
      "owner@example.invalid",
      "ownerowner@example.test",
      "notowner@example.test",
      "owner@xample.test",
    ]) {
      expect(
        decideRegistrationAllowlist(near, inForce).allowed,
        `${near} was admitted`,
      ).toBe(false);
    }
  });

  test("admits any of several listed addresses and nothing beside them", () => {
    const two = listOf(`${OWNER},ope@312.dev`);
    expect(two.size).toBe(2);
    expect(decideRegistrationAllowlist(OWNER, two).allowed).toBe(true);
    expect(decideRegistrationAllowlist("ope@312.dev", two).allowed).toBe(true);
    expect(decideRegistrationAllowlist("ops@312.dev", two).allowed).toBe(false);
  });
});

describe("parsing what an operator wrote", () => {
  test("an empty string is open, silently, because that is the documented way", () => {
    const parsed = parseRegistrationAllowlist("");
    expect(parsed.addresses.size).toBe(0);
    expect(parsed.problems).toEqual([]);
  });

  test("tolerates the whitespace and trailing commas a shell heredoc produces", () => {
    const parsed = parseRegistrationAllowlist(` ${OWNER} , ope@312.dev ,, \n`);
    expect(parsed.problems).toEqual([]);
    expect([...parsed.addresses].sort()).toEqual(["ope@312.dev", OWNER].sort());
  });

  test("deduplicates, including across case", () => {
    const parsed = parseRegistrationAllowlist(`${OWNER},OWNER@EXAMPLE.TEST`);
    expect(parsed.problems).toEqual([]);
    expect(parsed.addresses.size).toBe(1);
  });

  test("REPORTS a value that is set and names nobody, which would mean OPEN", () => {
    // THE ONE THAT MATTERS MOST IN THIS GROUP. Every other bad value fails in the
    // safe direction. This one looks configured and is open.
    for (const raw of [" ", ",", ",,", "\t", "  ,  "]) {
      const parsed = parseRegistrationAllowlist(raw);
      expect(parsed.addresses.size).toBe(0);
      expect(
        parsed.problems,
        `${JSON.stringify(raw)} was accepted`,
      ).toHaveLength(1);
      expect(parsed.problems[0]?.why).toMatch(/names no address/);
    }
  });

  test("REPORTS an entry that can never match anything", () => {
    // The lib/registration-geo.ts lesson: `UK` and `EL` are codes Cloudflare will
    // never send, so listing them reads as coverage and is not. An entry with no
    // `@` is the same defect - it would sit in the list looking like the owner is
    // admitted while every one of his requests was refused.
    const cases: readonly [string, RegExp][] = [
      ["owner", /no @/],
      ["owner@", /no domain/],
      ["@example.test", /no local part/],
      ["owner@@example.test", /more than one @/],
      ["owner@localhost", /no dot/],
      [`${OWNER} ope@312.dev`, /whitespace/],
    ];
    for (const [raw, why] of cases) {
      const parsed = parseRegistrationAllowlist(raw);
      expect(parsed.problems, `${raw} was accepted`).toHaveLength(1);
      expect(parsed.problems[0]?.why).toMatch(why);
    }
  });

  test("reports the bad entry without dropping the good ones on the floor", () => {
    // The caller turns any problem into a startup failure, so what matters is that
    // the report is complete enough for an operator to fix in one pass rather than
    // one restart per typo. Same property config.ts already gives missing
    // variables.
    const parsed = parseRegistrationAllowlist(
      `${OWNER},nonsense,also-nonsense`,
    );
    expect([...parsed.addresses]).toEqual([OWNER]);
    expect(parsed.problems).toHaveLength(2);
  });
});

describe("the configuration adapter", () => {
  const KEK = Buffer.alloc(32, 3).toString("base64");

  function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
      REDIS_URL: "redis://127.0.0.1:6379",
      REDIS_QUOTA_URL: "redis://127.0.0.1:6380",
      CREDENTIAL_KEKS: `kek:v1=${KEK}`,
      CREDENTIAL_ACTIVE_KEK_ID: "kek:v1",
      WORKOS_CLIENT_ID: "client_01ABC",
      WORKOS_API_KEY: "sk_test_not_a_real_key",
      MUSICBRAINZ_USER_AGENT: "PullFM/0.1.0 (ops@example.com)",
      ...overrides,
    };
  }

  test("defaults to an empty list, which is open", () => {
    expect(loadConfig(baseEnv()).AUTH_REGISTRATION_ALLOWLIST.size).toBe(0);
  });

  test("parses and normalises the variable an operator sets", () => {
    const cfg = loadConfig(
      baseEnv({ AUTH_REGISTRATION_ALLOWLIST: ` Owner@Example.TEST ` }),
    );
    expect([...cfg.AUTH_REGISTRATION_ALLOWLIST]).toEqual([OWNER]);
  });

  test("REFUSES TO START on an entry that can never match", () => {
    // A misspelled kill switch is a kill switch that does nothing.
    // `providerListSchema` takes the same position, and this is the same hazard
    // one layer over: a lockout discovered at the first sign-in instead of at
    // boot.
    expect(() =>
      loadConfig(baseEnv({ AUTH_REGISTRATION_ALLOWLIST: "owner" })),
    ).toThrow(/no @/);
  });

  test("REFUSES TO START on a value that is set but names nobody", () => {
    // Because the alternative is booting an OPEN service out of a variable that
    // was set in order to close one.
    expect(() =>
      loadConfig(baseEnv({ AUTH_REGISTRATION_ALLOWLIST: " " })),
    ).toThrow(/names no address/);
  });

  test("names the way out in the failure, rather than only the fault", () => {
    expect(() =>
      loadConfig(baseEnv({ AUTH_REGISTRATION_ALLOWLIST: "," })),
    ).toThrow(/Leave the variable empty to accept everyone/);
  });
});

describe("agreement with the normaliser the provider call uses", () => {
  test("folds addresses exactly as services/magic-auth.ts does", () => {
    // LOAD-BEARING, NOT COSMETIC. `requestCode` sends WorkOS the value
    // `normalizeEmail` produced, so a disagreement here means an address could be
    // admitted in one form and a WorkOS user created in another. The two are
    // separate functions on purpose - a pure lib module must not import a service
    // and drag ioredis in at load time - so this test is what holds them
    // together, and it will fail the moment either is touched alone.
    for (const raw of [
      OWNER,
      "Owner@Example.TEST",
      "  owner@example.test  ",
      "\tOWNER@example.TEST\n",
      "owner+tag@example.test",
      "o.w.n.e.r@example.test",
      "",
      "   ",
      "no-at-sign",
      "Mixed.Case+Tag@Sub.Example.Test",
    ]) {
      expect(normaliseAddress(raw), `disagreed on ${JSON.stringify(raw)}`).toBe(
        normalizeEmail(raw),
      );
    }
  });
});
