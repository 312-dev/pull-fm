import { describe, expect, it } from "vitest";

import { ALL_PROVIDERS, KillSwitch, statusOf } from "./kill-switch.js";
import type { ProviderName } from "./types.js";

describe("KillSwitch", () => {
  it("enables every known provider by default", () => {
    const ks = new KillSwitch();
    for (const p of ALL_PROVIDERS) expect(ks.isEnabled(p)).toBe(true);
  });

  it("disables with a reason that survives for later inspection", () => {
    const ks = new KillSwitch([], { now: () => 1234 });
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

/**
 * The external lever, which is what turns this class from a data structure into
 * an operable control. Every test here is about the DIRECTION of composition:
 * a lever may take a provider off the air and may never put one back on it.
 */
describe("KillSwitch external source", () => {
  it("disables a provider the source names, with no restart", () => {
    let disabled: ProviderName[] = [];
    const ks = new KillSwitch([], { source: () => disabled });

    expect(ks.isEnabled("lastfm")).toBe(true);
    disabled = ["lastfm"];
    // Re-read, not re-constructed: this is the "seconds, not a deploy" claim.
    expect(ks.isEnabled("lastfm")).toBe(false);
    expect(ks.reasonFor("lastfm")).toContain("kill-switch");
    expect(ks.isEnabled("deezer")).toBe(true);
  });

  it("cannot be used to ENABLE a provider disabled in memory", () => {
    // The whole safety argument. If a lever could re-enable, removing a flag
    // file would resume calls to an upstream somebody stopped on purpose.
    const ks = new KillSwitch([], { source: () => [] });
    ks.disable("deezer", "partners asked us to stop");
    expect(ks.isEnabled("deezer")).toBe(false);
    expect(ks.reasonFor("deezer")).toContain("partners");
  });

  it("keeps a provider off while the source names it, even after enable()", () => {
    const ks = new KillSwitch(["seatgeek"], { source: () => ["seatgeek"] });
    ks.enable("seatgeek");
    expect(ks.isEnabled("seatgeek")).toBe(false);
  });

  it("holds its previous answer when the source throws", () => {
    // Fails CLOSED on a transient filesystem error rather than flapping back to
    // "serving", which is the one failure mode that would resume calls by
    // itself. Mirrors lib/maintenance.ts.
    let mode: "ok" | "throw" = "ok";
    const ks = new KillSwitch([], {
      source: () => {
        if (mode === "throw") throw new Error("EIO");
        return ["itunes"];
      },
    });

    expect(ks.isEnabled("itunes")).toBe(false);
    mode = "throw";
    expect(ks.isEnabled("itunes")).toBe(false);
  });

  it("reports the effective state in the snapshot", () => {
    // A snapshot that disagreed with isEnabled would be the metrics equivalent
    // of a status page reporting "available" during an outage it is serving.
    const ks = new KillSwitch([], { source: () => ["reccobeats"] });
    expect(ks.snapshot().reccobeats.enabled).toBe(false);
    expect(ks.snapshot().reccobeats.reason).toContain("kill-switch");
    expect(ks.snapshot().lastfm.enabled).toBe(true);
  });

  it("is inert when no source is configured", () => {
    const ks = new KillSwitch();
    for (const p of ALL_PROVIDERS) expect(ks.isEnabled(p)).toBe(true);
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
