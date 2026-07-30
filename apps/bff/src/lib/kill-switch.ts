/**
 * The runtime lever that throws the per-provider kill switch.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * `KillSwitch` was constructed empty in services/upstream.ts and nothing else
 * could reach it. `security/DAST-RUNBOOK.md` §6 states the consequence plainly:
 * the active scan's precondition "provider kill switches engaged" was not
 * satisfiable, and THREAT-MODEL M34 credited a control nobody could operate.
 * `GET /v1/config` even promised that "a thrown kill switch is visible to a
 * client within seconds", of a switch that could not be thrown.
 *
 * ---------------------------------------------------------------------------
 * WHY A FLAG DIRECTORY AND NOT AN ADMIN ROUTE
 *
 * The obligation being met here is a licence one. Last.fm's and SeatGeek's
 * terms make "stop calling us" a duty measured in hours, and the incident
 * runbook (docs/RUNBOOK-INCIDENT.md §4 step 4) reaches for this control during
 * a live abuse event. So the lever has to work without a deploy.
 *
 * An admin-authenticated route would also work, and was rejected:
 *
 *   - It adds an AUTHENTICATED MUTATING ROUTE to a public API in order to
 *     protect that API. The new attack surface is a permanent cost paid for an
 *     exceptional-case control, and it needs its own credential, its own
 *     constant-time comparison, its own rate limit, and its own BOLA argument.
 *   - This repository already has a proven precedent for exactly this shape:
 *     `lib/maintenance.ts`, whose file lever exists because "the environment
 *     variable needs a restart to change; this does not". Two levers with two
 *     different mechanisms would be two things to get right at 3am.
 *   - Every route must be registered in `security/zap/upstream-scope.tsv` or
 *     `test/security/upstream-scope.test.ts` fails the build. A control that
 *     cannot be added without also editing the scanner's register is a control
 *     that will be added wrong under pressure.
 *
 * So: the EXISTENCE of `<dir>/<provider>` disables that provider.
 *
 *   touch /etc/pullfm/kill/lastfm    # stops every Last.fm call within pollMs
 *   rm    /etc/pullfm/kill/lastfm    # resumes them within pollMs
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THIS FAILS CLOSED ON
 *
 * 1. AN UNREADABLE DIRECTORY KEEPS THE PREVIOUS ANSWER. A provider that was
 *    switched off does not switch itself back on because a stat failed.
 * 2. AN UNRECOGNISED FILENAME IS LOUD. `touch .../last.fm` disables nothing,
 *    and a silent no-op here is precisely the SEATGEEK_ENABLED failure: a
 *    documented switch that was a formality. Unknown entries are logged at warn
 *    on every poll that sees them, naming the file and the accepted names.
 * 3. AN UNSET DIRECTORY DISABLES THE LEVER, NOT THE SWITCH. The environment
 *    list still applies, and the switch still reports through `/v1/config`.
 *
 * `readdirSync` rather than `fs.watch`, for the reason maintenance.ts gives:
 * `fs.watch` does not fire reliably for a bind-mounted path inside a container,
 * and a lever that works in development and silently does not work in
 * production is worse than no lever. One directory read per poll interval, not
 * per request.
 */

import { readdirSync } from "node:fs";

import { ALL_PROVIDERS, type ProviderName } from "@pull-fm/upstream";

export interface KillSwitchFileOptions {
  /** Directory whose entries name disabled providers. Empty disables the lever. */
  readonly dir: string;
  /** Milliseconds a directory listing may be reused. */
  readonly pollMs: number;
  /** Warned at, once per poll, for a filename that names no known provider. */
  readonly log?: { warn: (obj: unknown, msg?: string) => void } | undefined;
  /** Test seam. */
  readonly now?: () => number;
  /** Test seam. */
  readonly readdir?: (path: string) => readonly string[];
}

/** A cheap, cached reading of the flag directory. Never throws. */
export type KillSwitchSource = () => readonly ProviderName[];

const KNOWN = new Set<string>(ALL_PROVIDERS);

/**
 * Builds the source `KillSwitch` consults.
 *
 * Returns a function rather than an object because that is the whole contract:
 * `KillSwitch` asks "which providers are switched off right now" and does not
 * care how the answer was obtained.
 */
export function createKillSwitchSource(
  opts: KillSwitchFileOptions,
): KillSwitchSource {
  const now = opts.now ?? Date.now;
  const readdir =
    opts.readdir ?? ((p: string): readonly string[] => readdirSync(p));

  let cachedAt = -Infinity;
  let cached: readonly ProviderName[] = [];
  /** Filenames already warned about, so a stale flag file is not a log flood. */
  const warned = new Set<string>();

  if (opts.dir === "") return (): readonly ProviderName[] => [];

  return (): readonly ProviderName[] => {
    const t = now();
    if (t - cachedAt < opts.pollMs) return cached;
    cachedAt = t;

    let entries: readonly string[];
    try {
      entries = readdir(opts.dir);
    } catch {
      // A missing directory is the normal case (no incident in progress) and an
      // unreadable one is a transient fault. Neither may re-enable a provider,
      // so the previous answer stands. See fail-closed rule 1 in the header.
      return cached;
    }

    const disabled: ProviderName[] = [];
    for (const entry of entries) {
      // Only the leaf name is meaningful, and a dotfile is an editor artefact
      // rather than an instruction.
      if (entry.startsWith(".")) continue;
      if (KNOWN.has(entry)) {
        disabled.push(entry as ProviderName);
        continue;
      }
      if (!warned.has(entry)) {
        warned.add(entry);
        opts.log?.warn(
          {
            dir: opts.dir,
            entry,
            accepted: [...ALL_PROVIDERS],
          },
          "kill-switch flag file names no known provider and disables nothing",
        );
      }
    }

    cached = disabled;
    return cached;
  };
}
