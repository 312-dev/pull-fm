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

export class KillSwitch {
  readonly #state = new Map<ProviderName, ProviderSwitchState>();
  readonly #now: () => number;

  constructor(
    initiallyDisabled: readonly ProviderName[] = [],
    now: () => number = () => Date.now(),
  ) {
    this.#now = now;
    for (const p of ALL_PROVIDERS) {
      this.#state.set(p, { enabled: true, reason: null, changedAt: null });
    }
    for (const p of initiallyDisabled) {
      this.disable(p, "disabled by configuration at startup");
    }
  }

  isEnabled(provider: ProviderName): boolean {
    return this.#state.get(provider)?.enabled ?? true;
  }

  reasonFor(provider: ProviderName): string | null {
    return this.#state.get(provider)?.reason ?? null;
  }

  disable(provider: ProviderName, reason: string): void {
    this.#state.set(provider, {
      enabled: false,
      reason,
      changedAt: this.#now(),
    });
  }

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
      out[p] = this.#state.get(p) ?? {
        enabled: true,
        reason: null,
        changedAt: null,
      };
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
