import { describe, expect, it } from "vitest";

import { CacheGovernor, LASTFM_HARD_CAP_BYTES, lastfmCap } from "./governor.js";
import { MemoryCacheStore } from "./memory-store.js";
import type { CapAlert } from "./governor.js";
import type { CacheStore } from "./store.js";

const MB = 1024 * 1024;

/** A payload of roughly `mb` megabytes, so cap arithmetic is meaningful. */
function fatPayload(mb: number): { blob: string } {
  return { blob: "x".repeat(Math.round(mb * MB) - 20) };
}

describe("lastfmCap", () => {
  it("uses the configured soft cap and the licence hard cap", () => {
    const cap = lastfmCap(80);
    expect(cap.softCapBytes).toBe(80 * MB);
    expect(cap.hardCapBytes).toBe(LASTFM_HARD_CAP_BYTES);
    expect(cap.hardCapBytes).toBe(100 * MB);
    expect(cap.lowWaterBytes).toBeLessThan(cap.softCapBytes);
  });

  it("clamps a misconfigured soft cap below the licence ceiling", () => {
    // A soft cap above 100 MB would silently disable the protection it exists
    // to provide, so configuration cannot express it.
    const cap = lastfmCap(500);
    expect(cap.softCapBytes).toBeLessThan(LASTFM_HARD_CAP_BYTES);
  });
});

describe("CacheGovernor", () => {
  it("evicts Last.fm rows before the 100 MB licence cap is reached", async () => {
    const store = new MemoryCacheStore();
    const alerts: CapAlert[] = [];
    const governor = new CacheGovernor(store, {
      caps: { lastfm: lastfmCap(80) },
      checkEveryWrites: 1,
      onAlert: (a) => alerts.push(a),
    });

    let peak = 0;
    for (let i = 0; i < 120; i++) {
      await store.set("lastfm", `similar:${String(i)}`, fatPayload(1), 86_400);
      await governor.afterWrite("lastfm");
      peak = Math.max(peak, (await store.sizeOf("lastfm")).bytes);
    }

    // The whole point: 120 MB of writes never becomes 120 MB of storage.
    expect(peak).toBeLessThan(LASTFM_HARD_CAP_BYTES);
    expect((await store.sizeOf("lastfm")).bytes).toBeLessThan(80 * MB);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]?.provider).toBe("lastfm");
  });

  it("evicts to the low-water mark, not merely to the cap", async () => {
    const store = new MemoryCacheStore();
    const cap = lastfmCap(10);
    const governor = new CacheGovernor(store, {
      caps: { lastfm: cap },
      checkEveryWrites: 1,
    });
    for (let i = 0; i < 12; i++) {
      await store.set("lastfm", `k${String(i)}`, fatPayload(1), null);
    }
    await governor.enforce("lastfm");
    const after = await store.sizeOf("lastfm");
    // Stopping at the cap exactly would make every later write evict again.
    expect(after.bytes).toBeLessThanOrEqual(cap.lowWaterBytes + MB);
  });

  it("evicts least-recently-hit rows first", async () => {
    const store = new MemoryCacheStore();
    for (const key of ["cold", "warm"]) {
      await store.set("lastfm", key, fatPayload(6), null);
    }
    await store.get("lastfm", "warm");

    const governor = new CacheGovernor(store, {
      caps: { lastfm: lastfmCap(10) },
    });
    await governor.enforce("lastfm");

    expect(await store.get("lastfm", "cold")).toBeNull();
    expect(await store.get("lastfm", "warm")).not.toBeNull();
  });

  it("samples rather than checking on every write", async () => {
    const store = new MemoryCacheStore();
    let sizeChecks = 0;
    const counting: CacheStore = {
      get: (p, k) => store.get(p, k),
      set: (p, k, v, ttl) => store.set(p, k, v, ttl),
      delete: (p, k) => store.delete(p, k),
      sizeOf: (p) => {
        sizeChecks++;
        return store.sizeOf(p);
      },
      evictLru: (p, b) => store.evictLru(p, b),
    };
    const governor = new CacheGovernor(counting, {
      caps: { lastfm: lastfmCap(80) },
      checkEveryWrites: 10,
    });
    for (let i = 0; i < 30; i++) await governor.afterWrite("lastfm");
    expect(sizeChecks).toBe(3);
  });

  it("ignores providers with no cap: only Last.fm has a licensed limit", async () => {
    const store = new MemoryCacheStore();
    const governor = new CacheGovernor(store, {
      caps: { lastfm: lastfmCap(80) },
    });
    await store.set("listenbrainz", "big", fatPayload(200), null);
    expect(await governor.enforce("listenbrainz")).toBeNull();
    expect((await store.sizeOf("listenbrainz")).bytes).toBeGreaterThan(
      LASTFM_HARD_CAP_BYTES,
    );
  });
});
