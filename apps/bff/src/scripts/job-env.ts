/**
 * Process-level plumbing shared by the scheduled job entrypoints.
 *
 * The env-override reader that used to live here moved to lib/job-env.ts when
 * the jobs joined the service bundle: `wiring.ts` resolves their options now,
 * and nothing under src/ may import from scripts/. What is left is the two
 * things that are genuinely script-only, because they touch stdout, stderr and
 * the process exit code.
 */

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
