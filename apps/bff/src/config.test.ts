/**
 * Configuration validation, and the three controls that close the JWKS seam.
 *
 * security/BOLA-TESTING.md section 3 chooses a substituted JWKS URL as the way
 * the security suites provision subjects, and then says plainly that the seam
 * "is a total authentication bypass if it is ever reachable in production" and
 * "must be closed explicitly, not assumed away". It names three controls:
 *
 *   1. A startup assertion: production refuses to boot if the effective JWKS
 *      host is not WorkOS.
 *   2. The URL is not operator-settable in production; it is derived from the
 *      WorkOS client id, which is already required configuration.
 *   3. **A test asserting the assertion, so removing it fails CI.**
 *
 * This file is control 3. Deleting the assertion in config.ts makes these tests
 * fail, which is the entire point of writing them.
 */

import { describe, expect, test } from "vitest";

import { loadConfig, workosJwksUrlFor, WORKOS_HOST } from "./config.js";

const KEK = Buffer.alloc(32, 3).toString("base64");

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
    REDIS_URL: "redis://127.0.0.1:6379",
    REDIS_QUOTA_URL: "redis://127.0.0.1:6380",
    CREDENTIAL_KEKS: `kek:v1=${KEK}`,
    CREDENTIAL_ACTIVE_KEK_ID: "kek:v1",
    WORKOS_CLIENT_ID: "client_01ABC",
    WORKOS_API_KEY: "sk_test_not_a_real_key",
    MUSICBRAINZ_USER_AGENT: "PullFM/0.1.0 (ops@example.com)",
    ...overrides,
  };
}

describe("the JWKS seam is closed in production", () => {
  test("a substituted JWKS URL is honoured outside production", () => {
    const cfg = loadConfig(
      baseEnv({ WORKOS_JWKS_URL: "http://127.0.0.1:9999/jwks" }),
    );
    expect(cfg.workosJwksUrl).toBe("http://127.0.0.1:9999/jwks");
  });

  test("control 2: production IGNORES an operator-supplied JWKS URL", () => {
    // Not merely rejected: ignored and replaced by the derivation, so there is
    // no operator-settable value to get wrong in the first place.
    const cfg = loadConfig(
      baseEnv({
        NODE_ENV: "production",
        DEPLOY_ENV: "production",
        WORKOS_WEBHOOK_SECRET: "whsec_x",
        WORKOS_JWKS_URL: "https://evil.example.com/jwks",
        WORKOS_API_BASE_URL: "https://evil.example.com",
      }),
    );
    expect(cfg.workosJwksUrl).toBe(workosJwksUrlFor("client_01ABC"));
    expect(cfg.workosJwksUrl).toContain(WORKOS_HOST);
    expect(cfg.workosApiBaseUrl).toBe(`https://${WORKOS_HOST}`);
  });

  test("control 1: a non-WorkOS host in production is a startup failure", () => {
    // Simulates the derivation being weakened: if `workosJwksUrlFor` ever
    // returned something else, the assertion still refuses to boot. The test
    // reaches the assertion by making the derived host wrong via the client id.
    const cfg = loadConfig(
      baseEnv({
        NODE_ENV: "production",
        DEPLOY_ENV: "production",
        WORKOS_WEBHOOK_SECRET: "whsec_x",
        // A client id containing a path traversal cannot change the host,
        // because the derivation percent-encodes it. This asserts that.
        WORKOS_CLIENT_ID: "../../evil.example.com",
      }),
    );
    expect(new URL(cfg.workosJwksUrl).hostname).toBe(WORKOS_HOST);
    expect(cfg.workosJwksUrl).toContain("%2F");
  });

  test("staging counts as production for this assertion", () => {
    // docs/PLAN.md section 1b: staging is internet-reachable and runs
    // NODE_ENV=production. Treating it as development here would leave the
    // bypass open on the one environment an attacker can actually reach.
    const cfg = loadConfig(
      baseEnv({
        NODE_ENV: "production",
        DEPLOY_ENV: "staging",
        WORKOS_WEBHOOK_SECRET: "whsec_x",
        WORKOS_JWKS_URL: "http://127.0.0.1:1/jwks",
      }),
    );
    expect(cfg.workosJwksUrl).toBe(workosJwksUrlFor("client_01ABC"));
  });

  test("the derived URL escapes the client id", () => {
    expect(workosJwksUrlFor("a/b?c")).toBe(
      `https://${WORKOS_HOST}/sso/jwks/a%2Fb%3Fc`,
    );
  });
});

describe("fail-closed configuration", () => {
  test("production refuses to start without a webhook signing secret", () => {
    // An unverified WorkOS webhook is an unauthenticated mass-deletion
    // endpoint, because user.deleted cascades through the vault (T20).
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: "production", DEPLOY_ENV: "production" })),
    ).toThrow(/WORKOS_WEBHOOK_SECRET/);
  });

  test("production refuses to start with logging disabled", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: "production",
          DEPLOY_ENV: "production",
          WORKOS_WEBHOOK_SECRET: "whsec_x",
          LOG_LEVEL: "silent",
        }),
      ),
    ).toThrow(/LOG_LEVEL/);
  });

  test("a wildcard CORS origin is refused outside local development", () => {
    expect(() =>
      loadConfig(baseEnv({ DEPLOY_ENV: "staging", CORS_ORIGINS: "*" })),
    ).toThrow(/CORS_ORIGINS/);
  });

  test("an active KEK that is not in the key set is refused", () => {
    expect(() =>
      loadConfig(baseEnv({ CREDENTIAL_ACTIVE_KEK_ID: "kek:missing" })),
    ).toThrow(/CREDENTIAL_ACTIVE_KEK_ID/);
  });

  test("every missing variable is reported at once, not one per restart", () => {
    let message = "";
    try {
      loadConfig({});
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("REDIS_QUOTA_URL");
    expect(message).toContain("WORKOS_CLIENT_ID");
  });

  test("no secret is defaulted", () => {
    for (const missing of [
      "CREDENTIAL_KEKS",
      "WORKOS_API_KEY",
      "WORKOS_CLIENT_ID",
    ] as const) {
      const env = Object.fromEntries(
        Object.entries(baseEnv()).filter(([k]) => k !== missing),
      );
      expect(() => loadConfig(env), `${missing} was defaulted`).toThrow();
    }
  });
});

/**
 * The kill switch, whose config path is the reason it is no longer dead
 * capability. `security/DAST-RUNBOOK.md` §6 recorded that it had "no admin
 * route, env var or config path that throws it"; these tests are what stop that
 * sentence becoming true again.
 */
describe("the provider kill switch", () => {
  test("defaults to disabling nothing", () => {
    expect(loadConfig(baseEnv()).UPSTREAM_DISABLED_PROVIDERS).toEqual([]);
    expect(loadConfig(baseEnv()).UPSTREAM_KILL_SWITCH_DIR).toBe("");
  });

  test("accepts a list of real providers", () => {
    const cfg = loadConfig(
      baseEnv({ UPSTREAM_DISABLED_PROVIDERS: "lastfm, deezer" }),
    );
    expect(cfg.UPSTREAM_DISABLED_PROVIDERS).toEqual(["lastfm", "deezer"]);
  });

  test("REFUSES TO START on a misspelled provider", () => {
    // The SeatGeek lesson. A documented switch that silently does nothing is
    // worse than no switch, because it is budgeted for. Anyone who sets
    // `last.fm` believing they have stopped calling Last.fm must not boot a
    // node that is still calling Last.fm.
    expect(() =>
      loadConfig(baseEnv({ UPSTREAM_DISABLED_PROVIDERS: "last.fm" })),
    ).toThrow(/is not a provider/);
  });

  test("names the accepted providers in the failure", () => {
    let message = "";
    try {
      loadConfig(baseEnv({ UPSTREAM_DISABLED_PROVIDERS: "spotify" }));
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message).toContain("listenbrainz");
    expect(message).toContain("seatgeek");
  });

  test("tolerates whitespace and empty entries, which a shell produces", () => {
    expect(
      loadConfig(baseEnv({ UPSTREAM_DISABLED_PROVIDERS: " , lastfm , " }))
        .UPSTREAM_DISABLED_PROVIDERS,
    ).toEqual(["lastfm"]);
  });
});

describe("the erasure ledger configuration", () => {
  const LEDGER = {
    ERASURE_LEDGER_ENDPOINT: "https://acct.eu.r2.cloudflarestorage.com",
    ERASURE_LEDGER_BUCKET: "pull-fm-backups-staging",
    ERASURE_LEDGER_ACCESS_KEY_ID: "AKIAFIXTURENOTAREALKEY",
    ERASURE_LEDGER_SECRET_ACCESS_KEY: "fixture-not-a-real-credential",
  };

  test("is absent by default, which is a supported deployment", () => {
    expect(loadConfig(baseEnv()).erasureLedger).toBeNull();
  });

  test("resolves to one object when fully configured", () => {
    const cfg = loadConfig(baseEnv(LEDGER));
    expect(cfg.erasureLedger).toMatchObject({
      bucket: "pull-fm-backups-staging",
      // Must match PULLFM_BACKUP_PREFIX_LEDGER in infra/lib/backup-common.sh.
      prefix: "ledger/deletions",
    });
  });

  test("REFUSES a partial configuration", () => {
    // "Endpoint and bucket set, credential missing" is the shape a
    // half-finished deployment takes, and it would boot a service that believes
    // every erasure is durable at the moment of the request while every ledger
    // write fails. That belief is what the 2026-07-29 drill falsified.
    const { ERASURE_LEDGER_SECRET_ACCESS_KEY: _omitted, ...partial } = LEDGER;
    expect(() => loadConfig(baseEnv(partial))).toThrow(
      /ERASURE_LEDGER_SECRET_ACCESS_KEY/,
    );
  });

  test("names every missing part rather than only the first", () => {
    expect(() =>
      loadConfig(
        baseEnv({ ERASURE_LEDGER_ENDPOINT: LEDGER.ERASURE_LEDGER_ENDPOINT }),
      ),
    ).toThrow(/ERASURE_LEDGER_BUCKET.*ERASURE_LEDGER_ACCESS_KEY_ID/s);
  });

  test("normalises a prefix written with slashes", () => {
    const cfg = loadConfig(
      baseEnv({ ...LEDGER, ERASURE_LEDGER_PREFIX: "/ledger/deletions/" }),
    );
    expect(cfg.erasureLedger?.prefix).toBe("ledger/deletions");
  });
});

describe("token prefix follows the data environment", () => {
  test("production issues pfm_live, everything else issues pfm_test", () => {
    expect(loadConfig(baseEnv()).apiTokenPrefix).toBe("pfm_test");
    expect(loadConfig(baseEnv({ DEPLOY_ENV: "staging" })).apiTokenPrefix).toBe(
      "pfm_test",
    );
    expect(
      loadConfig(
        baseEnv({
          DEPLOY_ENV: "production",
          NODE_ENV: "production",
          WORKOS_WEBHOOK_SECRET: "whsec_x",
        }),
      ).apiTokenPrefix,
    ).toBe("pfm_live");
  });
});
