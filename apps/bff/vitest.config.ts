import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // The integration and security suites talk to a real Postgres and two real
    // Redis instances. Files still run in parallel workers: every test creates
    // its own subjects and every key is namespaced by subject id, so there is
    // no shared mutable state between files. Only the scratch-database reset is
    // serialised, by being idempotent.
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
