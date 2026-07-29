/**
 * The registration geo-refusal, at the level of the decision itself.
 *
 * The route-level suite (test/security/registration-geo.test.ts) proves the
 * block is WIRED UP, against a real application. This file proves the decision
 * is RIGHT, which is a different question and a much larger space: 38 country
 * codes, two special values, three peer classes and two deployment postures.
 * Driving all of that through HTTP would be slow and would not test anything
 * more.
 *
 * Every country assertion below is derived from `RESTRICTED_COUNTRIES` rather
 * than from a list retyped here. That is deliberate: a second copy of the list
 * in the tests is a copy that can agree with itself while disagreeing with the
 * enforcement, which is the failure mode where the suite is green and Ireland
 * gets an account.
 */

import { describe, expect, test } from "vitest";

import {
  decideRegistrationGeo,
  EEA_MEMBER_COUNTRIES,
  isOriginIngressPeer,
  RESTRICTED_COUNTRIES,
} from "./registration-geo.js";

/** An enforcing deployment reached through the origin ingress. */
const throughIngress = (country: string | string[] | undefined) =>
  decideRegistrationGeo({
    peerAddress: "172.18.0.1",
    countryHeader: country,
    enforced: true,
  });

describe("the list itself", () => {
  test("the EEA is 30 countries, not 27", () => {
    // The mistake this catches is building the list from an EU membership
    // table, which silently omits three countries the GDPR still reaches.
    expect(EEA_MEMBER_COUNTRIES).toHaveLength(30);
    expect(new Set(EEA_MEMBER_COUNTRIES).size).toBe(30);
  });

  test("the three EEA members that are not EU members are present", () => {
    for (const code of ["IS", "LI", "NO"]) {
      expect(EEA_MEMBER_COUNTRIES).toContain(code);
    }
  });

  test("the UK and Switzerland are covered and are not in the EEA group", () => {
    // Two separate regimes, two separate reasons, and neither is reachable by
    // blocking "the EU".
    expect(RESTRICTED_COUNTRIES.has("GB")).toBe(true);
    expect(RESTRICTED_COUNTRIES.has("CH")).toBe(true);
    expect(EEA_MEMBER_COUNTRIES).not.toContain("GB");
    expect(EEA_MEMBER_COUNTRIES).not.toContain("CH");
  });

  test("uses ISO 3166-1 codes rather than the lookalikes", () => {
    // `UK` and `EL` are the two codes people write that Cloudflare will never
    // send. Their presence would mean a country was listed under a name the
    // enforcement can never match, which reads as covered and is not.
    expect(RESTRICTED_COUNTRIES.has("UK")).toBe(false);
    expect(RESTRICTED_COUNTRIES.has("EL")).toBe(false);
    expect(RESTRICTED_COUNTRIES.has("GB")).toBe(true);
    expect(RESTRICTED_COUNTRIES.has("GR")).toBe(true);
    for (const code of RESTRICTED_COUNTRIES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  test("covers EU territory that Cloudflare reports under its own code", () => {
    // Reunion arrives as RE, not as FR. A member-state list alone admits it.
    for (const code of ["AX", "GF", "GP", "MQ", "RE", "YT", "MF"]) {
      expect(RESTRICTED_COUNTRIES.has(code)).toBe(true);
    }
  });

  test("does not reach territories outside the EU's territorial scope", () => {
    // Greenland and the Faroes are Danish but are NOT in the EU, and the
    // associated overseas territories are not either. Blocking them would be a
    // business loss with no obligation behind it.
    for (const code of ["GL", "FO", "BL", "PM", "NC", "AW", "CW", "SX"]) {
      expect(RESTRICTED_COUNTRIES.has(code)).toBe(false);
    }
  });
});

describe("an enforcing deployment, reached through the origin ingress", () => {
  test("refuses EVERY code on the list", () => {
    // Iterated from the constant, so a code added to the list is a code this
    // assertion covers on the same commit.
    for (const code of RESTRICTED_COUNTRIES) {
      const decision = throughIngress(code);
      expect(decision.allowed, `${code} was allowed`).toBe(false);
      expect(decision.reason).toBe("restricted-country");
    }
  });

  test("refuses regardless of the case the header arrives in", () => {
    expect(throughIngress("de").allowed).toBe(false);
    expect(throughIngress(" Gb ").allowed).toBe(false);
  });

  test("allows the United States and other unlisted countries", () => {
    for (const code of ["US", "CA", "JP", "AU", "BR", "AP"]) {
      const decision = throughIngress(code);
      expect(decision.allowed, `${code} was refused`).toBe(true);
      expect(decision.reason).toBe("permitted");
    }
  });

  test("refuses XX and T1, because an absent determination is the evasion", () => {
    // Cloudflare answered; the answer was that it cannot say. On a path where
    // the header is expected that is a signal, not a gap, and a resident of a
    // listed country reaching for Tor is the case this catches.
    for (const code of ["XX", "T1", "t1"]) {
      const decision = throughIngress(code);
      expect(decision.allowed, `${code} was allowed`).toBe(false);
      expect(decision.reason).toBe("undetermined-country");
    }
  });

  test("refuses when the header is absent entirely", () => {
    // Behind Cloudflare the header is always there. Its absence means the
    // control is broken or bypassed, so it fails closed.
    const decision = throughIngress(undefined);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("undetermined-country");
  });

  test("refuses an ambiguous or malformed header rather than parsing it", () => {
    // "US, DE" is what Node produces for a duplicated header. Taking the first
    // value would let an attacker append a second header and choose which one
    // is read.
    for (const raw of ["US, DE", "USA", "U", "", "US;q=1", "US\tDE"]) {
      const decision = throughIngress(raw);
      expect(decision.allowed, `${JSON.stringify(raw)} was allowed`).toBe(
        false,
      );
      expect(decision.reason).toBe("undetermined-country");
    }
    expect(throughIngress(["US", "DE"]).allowed).toBe(false);
  });
});

describe("the peer check, which is what makes forgery useless", () => {
  test("a forged header from a peer that is not the origin ingress is refused", () => {
    // THE ONE THAT MATTERS. A public source address means the request did not
    // arrive through the nginx that proves the peer is Cloudflare, so the
    // header is not consulted at all - not weighed, not compared, not read.
    // `CF-IPCountry: US` from there buys nothing.
    const decision = decideRegistrationGeo({
      peerAddress: "203.0.113.9",
      countryHeader: "US",
      enforced: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unverified-peer");
    // Not even recorded, so the forged value cannot reach a log or a metric
    // label either.
    expect(decision.country).toBeNull();
  });

  test("a peer with no address at all is refused", () => {
    const decision = decideRegistrationGeo({
      peerAddress: undefined,
      countryHeader: "US",
      enforced: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unverified-peer");
  });

  test("recognises the addresses a loopback-published container port can see", () => {
    // The Docker bridge gateway is the peer in staging and production, because
    // the port is published as 127.0.0.1:3000:3000 and Docker rewrites the
    // source. A loopback-only check would have refused every real request.
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "::ffff:127.0.0.1",
      "172.17.0.1",
      "172.18.0.1",
      "172.31.255.254",
      "10.0.0.5",
      "192.168.1.1",
      "169.254.10.1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isOriginIngressPeer(address), `${address} was not accepted`).toBe(
        true,
      );
    }
  });

  test("rejects globally routable peers, including near-miss private ranges", () => {
    // 172.15 and 172.32 are OUTSIDE 172.16.0.0/12 and are public address space.
    for (const address of [
      "203.0.113.9",
      "8.8.8.8",
      "172.15.0.1",
      "172.32.0.1",
      "193.168.1.1",
      "2001:db8::1",
      "",
      undefined,
      "not-an-address",
    ]) {
      expect(
        isOriginIngressPeer(address),
        `${String(address)} was accepted`,
      ).toBe(false);
    }
  });
});

describe("an unenforced deployment (DEPLOY_ENV=local)", () => {
  const local = (
    country: string | undefined,
    peerAddress: string | undefined = "127.0.0.1",
  ) =>
    decideRegistrationGeo({
      peerAddress,
      countryHeader: country,
      enforced: false,
    });

  test("allows a request with no country, so local development works", () => {
    // The whole reason the posture is keyed on the deployment rather than on
    // the request: fail-closed everywhere would mean nobody can sign in on a
    // laptop, and a control that has to be switched off gets switched off.
    const decision = local(undefined);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("unenforced");
  });

  test("still honours a header that IS present", () => {
    expect(local("DE").allowed).toBe(false);
    expect(local("US").allowed).toBe(true);
  });

  test("honours it only in the restrictive direction", () => {
    // The safety property. Off the enforcing path a supplied header can make
    // the answer stricter and never looser, so it is a way to drive the block
    // in a test and not a way past it.
    expect(local("US", "203.0.113.9").allowed).toBe(true);
    expect(local(undefined, "203.0.113.9").allowed).toBe(true);
    expect(local("DE", "203.0.113.9").allowed).toBe(false);
  });
});
