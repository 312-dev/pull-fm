/**
 * A Prometheus text-format registry, in about two hundred lines and no
 * dependencies.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `prom-client`
 *
 * It is the obvious choice and it was rejected for one reason that is specific
 * to this repository rather than to the library: what this registry has to do
 * is almost entirely READ COUNTERS THAT ALREADY EXIST. `CachedUpstream.stats()`,
 * `CrosswalkResolver.stats()`, `RateLimiter.stats`, `KillSwitch.snapshot()` and
 * `pg.Pool`'s counts are all already-maintained numbers. A client library's
 * value is in owning the counter; here the counter is owned elsewhere and the
 * only job left is to render it, which is a `for` loop over a Map.
 *
 * The three things it would genuinely give us - histograms, exemplars, and a
 * default process collector - are one implemented below, one unused, and one
 * replaceable by four lines of `process.memoryUsage()`. Against that, a new
 * runtime dependency in a lockfile that four agents are editing concurrently is
 * a merge conflict in the one file where a bad merge is silent.
 *
 * If a real need for prom-client appears, the swap is confined to this file:
 * nothing outside it knows the format exists.
 *
 * ---------------------------------------------------------------------------
 * THE RULE ABOUT LABELS
 *
 * Every label value used anywhere in this application comes from a CLOSED SET:
 * seven provider names, three breaker states, a fixed list of route templates
 * registered at boot. Nothing derived from a request path, a query string, a
 * user id or a token id may ever become a label, because Prometheus stores one
 * time series per distinct label combination and an unbounded label is how a
 * metrics endpoint becomes the outage. `sanitizeLabel` truncates as a backstop,
 * but the real control is that callers pass template values.
 */

export type MetricType = "counter" | "gauge" | "histogram";

export type MetricLabels = Readonly<Record<string, string | number>>;

/** Buckets in seconds. Chosen around the two numbers the gates name. */
export const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 2, 5, 10,
] as const;

interface Series {
  readonly labels: MetricLabels;
  value: number;
}

interface HistogramSeries {
  readonly labels: MetricLabels;
  readonly counts: number[];
  sum: number;
  count: number;
}

interface MetricDef {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly series: Map<string, Series>;
  readonly histograms: Map<string, HistogramSeries>;
  readonly buckets: readonly number[];
}

/**
 * Label values are truncated and stripped of the three characters that can
 * break the exposition format. This is a backstop, not the control: see the
 * header. A value that needs this is a value that should not have been a label.
 */
function sanitizeLabel(value: string | number): string {
  return String(value)
    .replace(/[\\\n"]/g, "_")
    .slice(0, 120);
}

/** Stable key for a label set, so ordering in the call site cannot fork a series. */
function labelKey(labels: MetricLabels): string {
  const names = Object.keys(labels).sort();
  return names.map((n) => `${n}=${sanitizeLabel(labels[n] ?? "")}`).join(",");
}

function renderLabels(labels: MetricLabels, extra?: [string, string]): string {
  const parts = Object.keys(labels)
    .sort()
    .map((n) => `${n}="${sanitizeLabel(labels[n] ?? "")}"`);
  if (extra !== undefined) parts.push(`${extra[0]}="${extra[1]}"`);
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

export class Registry {
  readonly #metrics = new Map<string, MetricDef>();
  /** Callbacks that refresh gauges from a live source at scrape time. */
  readonly #collectors: (() => void)[] = [];

  #define(
    name: string,
    help: string,
    type: MetricType,
    buckets: readonly number[] = LATENCY_BUCKETS,
  ): MetricDef {
    const existing = this.#metrics.get(name);
    if (existing !== undefined) return existing;
    const def: MetricDef = {
      name,
      help,
      type,
      series: new Map(),
      histograms: new Map(),
      buckets,
    };
    this.#metrics.set(name, def);
    return def;
  }

  /**
   * Adds to a counter. Counters only ever go up, which is what lets a scraper
   * survive missing a scrape: the delta is still correct on the next one.
   */
  counter(name: string, help: string, labels: MetricLabels = {}, by = 1): void {
    const def = this.#define(name, help, "counter");
    const key = labelKey(labels);
    const s = def.series.get(key);
    if (s === undefined) def.series.set(key, { labels, value: by });
    else s.value += by;
  }

  /**
   * Sets a counter to an absolute value read from a source that owns it.
   *
   * This exists because most of the interesting counts in this codebase are
   * maintained by somebody else (`CachedUpstream.stats()` and friends) and are
   * monotonic there. Mirroring the source is correct; re-counting the same
   * events here would produce two numbers that disagree after any restart.
   */
  counterAbsolute(
    name: string,
    help: string,
    labels: MetricLabels,
    value: number,
  ): void {
    const def = this.#define(name, help, "counter");
    const key = labelKey(labels);
    const s = def.series.get(key);
    if (s === undefined) def.series.set(key, { labels, value });
    else s.value = value;
  }

  gauge(name: string, help: string, labels: MetricLabels, value: number): void {
    const def = this.#define(name, help, "gauge");
    const key = labelKey(labels);
    const s = def.series.get(key);
    if (s === undefined) def.series.set(key, { labels, value });
    else s.value = value;
  }

  observe(
    name: string,
    help: string,
    labels: MetricLabels,
    value: number,
    buckets: readonly number[] = LATENCY_BUCKETS,
  ): void {
    const def = this.#define(name, help, "histogram", buckets);
    const key = labelKey(labels);
    let h = def.histograms.get(key);
    if (h === undefined) {
      h = {
        labels,
        counts: new Array<number>(def.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      def.histograms.set(key, h);
    }
    h.sum += value;
    h.count += 1;
    for (let i = 0; i < def.buckets.length; i += 1) {
      // Cumulative: a sample belongs to its bucket and to every wider one, which
      // is what `histogram_quantile` expects. Getting this wrong produces a
      // quantile that is quietly nonsense rather than an error.
      if (value <= (def.buckets[i] ?? Infinity))
        h.counts[i] = (h.counts[i] ?? 0) + 1;
    }
  }

  /**
   * Registers a function to run immediately before rendering.
   *
   * Gauges that mirror a live source (pool depth, breaker state, cache size)
   * must be sampled at scrape time, not at mutation time: a gauge written only
   * when something changes reports the last change rather than the current
   * state, and a value that stops updating is indistinguishable from a value
   * that stopped changing.
   */
  addCollector(fn: () => void): void {
    this.#collectors.push(fn);
  }

  /** Runs every collector, isolating a throw so one bad source cannot blank the scrape. */
  collect(): void {
    for (const fn of this.#collectors) {
      try {
        fn();
      } catch {
        this.counter(
          "pullfm_metrics_collector_errors_total",
          "Collectors that threw during a scrape.",
        );
      }
    }
  }

  render(): string {
    this.collect();
    const out: string[] = [];
    for (const def of [...this.#metrics.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      out.push(`# HELP ${def.name} ${def.help}`);
      out.push(`# TYPE ${def.name} ${def.type}`);
      if (def.type === "histogram") {
        for (const h of def.histograms.values()) {
          for (let i = 0; i < def.buckets.length; i += 1) {
            out.push(
              `${def.name}_bucket${renderLabels(h.labels, ["le", String(def.buckets[i])])} ${String(h.counts[i] ?? 0)}`,
            );
          }
          out.push(
            `${def.name}_bucket${renderLabels(h.labels, ["le", "+Inf"])} ${String(h.count)}`,
          );
          out.push(`${def.name}_sum${renderLabels(h.labels)} ${String(h.sum)}`);
          out.push(
            `${def.name}_count${renderLabels(h.labels)} ${String(h.count)}`,
          );
        }
      } else {
        for (const s of def.series.values()) {
          out.push(
            `${def.name}${renderLabels(s.labels)} ${String(Number.isFinite(s.value) ? s.value : 0)}`,
          );
        }
      }
    }
    return `${out.join("\n")}\n`;
  }

  /** Test seam: the current value of one series, or null. */
  peek(name: string, labels: MetricLabels = {}): number | null {
    return this.#metrics.get(name)?.series.get(labelKey(labels))?.value ?? null;
  }

  reset(): void {
    this.#metrics.clear();
    this.#collectors.length = 0;
  }
}
