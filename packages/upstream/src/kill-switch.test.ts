import { describe, expect, it } from "vitest";

import { ALL_PROVIDERS, KillSwitch, statusOf } from "./kill-switch.js";

describe("KillSwitch", () => {
  it("enables every known provider by default", () => {
    const ks = new KillSwitch();
    for (const p of ALL_PROVIDERS) expect(ks.isEnabled(p)).toBe(true);
  });

  it("disables with a reason that survives for later inspection", () => {
    const ks = new KillSwitch([], () => 1234);
    ks.disable("lastfm", "partners@last.fm asked us to stop");
    expect(ks.isEnabled("lastfm")).toBe(false);
    expect(ks.reasonFor("lastfm")).toContain("partners@last.fm");
    expect(ks.snapshot().lastfm.changedAt).toBe(1234);
    // Disabling one provider must not touch another.
    expect(ks.isEnabled("listenbrainz")).toBe(true);
  });

  it("re-enables and clears the reason", () => {
    const ks = new KillSwitch();
    ks.disable("deezer", "terms review");
    ks.enable("deezer");
    expect(ks.isEnabled("deezer")).toBe(true);
    expect(ks.reasonFor("deezer")).toBeNull();
  });

  it("accepts providers disabled by configuration at startup", () => {
    const ks = new KillSwitch(["seatgeek"]);
    expect(ks.isEnabled("seatgeek")).toBe(false);
    expect(ks.reasonFor("seatgeek")).toContain("configuration");
  });
});

describe("statusOf", () => {
  it("maps switch and breaker state onto the /v1/config vocabulary", () => {
    expect(statusOf(true, "closed")).toBe("ok");
    expect(statusOf(true, "open")).toBe("degraded");
    expect(statusOf(true, "half_open")).toBe("degraded");
    // Disabled wins: an operator switching a provider off is not "degraded".
    expect(statusOf(false, "closed")).toBe("disabled");
  });
});
