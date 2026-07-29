#!/usr/bin/env node
/**
 * Gate 8: every GitHub Actions reference must be pinned to a commit SHA, and
 * every container image to an immutable tag.
 *
 * A version tag is mutable. Whoever controls the upstream namespace can repoint
 * `@v4` at different code, and that code then runs inside a workflow that has
 * already checked out our source. A 40-character commit SHA cannot be moved.
 *
 * This exists because the risk register recorded exactly this gap
 * (PULLFM-RISK-002) and its own review notes asked for a lint so the regression
 * could not recur silently. Retiring the risk without the guard would just
 * schedule its return.
 *
 * Usage: node security/scripts/check-action-pinning.mjs [--dir <path>]
 * Exit:  0 all pinned, 1 an unpinned reference found, 2 usage or IO error.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let dir = ".github/workflows";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") {
    const next = args[i + 1];
    if (next === undefined) {
      console.error("--dir requires a path");
      process.exit(2);
    }
    dir = next;
    i++;
  } else if (args[i] === "--help") {
    console.log(
      "Usage: node security/scripts/check-action-pinning.mjs [--dir <path>]\n" +
        "Exit: 0 all pinned, 1 unpinned reference found, 2 usage or IO error.",
    );
    process.exit(0);
  }
}

/** Local composite actions and reusable workflows in-repo are not pinnable. */
const isLocalRef = (ref) => ref.startsWith("./") || ref.startsWith(".\\");

const SHA = /^[0-9a-f]{40}$/;

let files;
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
} catch (err) {
  console.error(`cannot read ${dir}: ${String(err.message)}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`no workflow files found in ${dir}`);
  process.exit(2);
}

const problems = [];
let checked = 0;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // AUDIT 2026-07-29: two ordinary YAML spellings of the same thing were
    // invisible to the original anchored pattern, and both are accepted by
    // GitHub Actions:
    //
    //   - { uses: attacker/action@main }     flow style, `uses:` mid-line
    //   - name: x
    //     uses:
    //       attacker/action@main             value on the following line
    //
    // Neither produced a finding, and because `checked` stayed at 0 the run
    // reported "OK 0 action/image reference(s) pinned" and exited 0. Parsing
    // nothing was indistinguishable from finding nothing wrong. The zero-check
    // at the end of this file closes that half; these two patterns close the
    // other. A block scalar is not handled and does not need to be: `uses:` in
    // a workflow is always a plain scalar.
    if (/(?:^|[\s{,])uses:\s*(?:#.*)?$/.test(line)) {
      const next = lines[idx + 1];
      const cont =
        next === undefined ? null : /^\s*["']?([^"'\s#]+)["']?/.exec(next);
      if (cont?.[1] && !isLocalRef(cont[1])) {
        checked++;
        const at = cont[1].lastIndexOf("@");
        if (at === -1 || !SHA.test(cont[1].slice(at + 1))) {
          problems.push(
            `${file}:${String(lineNo + 1)}: "${cont[1]}" (value on the line after \`uses:\`) ` +
              `is not pinned to a 40-char commit SHA.`,
          );
        }
      }
      return;
    }

    // `uses: owner/repo@ref` (ignoring any trailing version comment). The
    // leading context is `(?:^|[\s{,])` rather than `^\s*(?:-\s*)?` so flow
    // style (`{ uses: ... }`) and inline sequences are covered too.
    const uses = /(?:^|[\s{,])uses:\s*["']?([^"'\s#},]+)["']?/.exec(line);
    if (uses?.[1]) {
      const ref = uses[1];
      if (isLocalRef(ref)) return;
      checked++;
      const at = ref.lastIndexOf("@");
      if (at === -1) {
        problems.push(
          `${file}:${String(lineNo)}: "${ref}" has no version reference at all`,
        );
      } else if (!SHA.test(ref.slice(at + 1))) {
        problems.push(
          `${file}:${String(lineNo)}: "${ref}" is pinned to a mutable tag. ` +
            `Use the 40-char commit SHA with the version in a trailing comment.`,
        );
      }
      return;
    }

    // `image: name:tag`. A digest or an exact version is acceptable; `latest`
    // and a bare name are not.
    const image = /^\s*image:\s*["']?([^"'\s#]+)["']?/.exec(line);
    if (image?.[1]) {
      const ref = image[1];
      checked++;
      if (ref.includes("@sha256:")) return;
      const tag = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : "";
      if (tag === "" || tag === "latest" || tag === "edge" || tag === "main") {
        problems.push(
          `${file}:${String(lineNo)}: container image "${ref}" uses a mutable tag. ` +
            `Pin an exact version or a sha256 digest.`,
        );
      }
    }
  });
}

if (problems.length > 0) {
  for (const p of problems) console.error(`ERROR   ${p}`);
  console.error(
    `\nFAIL    ${String(problems.length)} unpinned reference(s). ` +
      `Gate 8 requires pinned tool versions: a tag can be repointed at different code, a SHA cannot.`,
  );
  process.exit(1);
}

// AUDIT 2026-07-29. "Zero references checked" is a parser failure wearing the
// costume of a clean result. The file-count guard above already refuses an
// empty directory; this refuses an empty PARSE, which is what a regex that
// stopped matching real workflow syntax produces. Every workflow in this
// repository uses at least `actions/checkout`, so zero can only mean the
// scanner broke.
if (checked === 0) {
  console.error(
    `FAIL    parsed ${String(files.length)} workflow file(s) and found no ` +
      `\`uses:\` or \`image:\` reference at all. That is a broken scanner, not a ` +
      `clean result: this repository's workflows all check out the repository.`,
  );
  process.exit(1);
}

console.log(
  `OK      ${String(checked)} action/image reference(s) pinned across ${String(files.length)} workflow(s)`,
);
process.exit(0);
