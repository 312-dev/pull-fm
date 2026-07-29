/**
 * Environment overrides for the scheduled jobs.
 *
 * Deliberately NOT part of `config.ts`. Everything in that schema is required
 * to be well formed before the API process will serve a request, and the knobs
 * read here are read by nobody on the request path. Keeping them out means a
 * typo in a nightly retention window cannot take the API down, and it keeps the
 * retention numbers - which are policy figures published in
 * legal/privacy-policy.md - in the defaults constant next to the job that
 * enforces them rather than in a schema file nowhere near the code.
 *
 * Fail-fast is preserved where it matters: a value that is PRESENT but not a
 * positive integer THROWS rather than falling back to the default. A silently
 * ignored override on a destructive job is how a retention window quietly
 * becomes something other than the number a policy document claims.
 *
 * This lives in lib/ rather than scripts/ because `wiring.ts` resolves the job
 * options now, so that the jobs are constructed in the same place as every
 * other service. See `wiring.ts` and the `Services` doc comments for why the
 * jobs are on the bundle at all.
 */

/** Reads a positive-integer override, or returns `fallback` when unset. */
export function intFromEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `invalid configuration:\n  ${name}: must be a positive integer, got "${raw}"`,
    );
  }
  return value;
}
