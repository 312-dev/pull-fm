/**
 * Registration allowlist: the closed-beta gate on who may form an account.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG, MEASURED RATHER THAN ASSUMED
 *
 * The legal position this project currently relies on is that the owner is the
 * ONLY End User of the API. That premise does real work: SeatGeek's API terms
 * clause 4.3 requires an Application to show its End Users an EULA and obtain
 * acceptance before they use it, and the clause exists to extend SeatGeek's
 * protection to people who never signed the API Terms themselves. If the only
 * End User is the party already bound by those terms, the clause has nothing
 * left to do. The same reasoning defuses `Sgouros v. TransUnion`: there is no
 * third party whose assent is missing, because there is no third party.
 *
 * On 2026-07-29 that premise was true BY COINCIDENCE AND NOT BY DESIGN. Two
 * facts, both verified rather than inferred:
 *
 *   The US staging database held ZERO user rows.
 *   There was NO allowlist anywhere in config.ts or in routes/v1/auth.ts.
 *
 * `api-staging.pull.fm` answers on the public internet and signs people in with
 * a magic link, so anyone who knew the hostname and had a mailbox could open an
 * account. The moment one did, three of clause 4.3's duties would attach to that
 * person RETROACTIVELY, because the collection would already have happened
 * before any acceptance existed. "Nobody has signed up yet" is a hope. This
 * module turns it into a control.
 *
 * ---------------------------------------------------------------------------
 * THIS IS TEMPORARY, AND IT COMES OFF DELIBERATELY OR NOT AT ALL
 *
 * The allowlist is not a permanent feature. It is the stand-in for a client that
 * presents the Terms and records acceptance, which is the remaining `[OPEN]` in
 * legal/terms-of-service.md section 1. When that client exists, the correct
 * change is to EMPTY this list, not to widen it one address at a time: a list
 * with five friends on it is a list of five people whose assent is still
 * missing, which is the exact exposure the list was added to close.
 *
 * ---------------------------------------------------------------------------
 * EMPTY MEANS OPEN, AND THE DEFAULT IS ARGUED RATHER THAN CONVENIENT
 *
 * An empty list admits everyone. That is the opposite of the direction
 * `SEATGEEK_ENABLED` was corrected in, so the difference has to be stated:
 *
 *   `SEATGEEK_ENABLED` defaults OFF because turning it on is the act that puts
 *   the deployment in breach. The failure mode of forgetting it must be "no
 *   feature", because the alternative is "silent breach".
 *
 *   This list defaults OPEN because emptying it is the LAUNCH state. A control
 *   that has to be explicitly switched off on launch day is a control that gets
 *   forgotten in the wrong direction: the forgotten form would be a sign-up
 *   route that refuses every real user, reported by a counter nobody is
 *   watching, on the one day the project cannot afford a silent outage. It
 *   would also refuse every sign-in on every developer's laptop and in every
 *   integration suite, and a control that has to be disabled to work on the
 *   application is a control that gets disabled.
 *
 * BE HONEST ABOUT WHERE THAT LEAVES THE ENFORCEMENT. It means the app-level
 * default is NOT the thing keeping staging shut; the DEPLOYMENT is.
 * infra/lib/secrets.sh writes a non-empty `AUTH_REGISTRATION_ALLOWLIST` into
 * every rendered `bff.env`, and its own default is the operations address rather
 * than an empty string, so a converge that forgets the override still produces a
 * CLOSED deployment whose only cost is that the owner cannot sign in until he
 * fixes it. The residual, named rather than discovered later: a deployment that
 * renders its own env file without going through that function gets an open
 * service. The compensating control is that `SEATGEEK_ENABLED` is false by
 * default, so such a deployment is open to sign-ups while serving no SeatGeek
 * data at all, and clause 4.3 has no material to attach to.
 *
 * ---------------------------------------------------------------------------
 * ONE PARSE AND ONE COMPARISON, READ BY THE ENFORCEMENT AND BY THE TESTS
 *
 * `parseRegistrationAllowlist` is the only place the environment string is
 * turned into a set, and config.ts's schema is a thin adapter over it rather
 * than a second parser. `decideRegistrationAllowlist` is the only comparison.
 * The suite imports both, so there is no retyped copy of either that could
 * agree with itself while disagreeing with the running code.
 */

/**
 * Why an address was admitted or refused. Counted and logged, never returned.
 *
 * NONE OF THESE REACH THE CLIENT, and that is deliberate. `open` and
 * `allowlisted` are indistinguishable to a caller because both produce the
 * normal 202, and `not-allowlisted` produces one uniform refusal that says
 * nothing about the address. See `errors.registrationClosed()`.
 */
export type AllowlistReason =
  /** The list is empty, so the gate is not in force on this deployment. */
  | "open"
  /** The list is in force and the address is on it. */
  | "allowlisted"
  /** The list is in force and the address is not on it. */
  | "not-allowlisted";

export interface AllowlistDecision {
  readonly allowed: boolean;
  readonly reason: AllowlistReason;
}

/**
 * Reduces an address to the form the list is compared against.
 *
 * ---------------------------------------------------------------------------
 * TRIM AND CASE-FOLD. DELIBERATELY NOT DOT-STRIPPING OR PLUS-TAG-STRIPPING.
 *
 * Case folding, because `Gray@Example.com` and `gray@example.com` are the same
 * person in every practical mail system. Strictly, RFC 5321 makes only the
 * DOMAIN case-insensitive and leaves the local part to the receiving host, but
 * no mailbox provider in service treats them as two people, and an allowlist
 * that refused the owner because his keyboard capitalised the first letter would
 * be a support ticket rather than a control. Trimming, because a copied address
 * arrives with a leading space often enough to matter.
 *
 * Gmail-style canonicalisation is the interesting question and the answer is NO,
 * for a reason that is STRONGER here than it is in services/magic-auth.ts, where
 * the same decision was already taken for the budget keys:
 *
 *   There, the argument against it is that dots and plus tags are Gmail
 *   behaviours, and applying them everywhere merges genuinely distinct mailboxes
 *   at hosts that do not work that way - so two people could end up sharing one
 *   account.
 *
 *   Here, the argument is that both transformations WIDEN AN ACCESS-CONTROL LIST
 *   in response to a client-controlled string. Strip plus tags and
 *   `gray+anyone@grayada.ms` is admitted by an entry that says `gray@grayada.ms`;
 *   strip dots and `g.r.a.y@…` is too. An allowlist that admits addresses nobody
 *   put on it is not an allowlist. The failure it would cause is silent and
 *   unrecoverable - the account exists, the collection happened - whereas the
 *   failure this choice causes is that the owner must write the exact address he
 *   intends to use, which is loud, immediate, and fixed by editing one variable.
 *
 * The two normalisers therefore have IDENTICAL semantics by intent, and
 * registration-allowlist.test.ts pins them together across a table of inputs
 * rather than leaving the agreement to a comment. That agreement is load-bearing
 * and not cosmetic: `MagicAuthService.requestCode` hands WorkOS the value
 * `normalizeEmail` produced, so if this function folded differently, an address
 * could be admitted in one form and a directory record created in another.
 *
 * It is not defined by importing `normalizeEmail`, because that would make a
 * pure `lib/` module depend on `services/magic-auth.ts` and drag ioredis into it
 * at load time. A test is the cheaper way to buy the same guarantee.
 */
export function normaliseAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** An entry the operator wrote that cannot be part of a working list. */
export interface AllowlistEntryProblem {
  /** The offending entry, as normalised. Echoed only into a startup error. */
  readonly entry: string;
  readonly why: string;
}

export interface ParsedAllowlist {
  /** Normalised, deduplicated. Empty means the gate is not in force. */
  readonly addresses: ReadonlySet<string>;
  /**
   * Everything wrong with what the operator wrote.
   *
   * Returned rather than thrown so the caller decides the consequence.
   * config.ts turns a non-empty array into a STARTUP FAILURE; see the argument
   * on `parseRegistrationAllowlist`.
   */
  readonly problems: readonly AllowlistEntryProblem[];
}

/**
 * Turns the environment string into the set the gate compares against.
 *
 * ---------------------------------------------------------------------------
 * A MALFORMED LIST IS A STARTUP FAILURE, NOT A SILENTLY SHORTER LIST
 *
 * This is the `providerListSchema` lesson applied to a security control: a
 * misspelled kill switch is a kill switch that does nothing, and it is worse
 * than no switch because it has been budgeted for. Two shapes are refused, and
 * they fail in opposite directions:
 *
 *   AN ENTRY THAT CANNOT MATCH. `AUTH_REGISTRATION_ALLOWLIST=gray` names no
 *   mailbox, so it can never equal a normalised address. Ignoring it would leave
 *   a list that READS as though it covers the owner and refuses him at runtime.
 *   That is the same defect as `UK` and `EL` in lib/registration-geo.ts: a value
 *   listed under a name the comparison can never see. It fails LOUD and CLOSED,
 *   which is the safe direction, but it fails at the worst moment, so it is
 *   caught at boot instead.
 *
 *   A VALUE THAT WAS SET AND NAMES NOBODY. `AUTH_REGISTRATION_ALLOWLIST=" "` or
 *   `=","` collapses to the empty set, which means OPEN. This is the dangerous
 *   typo, because it fails in the permissive direction and looks configured. An
 *   operator who typed something intended to close registration must not get an
 *   open service out of it. A truly EMPTY string is a different statement - it
 *   is the launch default and the documented way to say "open" - so it is
 *   accepted in silence.
 *
 * Blank segments produced by a trailing comma are skipped rather than reported,
 * because a shell heredoc produces them and they express no intent. That matches
 * `providerListSchema`, which does the same for the same reason.
 */
export function parseRegistrationAllowlist(raw: string): ParsedAllowlist {
  const addresses = new Set<string>();
  const problems: AllowlistEntryProblem[] = [];

  for (const segment of raw.split(",")) {
    const entry = normaliseAddress(segment);
    if (entry === "") continue;
    const why = whyNotAnAddress(entry);
    if (why !== null) {
      problems.push({ entry, why });
      continue;
    }
    addresses.add(entry);
  }

  if (raw !== "" && addresses.size === 0 && problems.length === 0) {
    problems.push({
      entry: raw,
      why:
        "the variable is set but names no address, which would leave registration OPEN. " +
        "Set it to an empty string to mean that deliberately.",
    });
  }

  return { addresses, problems };
}

/**
 * Whether an entry could ever equal a normalised address, or why not.
 *
 * DELIBERATELY NOT AN EMAIL VALIDATOR. RFC 5321 addresses are far stranger than
 * anything this could usefully assert, and the route already applies JSON
 * Schema's `format: email` to what a caller sends. All this has to catch is the
 * class of operator typo that produces an entry no comparison can ever match,
 * so it checks exactly that and nothing more.
 */
function whyNotAnAddress(entry: string): string | null {
  // FIRST, and the order is deliberate. `a@b.com c@d.com` is a missing comma, and
  // it is both the likeliest typo here and the one whose other symptoms are
  // misleading: reported by @-count it comes back as "more than one @", which
  // sends the operator looking for the wrong thing. The entry has already been
  // trimmed, so any whitespace left is interior.
  if (/\s/.test(entry)) {
    return "contains whitespace, which is probably a missing comma";
  }
  const at = entry.indexOf("@");
  if (at === -1) return "not an email address (no @)";
  // `includes` with a start position, rather than a second `indexOf` compared to
  // -1, because the lint rule prefers it and it reads as the question being asked:
  // is there another @ after the first one.
  if (entry.includes("@", at + 1)) {
    return "not an email address (more than one @)";
  }
  if (at === 0) return "no local part before the @";
  const domain = entry.slice(at + 1);
  if (domain === "") return "no domain after the @";
  if (!domain.includes(".")) return "the domain has no dot, so it cannot match";
  return null;
}

/**
 * Whether this address may form an account.
 *
 * The list is checked for emptiness FIRST, and that ordering is what makes the
 * open case cost nothing and behave identically for every address.
 */
export function decideRegistrationAllowlist(
  email: string,
  allowlist: ReadonlySet<string>,
): AllowlistDecision {
  if (allowlist.size === 0) return { allowed: true, reason: "open" };

  // An empty or absent address normalises to "", which is in no list, so it is
  // refused. That is the fail-closed answer for the one caller that can hand
  // this function a value it did not validate: `GET /v1/auth/callback` reads the
  // address off the identity provider's response, where it is nullable.
  const address = normaliseAddress(email);
  return allowlist.has(address)
    ? { allowed: true, reason: "allowlisted" }
    : { allowed: false, reason: "not-allowlisted" };
}
