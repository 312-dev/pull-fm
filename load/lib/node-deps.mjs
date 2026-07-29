/**
 * Resolves `pg` and `jose` out of the workspace install.
 *
 * `load/` is deliberately not a pnpm workspace member and has no `node_modules`
 * of its own: `README.md` promises the mock upstream server imports nothing but
 * `node:*` and local files, and that promise is a safety property rather than a
 * style preference. A suite that pulls in a transitive dependency tree is a
 * suite that can be made to do something other than what it says.
 *
 * The operator tools (the local identity provider and the subject seeder) do
 * need a Postgres driver and a JOSE implementation, and vendoring either would
 * be worse than borrowing the copies the application already installed and
 * already trusts. Nothing under `load/scenarios/` or `load/mock-upstreams/`
 * imports this file, so the zero-dependency guarantee still holds where it was
 * made.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const anchor = new URL("../../apps/bff/package.json", import.meta.url);
const require = createRequire(anchor);

/**
 * Dynamic import by resolved path, so a package that ships CommonJS (`pg`) and
 * one that ships ESM (`jose`) both load through the same call.
 */
export async function load(name) {
  let resolved;
  try {
    resolved = require.resolve(name);
  } catch {
    throw new Error(
      `load/: cannot resolve "${name}" from apps/bff.\n` +
        `  Run \`pnpm install\` at the repository root first. The load tools\n` +
        `  borrow the application's copies rather than installing their own.`,
    );
  }
  return import(pathToFileURL(resolved).href);
}
