/**
 * The BFF test runner.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A `pretest` HOOK IN package.json
 *
 * `@pull-fm/crypto`, `@pull-fm/discovery` and `@pull-fm/upstream` are workspace
 * packages whose `exports` point at `./dist`, not at `./src`. Node therefore
 * resolves them to COMPILED OUTPUT, so this suite tests whatever was last built
 * rather than what is currently on disk. Running `pnpm -r test` without a build
 * first silently exercises stale JavaScript: a fix appears not to work, a
 * regression appears not to exist, and the test output is confidently wrong in
 * both directions. That has already cost one debugging session.
 *
 * The hook is on THIS package rather than at the workspace root, and that is
 * the whole point of where it sits. `pnpm -r` excludes the root package by
 * default, so a root-level `pretest` would not fire for `pnpm -r test`, which
 * is the exact command the hazard appears under. The staleness belongs to the
 * consumer of a `dist`-exporting package, so the guard belongs there too. Any
 * future package that imports a workspace package needs the same three words in
 * its own manifest.
 *
 * The alternative - aliasing the workspace packages to their sources here - was
 * rejected deliberately. It would remove the hazard by removing the artifact:
 * the suites, including the security ones, would stop exercising the compiled
 * output that actually ships, and an error that only appears after compilation
 * (an `exports` map that omits a subpath, a type-only import emitted as a real
 * one) would become invisible to every test in the repository.
 * ---------------------------------------------------------------------------
 */

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
