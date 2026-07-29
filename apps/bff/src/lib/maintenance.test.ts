/**
 * The maintenance gate.
 *
 * Gate 6 asserts a flip in BOTH directions inside sixty seconds. The env
 * variable can only do the first half without a restart, so the file lever is
 * the part under test here, along with the two compositional rules that make it
 * safe: the file can only ever turn maintenance ON, and a filesystem error can
 * never turn it OFF.
 */

import { describe, expect, test } from "vitest";

import { createMaintenanceGate } from "./maintenance.js";

const FLAG = "/etc/pullfm/maintenance";

function gate(opts: {
  env?: boolean;
  file?: string;
  exists?: (p: string) => boolean;
  now?: () => number;
  pollMs?: number;
}) {
  return createMaintenanceGate({
    envFlag: opts.env ?? false,
    flagFile: opts.file ?? FLAG,
    pollMs: opts.pollMs ?? 1000,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    exists: opts.exists ?? (() => false),
  });
}

describe("createMaintenanceGate", () => {
  test("is off with neither lever set", () => {
    const g = gate({});
    expect(g.active()).toBe(false);
    expect(g.reason()).toBe("off");
  });

  test("the environment variable alone turns it on", () => {
    const g = gate({ env: true });
    expect(g.active()).toBe(true);
    expect(g.reason()).toBe("env");
  });

  test("the flag file alone turns it on", () => {
    const g = gate({ exists: (p) => p === FLAG });
    expect(g.active()).toBe(true);
    expect(g.reason()).toBe("file");
  });

  test("the file cannot turn maintenance OFF while the env says on", () => {
    // The direction that matters. A file that could clear the env flag would be
    // a way to accidentally serve traffic from a node an operator contained
    // during a SEV-1.
    const g = gate({ env: true, exists: () => false });
    expect(g.active()).toBe(true);
    expect(g.reason()).toBe("env");
  });

  test("an empty flag path disables the file lever entirely", () => {
    let looked = false;
    const g = gate({
      file: "",
      exists: () => {
        looked = true;
        return true;
      },
    });
    expect(g.active()).toBe(false);
    expect(looked).toBe(false);
  });

  test("the answer is cached for pollMs, so the hot path is not a syscall", () => {
    let calls = 0;
    let clock = 1_000_000;
    const g = gate({
      pollMs: 1000,
      now: () => clock,
      exists: () => {
        calls += 1;
        return false;
      },
    });
    for (let i = 0; i < 50; i += 1) g.active();
    expect(calls).toBe(1);
    clock += 1001;
    g.active();
    expect(calls).toBe(2);
  });

  test("the flip is visible within the poll window", () => {
    let clock = 1_000_000;
    let present = false;
    const g = gate({
      pollMs: 1000,
      now: () => clock,
      exists: () => present,
    });
    expect(g.active()).toBe(false);
    present = true;
    clock += 1001;
    expect(g.active()).toBe(true);
    // And back, which is the half a restart-based flip cannot claim.
    present = false;
    clock += 1001;
    expect(g.active()).toBe(false);
  });

  test("an unreadable flag path keeps the previous answer instead of clearing", () => {
    // Flapping to "serving" on a transient filesystem error is the one failure
    // mode that would let a contained node start answering by itself.
    let clock = 1_000_000;
    let mode: "on" | "throw" = "on";
    const g = gate({
      pollMs: 1000,
      now: () => clock,
      exists: () => {
        if (mode === "throw") throw new Error("EIO");
        return true;
      },
    });
    expect(g.active()).toBe(true);
    mode = "throw";
    clock += 1001;
    expect(g.active()).toBe(true);
  });
});
