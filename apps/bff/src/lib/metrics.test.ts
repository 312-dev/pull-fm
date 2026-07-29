/**
 * The registry, the exposition format, and the two properties an alert rule
 * depends on being true: cumulative histogram buckets, and label sets that
 * cannot fork on key ordering.
 */

import { describe, expect, test } from "vitest";

import { LATENCY_BUCKETS, Registry } from "./metrics.js";

describe("Registry", () => {
  test("renders HELP and TYPE for every metric", () => {
    const r = new Registry();
    r.counter("pullfm_x_total", "An x.", {}, 3);
    const out = r.render();
    expect(out).toContain("# HELP pullfm_x_total An x.");
    expect(out).toContain("# TYPE pullfm_x_total counter");
    expect(out).toContain("pullfm_x_total 3");
  });

  test("counters accumulate and gauges replace", () => {
    const r = new Registry();
    r.counter("c_total", "c", { a: "1" });
    r.counter("c_total", "c", { a: "1" });
    r.gauge("g", "g", { a: "1" }, 5);
    r.gauge("g", "g", { a: "1" }, 2);
    expect(r.peek("c_total", { a: "1" })).toBe(2);
    expect(r.peek("g", { a: "1" })).toBe(2);
  });

  test("counterAbsolute mirrors a source that owns the count", () => {
    // The point of the method: most counts here are maintained elsewhere and
    // re-counting them would produce two numbers that disagree after a restart.
    const r = new Registry();
    r.counterAbsolute("m_total", "m", { p: "lastfm" }, 40);
    r.counterAbsolute("m_total", "m", { p: "lastfm" }, 41);
    expect(r.peek("m_total", { p: "lastfm" })).toBe(41);
    expect(r.render()).toContain("# TYPE m_total counter");
  });

  test("label order does not fork a series", () => {
    // Two call sites writing the same labels in different orders must not
    // produce two time series, which would silently halve every rate().
    const r = new Registry();
    r.counter("c_total", "c", { a: "1", b: "2" });
    r.counter("c_total", "c", { b: "2", a: "1" });
    expect(r.peek("c_total", { a: "1", b: "2" })).toBe(2);
    expect(r.render().match(/^c_total\{/gm)).toHaveLength(1);
  });

  test("labels are rendered in a stable sorted order", () => {
    const r = new Registry();
    r.counter("c_total", "c", { zebra: "z", alpha: "a" });
    expect(r.render()).toContain('c_total{alpha="a",zebra="z"} 1');
  });

  test("histogram buckets are cumulative and carry a +Inf", () => {
    // histogram_quantile assumes cumulative buckets. Getting this wrong yields
    // a quantile that is quietly nonsense rather than an error, so it is
    // asserted rather than assumed.
    const r = new Registry();
    r.observe("d_seconds", "d", { route: "/v1/x" }, 0.03);
    const out = r.render();
    expect(out).toContain('d_seconds_bucket{route="/v1/x",le="0.025"} 0');
    expect(out).toContain('d_seconds_bucket{route="/v1/x",le="0.05"} 1');
    expect(out).toContain('d_seconds_bucket{route="/v1/x",le="10"} 1');
    expect(out).toContain('d_seconds_bucket{route="/v1/x",le="+Inf"} 1');
    expect(out).toContain('d_seconds_count{route="/v1/x"} 1');
    expect(out).toContain('d_seconds_sum{route="/v1/x"} 0.03');
  });

  test("a sample beyond the widest bucket still reaches +Inf and the count", () => {
    const r = new Registry();
    r.observe("d_seconds", "d", {}, 999);
    const out = r.render();
    const widest = LATENCY_BUCKETS[LATENCY_BUCKETS.length - 1];
    expect(out).toContain(`d_seconds_bucket{le="${String(widest)}"} 0`);
    expect(out).toContain('d_seconds_bucket{le="+Inf"} 1');
    expect(out).toContain("d_seconds_count 1");
  });

  test("the 0.8 bucket exists, because A6 alerts on p95 over 800ms", () => {
    expect(LATENCY_BUCKETS).toContain(0.8);
  });

  test("a label value cannot break the exposition format", () => {
    // A backstop, not the control. The control is that callers pass template
    // values; this asserts a mistake degrades a label instead of corrupting
    // every series after it in the scrape.
    const r = new Registry();
    r.counter("c_total", "c", { bad: 'a"b\nc\\d' });
    const out = r.render();
    expect(out).toContain('c_total{bad="a_b_c_d"} 1');
    expect(out.split("\n").filter((l) => l.startsWith("c_total"))).toHaveLength(
      1,
    );
  });

  test("a label value is truncated rather than allowed to be unbounded", () => {
    const r = new Registry();
    r.counter("c_total", "c", { v: "x".repeat(500) });
    const line = r
      .render()
      .split("\n")
      .find((l) => l.startsWith("c_total"));
    expect(line).toBeDefined();
    expect((line ?? "").length).toBeLessThan(200);
  });

  test("collectors run at render time, not at write time", () => {
    // A gauge written only when something changes reports history while looking
    // alive. This is the property that makes that impossible.
    const r = new Registry();
    let current = 1;
    r.addCollector(() => {
      r.gauge("live", "live", {}, current);
    });
    expect(r.render()).toContain("live 1");
    current = 7;
    expect(r.render()).toContain("live 7");
  });

  test("a collector that throws does not blank the scrape", () => {
    const r = new Registry();
    r.addCollector(() => {
      throw new Error("source is down");
    });
    r.gauge("still_here", "h", {}, 1);
    const out = r.render();
    expect(out).toContain("still_here 1");
    expect(out).toContain("pullfm_metrics_collector_errors_total 1");
  });

  test("a non-finite value renders as 0 rather than NaN", () => {
    // `NaN` is legal Prometheus exposition and means "no value", which is not
    // what a divide-by-zero in a ratio intends to say.
    const r = new Registry();
    r.gauge("ratio", "r", {}, 0 / 0);
    expect(r.render()).toContain("ratio 0");
  });

  test("the body ends with a newline", () => {
    // Required by the exposition format. Some scrapers accept a missing one and
    // some drop the last sample, which is the worst of the two failure modes.
    expect(new Registry().render().endsWith("\n")).toBe(true);
  });
});
