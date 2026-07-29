/**
 * Emits the OpenAPI 3.1 document to stdout.
 *
 *   pnpm --filter @pull-fm/bff openapi:emit > openapi.json
 *
 * The document is built by starting the real application (without binding a
 * port) and asking it for its own spec, so it cannot describe a route the
 * router does not have or omit one it does. That is what "the spec is the
 * source of truth" has to mean in practice; a hand-maintained file is a
 * description that drifts.
 *
 * No database, Redis, or identity provider is contacted: only route
 * registration runs. That matters because this command is step 1 of the
 * security pipeline in security/BOLA-TESTING.md section 8, and a spec emitter
 * that needs a live stack cannot run before the stack is up.
 *
 * Emission FAILS if any operation lacks an `x-pullfm-authz` classification.
 * That failure is deliberate and is Gate 3's "failing CI if any route lacks a
 * test" clause, raised here rather than in the enumerator so the message can
 * name the Fastify route.
 */

import { loadConfig, type Config } from "../config.js";
import { buildServer } from "../server.js";
import { buildServices } from "../wiring.js";

/**
 * Configuration sufficient to register routes and nothing more.
 *
 * Emitting a spec must not require production credentials, or the spec cannot
 * be regenerated in a pull request. Every value here is a syntactically valid
 * placeholder and none of them is used, because no handler runs.
 */
function specConfig(): Config {
  const placeholderKek = Buffer.alloc(32, 7).toString("base64");
  return loadConfig({
    NODE_ENV: "test",
    DEPLOY_ENV: "local",
    DATABASE_URL:
      process.env["DATABASE_URL"] ?? "postgres://spec:spec@127.0.0.1:5432/spec",
    REDIS_URL: process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379",
    REDIS_QUOTA_URL: process.env["REDIS_QUOTA_URL"] ?? "redis://127.0.0.1:6380",
    CREDENTIAL_KEKS: `kek:spec=${placeholderKek}`,
    CREDENTIAL_ACTIVE_KEK_ID: "kek:spec",
    WORKOS_CLIENT_ID: process.env["WORKOS_CLIENT_ID"] ?? "client_spec",
    // Deliberately does NOT use the sk_test_ prefix. Trivy's stripe-secret-token
    // rule matches that prefix on shape alone and ignores the word
    // "placeholder", so a gitleaks-safe value still failed the Trivy gate.
    // Config only requires a non-empty string here; no handler ever runs.
    WORKOS_API_KEY: "not-a-credential-openapi-emit-only",
    MUSICBRAINZ_USER_AGENT: "PullFM/0.1.0 (spec@pull.fm)",
    PUBLIC_BASE_URL: process.env["PUBLIC_BASE_URL"] ?? "https://api.pull.fm",
    LOG_LEVEL: "fatal",
  });
}

async function main(): Promise<void> {
  const cfg = specConfig();
  const services = buildServices(cfg, {
    error: () => undefined,
    warn: () => undefined,
  });

  // The reference browser bundle is several megabytes and is irrelevant to the
  // document, so it is not registered for this run.
  const app = await buildServer(cfg, { services, enableDocsBrowser: false });
  await app.ready();

  const document = app.swagger();
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);

  await app.close();
  // The pools were constructed lazily and never connected, so there is nothing
  // to drain; exiting explicitly keeps a stray handle from holding the process.
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `failed to emit the OpenAPI document:\n${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
