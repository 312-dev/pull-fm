/**
 * Runtime kill switch, one flag per provider.
 *
 * The scenario this exists for is legal, not technical. If Last.fm or Deezer
 * write to say our use breaches their terms, the required response is "stop
 * calling them now", and the honest measure of "now" is seconds, not a deploy
 * cycle. Every provider is therefore switchable at runtime without a restart,
 * and the switch is checked before any other gate so a disabled provider costs
 * nothing.
 *
 * Disabling is sticky and carries a reason, so that whatever surfaced the
 * incident is still readable in `GET /v1/config` an hour later.
 *
 * ---------------------------------------------------------------------------
 * WHO IS ALLOWED TO THROW IT, AND WHY THAT LIST USED TO BE EMPTY
 *
 * Until 2026-07-29 this class was constructed with no arguments in the only
 * place that constructs it, and nothing else could reach it. There was no
 * environment variable, no configuration path and no route, so the runtime kill
 * switch was dead capability: `security/DAST-RUNBOOK.md` §6 named it as an
 * unsatisfiable precondition of the active scan, and THREAT-MODEL M34 claimed a
 * control that could not be operated. Documented safety controls that cannot be
 * operated are worse than absent ones, because they are budgeted for.
 *
 * There are now exactly TWO levers, and they are both disable-only:
 *
 *   1. `initiallyDisabled`, from `UPSTREAM_DISABLED_PROVIDERS` in the process
 *      environment. Takes a restart, and is what pins a decision across one.
 *   2. `source`, an external set of provider names consulted on EVERY read.
 *      `apps/bff/src/lib/kill-switch-file.ts` implements it over a directory of
 *      flag files, so `touch /etc/pullfm/kill/lastfm` stops the calls inside a
 *      poll interval with no restart, no dropped connection and no deploy.
 *
 * NEITHER LEVER CAN ENABLE ANYTHING. `source` is unioned with the in-memory
 * state rather than replacing it, exactly as `MAINTENANCE_MODE` and its flag
 * file compose in lib/maintenance.ts: either one saying "off" means off. A
 * lever that could turn a provider back ON would be a way to resume calling an
 * upstream that somebody else had deliberately stopped, which in this system is
 * a licence breach rather than a configuration mistake.
 *
 * `source` is expected to be cheap, because `isEnabled` is called on the path
 * of every upstream request; the file gate caches its answer for a poll
 * interval. A source that THROWS keeps its previous answer rather than
 * resolving to "everything enabled", for the same reason the maintenance gate
 * keeps its previous answer: flapping back to "serving" on a transient
 * filesystem error is the one failure mode that would let a provider we have
 * been told to stop calling start being called again by itself.
 */

import type { ProviderName, ProviderStatus } from "./types.js";

export interface ProviderSwitchState {
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly changedAt: number | null;
}

const ALL_PROVIDERS: readonly ProviderName[] = [
  "listenbrainz",
  "lastfm",
  "musicbrainz",
  "itunes",
  "deezer",
  "reccobeats",
  "seatgeek",
];

export interface KillSwitchOptions {
  /** Injected in tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * An external, DISABLE-ONLY lever, consulted on every read.
   *
   * Must be cheap and must not throw; see the header. Returning an empty
   * iterable means "this lever disables nothing", never "enable everything".
   */
  readonly source?: () => Iterable<ProviderName>;
  /** Reason reported for a provider the source disabled. */
  readonly sourceReason?: string;
}

const DEFAULT_SOURCE_REASON =
  "disabled by the runtime kill-switch lever (flag file)";

export class KillSwitch {
  readonly #state = new Map<ProviderName, ProviderSwitchState>();
  readonly #now: () => number;
  readonly #source: (() => Iterable<ProviderName>) | undefined;
  readonly #sourceReason: string;
  /** Last successful reading of `source`. Kept on error; never widened to none. */
  #lastSource: ReadonlySet<ProviderName> = new Set();

  constructor(
    initiallyDisabled: readonly ProviderName[] = [],
    opts: KillSwitchOptions = {},
  ) {
    this.#now = opts.now ?? ((): number => Date.now());
    this.#source = opts.source;
    this.#sourceReason = opts.sourceReason ?? DEFAULT_SOURCE_REASON;
    for (const p of ALL_PROVIDERS) {
      this.#state.set(p, { enabled: true, reason: null, changedAt: null });
    }
    for (const p of initiallyDisabled) {
      this.disable(p, "disabled by configuration at startup");
    }
  }

  /**
   * The external lever's current set.
   *
   * Never propagates a failure and never returns an empty set because of one:
   * an unreadable lever holds its previous answer.
   */
  #fromSource(): ReadonlySet<ProviderName> {
    if (this.#source === undefined) return this.#lastSource;
    try {
      this.#lastSource = new Set(this.#source());
    } catch {
      /* keep the previous answer: see the header */
    }
    return this.#lastSource;
  }

  isEnabled(provider: ProviderName): boolean {
    if (this.#fromSource().has(provider)) return false;
    return this.#state.get(provider)?.enabled ?? true;
  }

  reasonFor(provider: ProviderName): string | null {
    // The in-memory reason wins when there is one, because it is the specific
    // sentence somebody wrote about this incident. The lever's reason is
    // generic and is only worth reporting when it is the only thing holding the
    // provider off.
    const local = this.#state.get(provider)?.reason ?? null;
    if (local !== null) return local;
    return this.#fromSource().has(provider) ? this.#sourceReason : null;
  }

  disable(provider: ProviderName, reason: string): void {
    this.#state.set(provider, {
      enabled: false,
      reason,
      changedAt: this.#now(),
    });
  }

  /**
   * Clears an in-memory disable.
   *
   * Deliberately CANNOT clear the external lever: a provider held off by a flag
   * file stays off until the file is removed. Anything else would let one lever
   * silently undo another.
   */
  enable(provider: ProviderName): void {
    this.#state.set(provider, {
      enabled: true,
      reason: null,
      changedAt: this.#now(),
    });
  }

  /** Full state, for an admin endpoint or a health payload. */
  snapshot(): Record<ProviderName, ProviderSwitchState> {
    const out = {} as Record<ProviderName, ProviderSwitchState>;
    for (const p of ALL_PROVIDERS) {
      const state = this.#state.get(p) ?? {
        enabled: true,
        reason: null,
        changedAt: null,
      };
      // The snapshot is what `/metrics` and any operator readout show, so it
      // has to report the EFFECTIVE state. A snapshot that said "enabled" for a
      // provider the flag file is holding off would be the same class of defect
      // as `/v1/config` disagreeing with the maintenance gate.
      out[p] = this.isEnabled(p)
        ? state
        : { ...state, enabled: false, reason: this.reasonFor(p) };
    }
    return out;
  }
}

/** Maps a provider's switch and breaker state onto the `/v1/config` vocabulary. */
export function statusOf(
  enabled: boolean,
  breakerState: "closed" | "open" | "half_open",
): ProviderStatus {
  if (!enabled) return "disabled";
  return breakerState === "closed" ? "ok" : "degraded";
}

export { ALL_PROVIDERS };
