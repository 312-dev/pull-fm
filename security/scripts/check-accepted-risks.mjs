#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull.fm - accepted risk register validator
//
// Gate 8 (docs/PLAN.md §7): "every accepted risk in security/accepted-risks.md
// has an owner and expiry date, and CI fails on an expired entry."
//
// Exit codes:
//   0  every entry parsed, validated, and unexpired
//   1  at least one entry is expired or malformed  <- the Gate 8 failure
//   2  usage error, or the register file is missing/unreadable
//
// Zero dependencies, on purpose. This runs in CI before `pnpm install` needs to
// have succeeded, so it must work with nothing but a Node 22 binary and the
// checked-out repository. That constraint is also why the register is written
// in a restricted YAML subset rather than full YAML: see accepted-risks.md
// "Why YAML frontmatter rather than a table or a separate data file".
//
// Usage:
//   node security/scripts/check-accepted-risks.mjs [options]
//     --file <path>    register to validate (default: security/accepted-risks.md)
//     --json           emit findings as JSON on stdout instead of text
//     --now <date>     evaluate expiry as at YYYY-MM-DD (TESTING ONLY)
//     --warn-days <n>  warn about entries expiring within n days (default 14)
//     --quiet          suppress the OK summary; findings still print
//     --help
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTER = resolve(HERE, "..", "accepted-risks.md");

// --- Schema -----------------------------------------------------------------
// Kept in one place so accepted-risks.md's documented schema and this validator
// cannot drift apart without one of them looking obviously wrong.

const SCHEMA_VERSION = 1;

const REQUIRED_FIELDS = [
  "id",
  "title",
  "status",
  "severity",
  "threat_ids",
  "description",
  "justification",
  "compensating_controls",
  "owner",
  "accepted_on",
  "expires_on",
  "review_notes",
  "example",
];

const OPTIONAL_FIELDS = [];

const STATUSES = ["accepted", "retired"];
const SEVERITIES = ["critical", "high", "medium", "low"];

// Maximum days an acceptance may run before it must be re-argued. Without this,
// `expires_on: 2099-01-01` defeats the gate while technically satisfying it.
// Scaling by severity means a critical acceptance is re-decided monthly, which
// is roughly where renewing costs more than fixing.
const MAX_LIFETIME_DAYS = {
  critical: 30,
  high: 90,
  medium: 180,
  low: 366,
};

// Minimum prose lengths. These exist to stop "n/a" and "later" from passing as
// reasoning. They are deliberately low enough that a real one-sentence answer
// clears them and a non-answer does not.
const MIN_LENGTH = {
  title: 10,
  description: 80,
  justification: 80,
  compensating_controls: 40,
  review_notes: 20,
};

const MAX_LENGTH = { title: 120 };

const ID_RE = /^PULLFM-RISK-\d{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const THREAT_ID_RE = /^(?:T\d{2,3}|ADV-\d+|AT-\d+)$/;
const OWNER_RE = /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|@[A-Za-z0-9][A-Za-z0-9-]*)$/;

// --- Restricted YAML subset parser -----------------------------------------
// Handles exactly the shapes accepted-risks.md documents and throws on anything
// else. Failing closed matters more than being permissive here: a lenient
// parser that silently mis-reads the register would let an expired entry pass,
// which is the one outcome this script exists to prevent.
//
// Supported:
//   key: value                 (indent 0)  root scalar
//   key:                       (indent 0)  root list, items at indent 2
//     - key: value             (indent 2)  start of a mapping entry
//       key: value             (indent 4)  entry field
//       key:                   (indent 4)  entry field holding a scalar list
//         - value              (indent 6)  list item
//
// Not supported (and rejected): anchors, aliases, tags, block scalars, flow
// collections, nested mappings inside entries, tabs, and odd indentation.

class RegisterParseError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line;
  }
}

function unquote(raw, lineNo) {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.includes(" #")) {
    // An unquoted scalar with a trailing comment is ambiguous in real YAML and
    // a common source of "why is my value truncated". Reject rather than guess.
    throw new RegisterParseError(
      `unquoted value contains " #"; quote the value or move the comment: ${v}`,
      lineNo,
    );
  }
  return v;
}

function coerce(raw, lineNo) {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === "" || v === "~" || v === "null") return null;
  return unquote(v, lineNo);
}

function extractFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new RegisterParseError(
      "file must begin with a `---` frontmatter fence",
      1,
    );
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      // Return with 1-based original line numbers preserved for error messages.
      return lines
        .slice(1, i)
        .map((content, idx) => ({ content, no: idx + 2 }));
    }
  }
  throw new RegisterParseError("frontmatter is never closed by a second `---`");
}

function parseRegister(text) {
  const root = {};
  let currentList = null; // array being appended to at indent 2
  let currentEntry = null; // mapping being populated at indent 4
  let currentEntryList = null; // { key, values } for a scalar list at indent 6

  for (const { content, no } of extractFrontmatter(text)) {
    if (content.includes("\t")) {
      throw new RegisterParseError("tabs are not allowed; use two spaces", no);
    }
    const line = content.replace(/\s+$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) {
      throw new RegisterParseError(
        `indent ${indent} is not a multiple of 2`,
        no,
      );
    }
    const body = line.trimStart();

    if (indent === 0) {
      currentList = null;
      currentEntry = null;
      currentEntryList = null;
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(body);
      if (!m)
        throw new RegisterParseError(
          `expected \`key: value\`, got: ${body}`,
          no,
        );
      const [, key, rest] = m;
      if (rest === "") {
        root[key] = [];
        currentList = root[key];
      } else {
        root[key] = coerce(rest, no);
      }
      continue;
    }

    if (indent === 2) {
      currentEntryList = null;
      if (!currentList) {
        throw new RegisterParseError(
          "list item without an enclosing list key",
          no,
        );
      }
      const m = /^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(body);
      if (!m) {
        throw new RegisterParseError(
          `expected a list item of the form \`- key: value\`, got: ${body}`,
          no,
        );
      }
      const [, key, rest] = m;
      currentEntry = { __line: no };
      currentList.push(currentEntry);
      currentEntry[key] = rest === "" ? [] : coerce(rest, no);
      if (rest === "") currentEntryList = { key, values: currentEntry[key] };
      continue;
    }

    if (indent === 4) {
      currentEntryList = null;
      if (!currentEntry)
        throw new RegisterParseError("field outside any list entry", no);
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(body);
      if (!m)
        throw new RegisterParseError(
          `expected \`key: value\`, got: ${body}`,
          no,
        );
      const [, key, rest] = m;
      if (Object.hasOwn(currentEntry, key)) {
        throw new RegisterParseError(
          `duplicate field \`${key}\` in the same entry`,
          no,
        );
      }
      if (rest === "") {
        currentEntry[key] = [];
        currentEntryList = { key, values: currentEntry[key] };
      } else {
        currentEntry[key] = coerce(rest, no);
      }
      continue;
    }

    if (indent === 6) {
      if (!currentEntryList) {
        throw new RegisterParseError(
          "list item without an enclosing field",
          no,
        );
      }
      const m = /^-\s+(.*)$/.exec(body);
      if (!m)
        throw new RegisterParseError(`expected \`- value\`, got: ${body}`, no);
      currentEntryList.values.push(coerce(m[1], no));
      continue;
    }

    throw new RegisterParseError(`unsupported indent level ${indent}`, no);
  }

  return root;
}

// --- Date helpers -----------------------------------------------------------
// UTC throughout. The operator travels; the register must not change verdict
// because a laptop is in a different timezone than the CI runner.

function parseDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const ts = Date.UTC(y, m - 1, d);
  const dt = new Date(ts);
  // Round-trip check rejects 2026-02-30 and friends, which Date.UTC silently
  // rolls over rather than failing on.
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

const DAY_MS = 86_400_000;
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / DAY_MS);
const isoDate = (d) => d.toISOString().slice(0, 10);

// --- Validation -------------------------------------------------------------

function validate(register, now) {
  const findings = [];
  const add = (level, id, field, message) =>
    findings.push({ level, id, field, message });

  if (register.schema_version !== SCHEMA_VERSION) {
    add(
      "error",
      null,
      "schema_version",
      `expected ${SCHEMA_VERSION}, got ${JSON.stringify(register.schema_version)}. ` +
        "The register format changed; update this validator deliberately rather than the file.",
    );
    return findings;
  }

  const entries = register.register;
  if (!Array.isArray(entries)) {
    add("error", null, "register", "missing or not a list");
    return findings;
  }
  if (entries.length === 0) {
    // Not an error. An empty register is a legitimate and desirable state, and
    // failing on it would create pressure to keep stale entries around.
    return findings;
  }

  const seen = new Map();

  for (const entry of entries) {
    const id =
      typeof entry.id === "string"
        ? entry.id
        : `<entry at line ${entry.__line}>`;

    // -- shape
    for (const field of REQUIRED_FIELDS) {
      if (!Object.hasOwn(entry, field))
        add("error", id, field, "required field is missing");
    }
    for (const key of Object.keys(entry)) {
      if (key === "__line") continue;
      if (!REQUIRED_FIELDS.includes(key) && !OPTIONAL_FIELDS.includes(key)) {
        add(
          "error",
          id,
          key,
          "unknown field; the schema is closed, so a typo cannot hide here",
        );
      }
    }

    // -- id
    if (typeof entry.id !== "string" || !ID_RE.test(entry.id)) {
      add("error", id, "id", "must match PULLFM-RISK-NNN");
    } else if (seen.has(entry.id)) {
      add(
        "error",
        id,
        "id",
        `duplicate of the entry at line ${seen.get(entry.id)}`,
      );
    } else {
      seen.set(entry.id, entry.__line);
    }

    // -- enums
    if (!STATUSES.includes(entry.status)) {
      add("error", id, "status", `must be one of ${STATUSES.join(", ")}`);
    }
    if (!SEVERITIES.includes(entry.severity)) {
      add("error", id, "severity", `must be one of ${SEVERITIES.join(", ")}`);
    }

    // -- prose fields
    for (const [field, min] of Object.entries(MIN_LENGTH)) {
      const v = entry[field];
      if (typeof v !== "string") {
        if (Object.hasOwn(entry, field))
          add("error", id, field, "must be a string");
        continue;
      }
      if (v.trim().length < min) {
        add(
          "error",
          id,
          field,
          `is ${v.trim().length} characters; at least ${min} required. ` +
            "A register entry that cannot be explained is not an accepted risk, it is an unknown one.",
        );
      }
      const max = MAX_LENGTH[field];
      if (max && v.trim().length > max) {
        add(
          "error",
          id,
          field,
          `is ${v.trim().length} characters; at most ${max} allowed`,
        );
      }
    }

    // -- threat_ids
    if (!Array.isArray(entry.threat_ids) || entry.threat_ids.length === 0) {
      add(
        "error",
        id,
        "threat_ids",
        "must be a non-empty list of THREAT-MODEL.md threat ids",
      );
    } else {
      for (const t of entry.threat_ids) {
        if (typeof t !== "string" || !THREAT_ID_RE.test(t)) {
          add(
            "error",
            id,
            "threat_ids",
            `"${t}" is not a THREAT-MODEL.md id (Tnn, ADV-n, AT-n)`,
          );
        }
      }
    }

    // -- owner
    if (typeof entry.owner !== "string" || !OWNER_RE.test(entry.owner.trim())) {
      add("error", id, "owner", "must be an email address or a @handle");
    }

    // -- example
    if (typeof entry.example !== "boolean") {
      add("error", id, "example", "must be true or false");
    }

    // -- dates
    const accepted = parseDate(entry.accepted_on);
    const expires = parseDate(entry.expires_on);
    if (!accepted)
      add("error", id, "accepted_on", "must be a real date in YYYY-MM-DD form");
    if (!expires)
      add("error", id, "expires_on", "must be a real date in YYYY-MM-DD form");

    if (accepted && expires) {
      if (daysBetween(accepted, expires) <= 0) {
        add("error", id, "expires_on", "must be after accepted_on");
      }
      if (daysBetween(now, accepted) > 0) {
        add("error", id, "accepted_on", "is in the future");
      }
      const max = MAX_LIFETIME_DAYS[entry.severity];
      if (max !== undefined) {
        const life = daysBetween(accepted, expires);
        if (life > max) {
          add(
            "error",
            id,
            "expires_on",
            `acceptance window is ${life} days; the maximum for severity "${entry.severity}" is ${max}. ` +
              "Shorten the window or lower the severity with a justification.",
          );
        }
      }

      // -- the Gate 8 assertion itself
      if (entry.status === "accepted") {
        const remaining = daysBetween(now, expires);
        if (remaining < 0) {
          add(
            "error",
            id,
            "expires_on",
            `EXPIRED ${-remaining} day(s) ago (${entry.expires_on}). ` +
              "Renew with fresh reasoning, retire it, or fix the underlying issue.",
          );
        }
      } else if (entry.status === "retired") {
        // Retired entries are history and are exempt from expiry, but they must
        // still say why they were closed or the audit trail is worthless.
        if (
          typeof entry.review_notes === "string" &&
          entry.review_notes.trim().length < 20
        ) {
          add(
            "error",
            id,
            "review_notes",
            "a retired entry must record why it was closed",
          );
        }
      }
    }
  }

  return findings;
}

function warnings(register, now, warnDays) {
  const out = [];
  for (const entry of register.register ?? []) {
    if (entry.status !== "accepted") continue;
    const expires = parseDate(entry.expires_on);
    if (!expires) continue;
    const remaining = daysBetween(now, expires);
    if (remaining >= 0 && remaining <= warnDays) {
      out.push({
        level: "warning",
        id: entry.id,
        field: "expires_on",
        message: `expires in ${remaining} day(s) (${entry.expires_on})`,
      });
    }
  }
  return out;
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    file: DEFAULT_REGISTER,
    json: false,
    now: null,
    warnDays: 14,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--file") opts.file = take();
    else if (a.startsWith("--file=")) opts.file = a.slice(7);
    else if (a === "--now") opts.now = take();
    else if (a.startsWith("--now=")) opts.now = a.slice(6);
    else if (a === "--warn-days") opts.warnDays = Number(take());
    else if (a.startsWith("--warn-days=")) opts.warnDays = Number(a.slice(12));
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

const USAGE = `Usage: node security/scripts/check-accepted-risks.mjs [options]

  --file <path>    register to validate (default: security/accepted-risks.md)
  --json           emit findings as JSON
  --now <date>     evaluate expiry as at YYYY-MM-DD. TESTING ONLY: CI must never
                   pass this, or the gate can be trivially back-dated.
  --warn-days <n>  warn about entries expiring within n days (default 14)
  --quiet          suppress the OK summary
  --help

Exit: 0 valid, 1 expired or malformed, 2 usage or IO error.`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  if (!Number.isInteger(opts.warnDays) || opts.warnDays < 0) {
    process.stderr.write("--warn-days must be a non-negative integer\n");
    process.exit(2);
  }

  let now;
  if (opts.now) {
    now = parseDate(opts.now);
    if (!now) {
      process.stderr.write(
        `--now must be a real date in YYYY-MM-DD form, got: ${opts.now}\n`,
      );
      process.exit(2);
    }
  } else {
    const d = new Date();
    now = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }

  let text;
  try {
    text = readFileSync(opts.file, "utf8");
  } catch (err) {
    process.stderr.write(
      `cannot read register at ${opts.file}: ${err.message}\n`,
    );
    process.exit(2);
  }

  let register;
  try {
    register = parseRegister(text);
  } catch (err) {
    const finding = {
      level: "error",
      id: null,
      field: "<parse>",
      message: `${err.message}. The register must stay inside the documented YAML subset.`,
    };
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, file: opts.file, findings: [finding] }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`ERROR  ${opts.file}: ${finding.message}\n`);
    }
    process.exit(1);
  }

  const errors = validate(register, now);
  const warns = warnings(register, now, opts.warnDays);
  const all = [...errors, ...warns];
  const ok = errors.length === 0;
  const count = Array.isArray(register.register) ? register.register.length : 0;

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ ok, file: opts.file, asOf: isoDate(now), entries: count, findings: all }, null, 2)}\n`,
    );
    process.exit(ok ? 0 : 1);
  }

  for (const f of all) {
    const stream = f.level === "error" ? process.stderr : process.stdout;
    const where = f.id ? `${f.id}.${f.field}` : f.field;
    stream.write(`${f.level.toUpperCase().padEnd(7)} ${where}: ${f.message}\n`);
  }

  if (ok && !opts.quiet) {
    process.stdout.write(
      `OK      ${count} accepted risk(s) valid as at ${isoDate(now)}` +
        (warns.length ? `, ${warns.length} expiring soon\n` : "\n"),
    );
  }
  if (!ok) {
    process.stderr.write(
      `\nFAIL    ${errors.length} problem(s) in ${opts.file}. ` +
        "Gate 8 requires every accepted risk to be well-formed and unexpired.\n",
    );
  }
  process.exit(ok ? 0 : 1);
}

main();
