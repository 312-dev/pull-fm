/**
 * Environment overrides for the scheduled jobs.
 *
 * Deliberately NOT part of `config.ts`. Everything in that schema is read by
 * the API process at startup, and a variable that only a nightly script cares
 * about would make every API node refuse to boot over a typo in a knob it never
 * reads. The retention windows in particular are policy numbers published in
 * legal/privacy-policy.md, so their real home is the defaults constant next to
 * the job, and this exists so an operator can tighten one during an incident
 * without a deploy.
 *
 * Fail-fast is preserved where it matters: a value that is present but not a
 * positive integer THROWS rather than falling back to the default. A silently
 * ignored override on a destructive job is how a retention window quietly
 * becomes something other than the number a policy document claims.
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

/** stderr-only logger. stdout is reserved for the machine-readable summary. */
export function jobLogger(): {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
} {
  return {
    error: (obj: unknown, msg?: string) => {
      process.stderr.write(`${msg ?? "error"} ${JSON.stringify(obj)}\n`);
    },
    warn: (obj: unknown, msg?: string) => {
      process.stderr.write(`${msg ?? "warn"} ${JSON.stringify(obj)}\n`);
    },
  };
}

/**
 * Runs a job entrypoint and maps a thrown error to exit code 1.
 *
 * Exit code 1 means ONE thing across every job in this directory: the job could
 * not run and therefore changed nothing. That is the case worth paging about,
 * because whatever the job bounds is unbounded until it succeeds. It is
 * deliberately distinct from exit code 2, which means the job ran and something
 * inside it needs a look but nothing is unbounded.
 */
export function runJob(name: string, main: () => Promise<number>): void {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `${name} could not run, and changed nothing:\n${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exit(1);
    });
}
