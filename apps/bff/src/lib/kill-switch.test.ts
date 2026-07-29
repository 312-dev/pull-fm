/**
 * The flag-file lever.
 *
 * These tests are the reason the control is not "dead capability" any more, so
 * they are written adversarially: every one of them is a way the lever could
 * look like it works and not work.
 */

import { describe, expect, test, vi } from "vitest";

import { createKillSwitchSource } from "./kill-switch.js";

describe("createKillSwitchSource", () => {
  test("names the providers whose flag files exist", () => {
    const source = createKillSwitchSource({
      dir: "/etc/pullfm/kill",
      pollMs: 1000,
      now: () => 0,
      readdir: () => ["lastfm", "deezer"],
    });
    expect([...source()].sort()).toEqual(["deezer", "lastfm"]);
  });

  test("an empty directory setting makes the lever inert", () => {
    const readdir = vi.fn(() => ["lastfm"]);
    const source = createKillSwitchSource({
      dir: "",
      pollMs: 1000,
      readdir,
    });
    expect(source()).toEqual([]);
    // Not merely empty: the filesystem is never consulted at all.
    expect(readdir).not.toHaveBeenCalled();
  });

  test("a missing directory disables nothing and does not throw", () => {
    const source = createKillSwitchSource({
      dir: "/nope",
      pollMs: 1000,
      now: () => 0,
      readdir: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(source()).toEqual([]);
  });

  test("an unreadable directory HOLDS the previous answer", () => {
    // The failure this exists to prevent: a provider we were told to stop
    // calling resuming by itself because a stat failed.
    let mode: "ok" | "throw" = "ok";
    let clock = 0;
    const source = createKillSwitchSource({
      dir: "/etc/pullfm/kill",
      pollMs: 10,
      now: () => clock,
      readdir: () => {
        if (mode === "throw") throw new Error("EIO");
        return ["lastfm"];
      },
    });

    expect(source()).toEqual(["lastfm"]);
    mode = "throw";
    clock = 1000;
    expect(source()).toEqual(["lastfm"]);
  });

  test("caches for the poll interval and re-reads after it", () => {
    let clock = 0;
    const readdir = vi.fn(() => ["itunes"]);
    const source = createKillSwitchSource({
      dir: "/etc/pullfm/kill",
      pollMs: 1000,
      now: () => clock,
      readdir,
    });

    source();
    source();
    source();
    expect(readdir).toHaveBeenCalledTimes(1);

    clock = 1001;
    source();
    expect(readdir).toHaveBeenCalledTimes(2);
  });

  test("a filename that names no provider is WARNED about, not silently ignored", () => {
    // SEATGEEK_ENABLED was a documented kill switch that a second layer
    // silently overrode. A typo'd flag file is the same defect in miniature:
    // the operator believes the provider is off and it is not.
    const warn = vi.fn();
    let clock = 0;
    const source = createKillSwitchSource({
      dir: "/etc/pullfm/kill",
      pollMs: 10,
      now: () => clock,
      readdir: () => ["last.fm", "lastfm"],
      log: { warn },
    });

    expect(source()).toEqual(["lastfm"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ entry: "last.fm" });

    // Warned once, not once per poll: an operator who leaves the file in place
    // must not drown the log they are reading.
    clock = 1000;
    source();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("ignores dotfiles, which are editor artefacts rather than instructions", () => {
    const source = createKillSwitchSource({
      dir: "/etc/pullfm/kill",
      pollMs: 10,
      now: () => 0,
      readdir: () => [".swp", ".lastfm.swp", "lastfm"],
    });
    expect(source()).toEqual(["lastfm"]);
  });
});
