/**
 * Latency sampling from a quantile specification.
 *
 * WHY NOT A LOGNORMAL FIT
 * -----------------------
 * The obvious move is to fit a lognormal and sample from it. The problem is
 * that nobody has the parameters: what we actually know about each upstream is
 * "p50 is about here, the tail is about there". Fitting a distribution to three
 * numbers and then sampling from it reproduces the three numbers only
 * approximately, and the error lands exactly in the tail, which is the part
 * that matters for a p95 gate.
 *
 * Piecewise-linear interpolation between the stated quantiles reproduces them
 * exactly by construction: sample 10,000 times and the empirical p95 is the p95
 * you configured. The shape between knots is wrong in a way nobody can measure,
 * and right in the way the gate measures.
 *
 * Above p99 the curve extends to p99 * tailMultiplier, because every real
 * upstream has a small population of requests that are far worse than its p99
 * and those are what trip timeouts.
 */

/**
 * @param {{min:number,p50:number,p95:number,p99:number,tailMultiplier:number,jitter:number}} spec
 * @param {() => number} rnd uniform [0,1)
 * @returns {number} milliseconds
 */
export function sampleLatency(spec, rnd = Math.random) {
  const u = rnd();
  const { min, p50, p95, p99 } = spec;
  let ms;
  if (u < 0.5) {
    ms = lerp(min, p50, u / 0.5);
  } else if (u < 0.95) {
    ms = lerp(p50, p95, (u - 0.5) / 0.45);
  } else if (u < 0.99) {
    ms = lerp(p95, p99, (u - 0.95) / 0.04);
  } else {
    ms = lerp(p99, p99 * (spec.tailMultiplier ?? 3), (u - 0.99) / 0.01);
  }
  // Multiplicative jitter so identical requests are not identically timed.
  // Additive jitter would distort the low end far more than the high end.
  const j = spec.jitter ?? 0;
  if (j > 0) ms *= 1 + (rnd() * 2 - 1) * j;
  return Math.max(0, Math.round(ms));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
