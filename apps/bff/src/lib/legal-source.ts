/**
 * Reads the canonical bytes of a legal document off the filesystem, and refuses
 * to hand back bytes that do not hash to what the registry recorded.
 *
 * WHAT WAS WRONG
 *
 * `GET /v1/me/consent` told a client the `url` of every document it had to
 * accept, and the client was required to fetch that text, hash it, and echo the
 * digest before `POST /v1/me/consent` would record anything. NOTHING SERVED THE
 * DOCUMENTS. So the agreements process was unusable in both directions: a client
 * could not display what it was asking a person to agree to, and could not
 * produce a digest the API would accept. The whole gate was a lock with no door
 * behind it.
 *
 * ---------------------------------------------------------------------------
 * WHY A DIGEST CHECK ON A READ, WHICH LOOKS REDUNDANT
 *
 * `legal-versions.test.ts` already fails CI when a file under `legal/` drifts
 * from the registry, so at the moment an image is built the two agree. This
 * verifies it AGAIN at read time, and the reason is that the two artefacts can
 * come apart after the build:
 *
 *   - A bind mount, a volume, or a `COPY` that lands a different revision of
 *     `legal/` next to this code. CI never sees that combination.
 *   - `LEGAL_SOURCE_DIR` pointed somewhere by an operator.
 *   - A partial write or a truncated layer.
 *
 * In every one of those, serving the bytes anyway is the worst available outcome.
 * The client hashes what it received, gets a value that is not the published
 * digest, and `POST /v1/me/consent` answers 409 - so the user is shown a document,
 * agrees to it, and is refused, with the failure surfacing three calls away from
 * its cause. Returning null here instead turns that into one specific 503 on the
 * document endpoint itself. SERVING NOTHING IS BETTER THAN SERVING SOMETHING
 * UNACCEPTABLE, because the digest is the thing the acceptance is recorded
 * against.
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  legalDigest,
  normalizeLegalText,
  type LegalDocument,
} from "./legal-documents.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Produces the canonical text for a registry entry, or null if this deployment
 * cannot produce it.
 *
 * A function rather than a class because there is one operation and because the
 * consent service takes it as a seam: the synthetic documents the consent suite
 * builds point at paths that do not exist, and they must go on producing null
 * rather than failing.
 */
export type LegalTextSource = (doc: LegalDocument) => string | null;

/** A source that can never produce anything. The default for a test registry. */
export const noLegalTextSource: LegalTextSource = () => null;

/**
 * Finds the directory holding `legal/`.
 *
 * PROBED IN BOTH LAYOUTS RATHER THAN CONFIGURED, for the same reason
 * `packages/db/scripts/migrate.mjs` probes for its migrations directory and
 * `scripts/refresh-mb-canonical.ts` probes for its loader: an environment
 * variable that has to be remembered on the deploy path is one more thing that
 * is missing the first time it matters, and the first time this one matters is
 * the first time a user is asked to accept the Terms.
 *
 *   dist/lib   -> ../..            the runtime image, where `pnpm deploy` puts
 *                                  the app at /app and the Dockerfile copies
 *                                  `legal/` to /app/legal.
 *   src/lib    -> ../../../..      a checkout, where `legal/` is at the repo
 *                                  root. Also the compiled-in-a-checkout case,
 *                                  which is why both candidates are tried in
 *                                  order rather than one being selected by
 *                                  NODE_ENV.
 *
 * `LEGAL_SOURCE_DIR` overrides both, for anyone whose layout is neither.
 */
export function resolveLegalRoot(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const override = env["LEGAL_SOURCE_DIR"];
  if (override !== undefined && override !== "") return resolve(override);

  const candidates = [
    resolve(join(HERE, "..", "..")),
    resolve(join(HERE, "..", "..", "..", "..")),
  ];
  for (const candidate of candidates) {
    if (exists(join(candidate, "legal"))) return candidate;
  }
  return null;
}

export interface FileSystemSourceOptions {
  /** Overrides the probe. Absolute. */
  readonly root?: string | null;
  /**
   * Called when a document could not be produced, with a reason a human can
   * act on.
   *
   * NOT optional in practice, and the reason it exists at all: without it the
   * failure mode is an image that boots cleanly, publishes revisions with no
   * text, and answers 503 on the consent screen of the first user who ever tries
   * to sign up. A missing legal directory has to be visible at startup rather
   * than in a support ticket.
   */
  readonly onUnavailable?: (documentId: string, reason: string) => void;
}

/**
 * The real source: read `doc.path` under the resolved root, normalise, verify.
 *
 * NORMALISED ON THE WAY OUT, not just hashed. `normalizeLegalText` is idempotent
 * (asserted in legal-versions.test.ts), so the normalised text is a fixed point
 * of the normalisation and a plain sha256 of it equals the recorded digest. That
 * is what lets the served bytes be hashed directly by a client with no
 * normalisation step of its own, which is one fewer thing for a client in another
 * language to get subtly wrong. See routes/v1/legal.ts.
 */
export function fileSystemLegalSource(
  options: FileSystemSourceOptions = {},
): LegalTextSource {
  const root = options.root === undefined ? resolveLegalRoot() : options.root;
  const report = options.onUnavailable ?? ((): void => undefined);

  return (doc) => {
    if (root === null) {
      report(
        doc.id,
        "no directory containing legal/ could be found next to the application or at the " +
          "repository root. In a container image this means the build did not COPY legal/. " +
          "Set LEGAL_SOURCE_DIR to override the probe.",
      );
      return null;
    }

    const file = join(root, doc.path);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      report(doc.id, `${doc.path} could not be read under ${root}`);
      return null;
    }

    const text = normalizeLegalText(raw);
    const digest = legalDigest(text);
    if (digest !== doc.contentSha256) {
      // Deliberately NOT self-healing and deliberately not served. The registry
      // digest is the control: if the bytes on disk disagree with it, either the
      // file changed without the materiality decision being made (which
      // legal-versions.test.ts exists to catch, and which is the operator's call,
      // not ours) or the wrong revision of legal/ is mounted. Either way these
      // bytes cannot be accepted, so handing them to a client would only move
      // the failure to POST /v1/me/consent.
      report(
        doc.id,
        `${doc.path} hashes to ${digest} but the registry records ` +
          `${doc.contentSha256}. The file on disk is not the published text.`,
      );
      return null;
    }
    return text;
  };
}
