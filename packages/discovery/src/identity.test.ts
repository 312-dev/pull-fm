/**
 * These fixtures are duplicated in packages/upstream/src/normalize.test.ts on
 * purpose: identity.ts is a deliberate copy of the upstream normaliser (see the
 * comment there), and duplicated expectations are what turn a silent drift into
 * a red suite.
 */

import { describe, expect, it } from "vitest";

import {
  artistIdentity,
  normalizeKey,
  normalizeTitle,
  trackIdentity,
} from "./identity.js";

describe("normalizeKey", () => {
  it("matches the upstream crosswalk rules", () => {
    expect(normalizeKey("Björk")).toBe("bjork");
    expect(normalizeKey("Sigur Rós")).toBe("sigur ros");
    expect(normalizeKey("  The   NATIONAL ")).toBe("the national");
    expect(normalizeKey("Godspeed You! Black Emperor")).toBe(
      "godspeed you black emperor",
    );
    expect(normalizeKey("Simon & Garfunkel")).toBe("simon and garfunkel");
    expect(normalizeKey("東京事変")).toBe("東京事変");
    expect(normalizeKey("!!!???")).toBe("");
  });
});

describe("normalizeTitle", () => {
  it("strips release-variant noise", () => {
    expect(normalizeTitle("Dreams (2004 Remaster)")).toBe("dreams");
    expect(normalizeTitle("Karma Police - 2011 Remaster")).toBe("karma police");
    expect(normalizeTitle("Rebellion [Radio Edit]")).toBe("rebellion");
    expect(normalizeTitle("Marquee Moon (Part 2)")).toBe("marquee moon part 2");
  });
});

describe("identities", () => {
  it("treats spelling and remaster variants as the same track", () => {
    expect(trackIdentity("Björk", "Jóga (Remastered)")).toBe(
      trackIdentity("Bjork", "Joga"),
    );
  });

  it("cannot collide across the artist/title boundary", () => {
    expect(trackIdentity("a b", "c")).not.toBe(trackIdentity("a", "b c"));
  });

  it("returns empty when there is nothing to identify", () => {
    expect(trackIdentity("???", "!!!")).toBe("");
  });

  it("keeps different artists with the same title apart", () => {
    expect(trackIdentity("Blur", "Song 2")).not.toBe(
      trackIdentity("Gorillaz", "Song 2"),
    );
  });

  it("normalises an artist identity the same way", () => {
    expect(artistIdentity("Sigur Rós")).toBe("sigur ros");
  });
});
