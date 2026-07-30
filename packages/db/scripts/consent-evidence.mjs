#!/usr/bin/env node
/**
 * Pull.fm - produce a consent evidence bundle an auditor can check without us.
 *
 * WHAT WAS WRONG
 *
 * Migrations 0008 and 0009 record, per subject, which version of which document
 * they accepted, when, on which session, with the digest of the exact text, in
 * append-only tables an UPDATE cannot rewrite; and they store the text itself. The
 * schema could answer every question a dispute asks. NOTHING COULD GET THE ANSWERS
 * OUT. There was no query, no report, and no artefact. Evidence that requires
 * somebody to improvise SQL under time pressure is evidence in the same sense that
 * an unrun backup is a backup.
 *
 * The five questions this exists to answer, which are the ones actually asked:
 *
 *   1. Everything about one subject's consent history, as one artifact.
 *   2. The exact text a given person agreed to, at the version they agreed to.
 *   3. Who has not accepted the current epoch.
 *   4. What changed between two versions, and who re-consented after it.
 *   5. Proof the records have not been altered.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND A DIRECTORY, RATHER THAN AN ENDPOINT
 *
 * An external auditor does not get credentials to a production API, so an
 * authenticated endpoint would be read by the operator and pasted into an email,
 * which is a bundle with extra steps and no manifest. It would also be a
 * permanently reachable route returning every user's consent history and IP
 * addresses, live, for the sake of a report produced a handful of times in a
 * product's life: a standing hole for an occasional need. `infra/cost.sh` and
 * `packages/db/scripts/verify-query-ceilings.mjs` are the precedent, and this
 * follows them.
 *
 * A DIRECTORY AND NOT AN ARCHIVE. Node has no bundled archiver, adding one for
 * this would be a dependency in the deployment tree for an operator task, and a
 * directory is inspectable with a text editor. The integrity artefact is
 * `SHA256SUMS` in ordinary coreutils format, so the recipient verifies it with
 * `sha256sum -c SHA256SUMS` and needs no tool of ours. `tar czf` afterwards is the
 * recipient's business.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PROPERTIES OF THE PRODUCER THAT MATTER
 *
 * ONE SNAPSHOT. Everything is read inside a single REPEATABLE READ transaction, so
 * no two sections of a bundle can disagree with each other. A bundle whose
 * outstanding cohort was computed a second after its consent rows would be a
 * report that is individually true and collectively wrong.
 *
 * READ ONLY, ENFORCED BY THE DATABASE. The transaction is opened READ ONLY, so
 * PRODUCING THE EVIDENCE CANNOT ALTER THE EVIDENCE, and that is asserted by
 * Postgres rather than by this file's good intentions.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE BUNDLE PROVES AND WHAT IT ONLY ASSERTS
 *
 * `docs/compliance/consent-evidence.md` is the authoritative statement and it is
 * copied VERBATIM into every bundle as `BOUNDARY.md`, so an auditor reads the
 * limits at the same time as the records and the two cannot drift. The short
 * version: the record proves a request arrived carrying the right version and
 * digest, on an interactive session, at a recorded time, unrewritten since. It does
 * NOT prove a screen was rendered or that a human saw anything. Do not let this
 * script's output imply otherwise.
 *
 * ---------------------------------------------------------------------------
 * REDACTION, AND THE DELIBERATE ASYMMETRY WITH THE SUBJECT'S OWN EXPORT
 *
 * `GET /v1/me/export` gives a subject their consent history and EXCLUDES `ip` and
 * `user_agent`, because they corroborate the act for our benefit rather than being
 * data the subject provided. An evidence bundle is precisely the "our benefit"
 * case, so those fields are available here - and still redacted by default, to a
 * PRESENCE FLAG (`ipPresent: true`), which answers "was the act corroborated"
 * without putting an address in a file that will be emailed.
 *
 * `--unredact` requires `--reason`, and the reason is written into the bundle, so
 * an unredacted bundle carries the justification for its own existence.
 *
 * THE COHORT LISTING IS NEVER UNREDACTABLE. "Who has not accepted" is answered by
 * a count and a list of opaque user ids; email addresses never appear in it under
 * any flag. A roster of every user's address is a data-exfiltration path wearing a
 * compliance label, and corroborating details of an act that has not happened do
 * not exist.
 *
 * ---------------------------------------------------------------------------
 * THE ONE COUPLING TO THE APPLICATION, STATED SO IT IS NOT A SURPRISE
 *
 * The database records what was PUBLISHED. It does not record which documents
 * require ACCEPTANCE, because that is a property of the running gate. So question 3
 * cannot be answered from SQL alone, and this script reads the required set out of
 * `apps/bff/src/lib/legal-documents.ts` with a narrow parser, records in the
 * manifest that it did, and REFUSES rather than guessing if the parse fails.
 * `--required` overrides it for anyone running outside a checkout. A published
 * document that is not in the required set is reported as such rather than counted
 * as outstanding for every user, which is what `consent-presentation` is: published
 * and versioned like a document, never accepted like one.
 *
 * Exit codes:
 *   0  a bundle was written and every integrity check inside it passed
 *   1  a bundle was written AND SOMETHING IS WRONG: an append-only protection this
 *      bundle asserts is missing from the live database, or a stored text does not
 *      hash to the digest recorded beside it. The bundle is still written, because
 *      a finding is evidence too.
 *   2  usage error, no connection string, or the required set could not be resolved
 *
 * Usage:
 *   PGURL_ITEM='pull-fm/staging/DATABASE_URL' \
 *     node packages/db/scripts/consent-evidence.mjs --out ./evidence-run
 *
 *   node packages/db/scripts/consent-evidence.mjs --out DIR [options]
 *     --subject <uuid|email>     add a dossier for one subject
 *     --revision <id@vA..vB>     add a diff between two published versions and the
 *                                list of subjects who re-consented after it
 *     --unredact --reason TEXT    include ip, user_agent, session_id and email in
 *                                the subject dossier. Both flags or neither.
 *     --required a,b             the documents acceptance is required of, when the
 *                                registry cannot be read
 *     --max-roster N             cap the outstanding roster (default 10000)
 *     --json                     summary as JSON on stdout
 *     --quiet                    findings only
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, "..", "..", ".."));
const REGISTRY = join(ROOT, "apps", "bff", "src", "lib", "legal-documents.ts");
const BOUNDARY = join(ROOT, "docs", "compliance", "consent-evidence.md");

/**
 * Redacts a connection string wherever one could reach output.
 *
 * The same scrubber `verify-query-ceilings.mjs` applies to every emitted line, and
 * for the same reason: a bundle is a file somebody forwards, and a DSN that reached
 * an error message inside it would be a credential disclosure attached to a
 * compliance artefact.
 */
const scrub = (value) =>
  String(value).replace(
    /(postgres(?:ql)?:\/\/[^:@/\s]+:)[^@\s]*@/gi,
    "$1<REDACTED>@",
  );

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Diagnostics to stderr, so stdout stays a capturable value. */
const out = [];
const findings = [];
const notes = [];
const say = (message) => out.push(scrub(message));
const finding = (message) => findings.push(scrub(message));
const note = (message) => notes.push(scrub(message));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    outDir: null,
    subject: null,
    revision: null,
    unredact: false,
    reason: null,
    required: null,
    maxRoster: 10000,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) usage(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--out":
        opts.outDir = next();
        break;
      case "--subject":
        opts.subject = next();
        break;
      case "--revision":
        opts.revision = next();
        break;
      case "--unredact":
        opts.unredact = true;
        break;
      case "--reason":
        opts.reason = next();
        break;
      case "--required":
        opts.required = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--max-roster":
        opts.maxRoster = Number.parseInt(next(), 10);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--help":
      case "-h":
        usage(null);
        break;
      default:
        usage(`unrecognised argument: ${arg}`);
    }
  }

  if (opts.outDir === null) usage("--out DIR is required");
  if (!Number.isInteger(opts.maxRoster) || opts.maxRoster < 1) {
    usage("--max-roster must be a positive integer");
  }

  // BOTH FLAGS OR NEITHER, and this is the whole control on unredaction. A file
  // containing IP addresses and session ids that does not say why it was made is a
  // file nobody can justify holding six months later.
  if (
    opts.unredact &&
    (opts.reason === null || opts.reason.trim().length < 8)
  ) {
    usage(
      "--unredact requires --reason with a real explanation of at least 8 characters. " +
        "The reason is written into the bundle, because an unredacted bundle has to " +
        "carry the justification for its own existence.",
    );
  }
  if (!opts.unredact && opts.reason !== null) {
    usage("--reason is only meaningful with --unredact");
  }
  if (opts.unredact && opts.subject === null) {
    usage(
      "--unredact only affects a subject dossier, and no --subject was given. The " +
        "outstanding cohort is never unredactable; see docs/compliance/consent-evidence.md.",
    );
  }

  return opts;
}

function usage(problem) {
  if (problem !== null) console.error(`\n${problem}\n`);
  console.error(
    [
      "Usage:",
      "  PGURL_ITEM='pull-fm/staging/DATABASE_URL' \\",
      "    node packages/db/scripts/consent-evidence.mjs --out DIR [options]",
      "",
      "  --subject <uuid|email>    add a dossier for one subject",
      "  --revision <id@vA..vB>    add a diff and the re-consent list for it",
      "  --unredact --reason TEXT  include ip, user_agent, session_id, email",
      "  --required a,b            required documents, if the registry is unreadable",
      "  --max-roster N            cap the outstanding roster (default 10000)",
      "  --json                    summary as JSON on stdout",
      "  --quiet                   findings only",
      "",
      "Reads DATABASE_URL, or resolves PGURL_ITEM from 1Password.",
      "Read-only: the whole bundle is produced in one REPEATABLE READ, READ ONLY",
      "transaction, so producing the evidence cannot alter it.",
    ].join("\n"),
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * The connection string, from 1Password or from the environment.
 *
 * `PGURL_ITEM` first and by title, never by item id: `tools/check-public-identifiers.mjs`
 * treats an item id as a direct object reference, and only the `op://` reference
 * syntax objects to parentheses in a title, which these titles have. Same shape as
 * `verify-query-ceilings.mjs`.
 *
 * `DATABASE_URL_DIRECT` is preferred over `DATABASE_URL` when both are present, for
 * the reason `migrate.mjs` gives: Neon's pooler discards libpq startup parameters,
 * and this script sets a transaction isolation level it needs to actually take
 * effect.
 */
function resolveUrl() {
  const item = process.env["PGURL_ITEM"];
  if (item !== undefined && item !== "") {
    try {
      return execFileSync(
        "op",
        [
          "item",
          "get",
          item,
          "--vault",
          process.env["PULLFM_OP_VAULT"] ?? "MCP",
          "--fields",
          "label=credential",
          "--reveal",
        ],
        { encoding: "utf8" },
      ).trim();
    } catch {
      console.error(
        `1Password: could not read the 'credential' field of item '${item}'. ` +
          `Check that op is installed and signed in, and that the title is exact.`,
      );
      process.exit(2);
    }
  }
  const url =
    process.env["DATABASE_URL_DIRECT"] ?? process.env["DATABASE_URL"] ?? "";
  if (url === "") {
    console.error(
      "set PGURL_ITEM (a 1Password item title) or DATABASE_URL.\n" +
        "Prefer the DIRECT endpoint: Neon's pooler discards startup parameters and " +
        "this script relies on a transaction isolation level taking effect.",
    );
    process.exit(2);
  }
  return url;
}

// ---------------------------------------------------------------------------
// The required set, read from the registry the gate actually uses
// ---------------------------------------------------------------------------

/**
 * The document ids acceptance is required of.
 *
 * Parsed out of `CONSENT_DOCUMENTS` in the registry rather than out of the
 * database, because the database records what was PUBLISHED and the gate decides
 * what is REQUIRED, and those are different sets by design:
 * `consent-presentation` is published, versioned and digest-locked, and nobody
 * accepts it.
 *
 * NARROW AND LOUD. It reads only the slice between `CONSENT_DOCUMENTS` and the
 * first `];` after it, so a later constant cannot leak in, and it returns null
 * rather than an empty list when it finds nothing. Guessing here would put every
 * user in an outstanding cohort for a document nobody is asked to accept, which is
 * a false compliance finding.
 */
function readRequiredFromRegistry() {
  if (!existsSync(REGISTRY)) return null;
  let source;
  try {
    source = readFileSync(REGISTRY, "utf8");
  } catch {
    return null;
  }
  const start = source.indexOf("export const CONSENT_DOCUMENTS");
  if (start === -1) return null;
  const end = source.indexOf("];", start);
  if (end === -1) return null;
  const ids = [
    ...source.slice(start, end).matchAll(/\bid:\s*"([a-z][a-z0-9-]{2,63})"/g),
  ].map((m) => m[1]);
  return ids.length === 0 ? null : ids;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * A recorded acceptance, projected for a bundle.
 *
 * The four corroborating fields become presence flags unless `--unredact`. A
 * presence flag is informative and not disclosing: "there was an IP address on this
 * row" is most of what an auditor wants to know about whether the act was
 * corroborated.
 */
function projectConsent(row, unredact) {
  const base = {
    userId: row.user_id,
    documentId: row.document_id,
    version: row.document_version,
    consentEpoch: row.consent_epoch,
    contentSha256: row.content_sha256,
    acceptedAt: row.accepted_at.toISOString(),
    gate: row.gate,
    authMethod: row.auth_method,
    clientBuild: row.client_build,
    clientPlatform: row.client_platform,
    ipPresent: row.ip !== null,
    userAgentPresent: row.user_agent !== null,
    sessionIdPresent: row.session_id !== null,
  };
  if (!unredact) return base;
  return {
    ...base,
    ip: row.ip,
    userAgent: row.user_agent,
    sessionId: row.session_id,
  };
}

/**
 * The canonical form a record contributes to the root digest.
 *
 * INDEPENDENT OF THE REDACTION FLAGS, which is what makes two bundles comparable
 * even when one was produced with `--unredact`. The corroborating values are folded
 * in as digests rather than as values, so the root still moves if any recorded
 * field moves, and reading the root discloses nothing.
 */
function canonicalConsent(row) {
  return [
    row.user_id,
    row.document_id,
    row.document_version,
    String(row.consent_epoch),
    row.content_sha256,
    row.accepted_at.toISOString(),
    row.gate,
    row.auth_method,
    row.client_build ?? "",
    row.client_platform ?? "",
    row.ip === null ? "" : sha256(String(row.ip)),
    row.user_agent === null ? "" : sha256(row.user_agent),
    row.session_id === null ? "" : sha256(row.session_id),
  ].join("");
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** Every file written, in write order, with its digest. Becomes SHA256SUMS. */
const written = [];

function writeBundleFile(outDir, relativePath, contents) {
  const target = join(outDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, { mode: 0o600 });
  written.push({ path: relativePath, sha256: sha256(contents) });
  return target;
}

const writeJson = (outDir, relativePath, value) =>
  writeBundleFile(outDir, relativePath, `${JSON.stringify(value, null, 2)}\n`);

/**
 * The append-only protections, read out of the LIVE database.
 *
 * THIS IS WHAT MAKES QUESTION 5 WORTH ANSWERING. A bundle that merely asserted
 * "these tables are append-only" would be asking the reader to accept our word for
 * the one thing they have the least reason to. `pg_get_triggerdef`,
 * `pg_get_functiondef` and `pg_get_constraintdef` return what Postgres is ACTUALLY
 * RUNNING, so the reader sees the enforcement rather than a copy of a migration
 * file that may or may not have been applied.
 *
 * Missing protections are a FINDING and exit 1, not a warning. A database with the
 * immutability trigger dropped can still produce a plausible-looking bundle, and
 * that is exactly the situation in which a bundle must not read as clean.
 */
async function collectSchema(client) {
  const expectedTriggers = [
    "legal_consents_immutable_trg",
    "legal_consents_no_truncate_trg",
    "legal_document_revisions_immutable_trg",
    "legal_document_revisions_no_truncate_trg",
    "legal_document_revisions_epoch_guard_trg",
  ];
  const expectedConstraints = [
    "legal_document_revisions_content_digest_chk",
    "legal_consents_auth_method_chk",
    "legal_consents_gate_chk",
  ];

  const triggers = await client.query(
    `SELECT c.relname AS table_name, t.tgname AS name,
            pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND n.nspname = 'public'
        AND c.relname IN ('legal_consents', 'legal_document_revisions')
      ORDER BY c.relname, t.tgname`,
  );
  const functions = await client.query(
    `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('legal_immutable_row',
                          'legal_document_revisions_immutable',
                          'legal_document_revisions_epoch_guard')
      ORDER BY p.proname`,
  );
  const constraints = await client.query(
    `SELECT r.relname AS table_name, c.conname AS name,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public'
        AND r.relname IN ('legal_consents', 'legal_document_revisions')
      ORDER BY r.relname, c.conname`,
  );

  const haveTriggers = new Set(triggers.rows.map((r) => r.name));
  for (const name of expectedTriggers) {
    if (!haveTriggers.has(name)) {
      finding(
        `APPEND-ONLY PROTECTION MISSING: trigger ${name} is not present in the live ` +
          `database. This bundle's records are not protected by the control the ` +
          `schema documents, so they cannot be relied on as unrewritten. Do not ` +
          `hand this bundle over as clean.`,
      );
    }
  }
  const haveConstraints = new Set(constraints.rows.map((r) => r.name));
  for (const name of expectedConstraints) {
    if (!haveConstraints.has(name)) {
      finding(
        `CONSTRAINT MISSING: ${name} is not present in the live database. The ` +
          `guarantee it enforces is not in force for the rows in this bundle.`,
      );
    }
  }

  const sql = [
    "-- Pull.fm consent evidence: the append-only protections, READ OUT OF THE LIVE",
    "-- DATABASE at bundle time with pg_get_functiondef, pg_get_triggerdef and",
    "-- pg_get_constraintdef. This is not a copy of a migration file: it is what",
    "-- Postgres is actually enforcing on the rows in this bundle.",
    "--",
    "-- What to look for is listed in BOUNDARY.md section 6.3.",
    "",
    ...functions.rows.flatMap((r) => [
      `-- function ${r.name}`,
      r.definition,
      "",
    ]),
    ...triggers.rows.flatMap((r) => [
      `-- trigger on ${r.table_name}`,
      `${r.definition};`,
      "",
    ]),
    ...constraints.rows.flatMap((r) => [
      `-- constraint on ${r.table_name}`,
      `ALTER TABLE ${r.table_name} ADD CONSTRAINT ${r.name} ${r.definition};`,
      "",
    ]),
  ].join("\n");

  return {
    sql,
    summary: {
      triggers: triggers.rows.map((r) => `${r.table_name}.${r.name}`),
      functions: functions.rows.map((r) => r.name),
      constraints: constraints.rows.map((r) => `${r.table_name}.${r.name}`),
      expectedTriggersPresent: expectedTriggers.every((t) =>
        haveTriggers.has(t),
      ),
      expectedConstraintsPresent: expectedConstraints.every((c) =>
        haveConstraints.has(c),
      ),
    },
  };
}

/** Every published revision, with its text written out as a checkable file. */
async function collectRevisions(client, outDir) {
  const { rows } = await client.query(
    `SELECT document_id, version, consent_epoch, content_sha256, is_material,
            url, published_at, effective_at, notes, content
       FROM legal_document_revisions
      ORDER BY document_id, published_at, version`,
  );

  const revisions = [];
  for (const row of rows) {
    const label = `${row.document_id}@${row.version}`;
    let textFile = null;

    if (row.content === null) {
      note(
        `${label} was published with no text on this database, so the digest ` +
          `${row.content_sha256} has no preimage in this bundle. See migration 0009: ` +
          `a version published before the text column existed cannot be healed from ` +
          `inside the database.`,
      );
    } else {
      const actual = sha256(row.content);
      if (actual !== row.content_sha256) {
        // Excluded by legal_document_revisions_content_digest_chk. Checked anyway,
        // because the CHECK is exactly the thing a bundle must not take on faith,
        // and because a mismatch here makes every consent row citing this version
        // unverifiable while looking completely normal.
        finding(
          `DIGEST MISMATCH: the stored text of ${label} hashes to ${actual} but the ` +
            `row records ${row.content_sha256}. Every consent row citing this ` +
            `version is unverifiable against its text.`,
        );
      }
      textFile = `documents/${label}.md`;
      writeBundleFile(outDir, textFile, row.content);
    }

    revisions.push({
      documentId: row.document_id,
      version: row.version,
      consentEpoch: row.consent_epoch,
      contentSha256: row.content_sha256,
      isMaterial: row.is_material,
      url: row.url,
      publishedAt: row.published_at.toISOString(),
      effectiveAt:
        row.effective_at === null ? null : row.effective_at.toISOString(),
      notes: row.notes,
      textFile,
      textSha256: row.content === null ? null : sha256(row.content),
    });
  }
  return revisions;
}

/**
 * Question 3: who has not accepted the current epoch.
 *
 * "Current epoch" is `max(consent_epoch)` per document IN THE DATABASE, not from
 * the deployed registry, because the question is about what was published rather
 * than what a build believes; on a rolled-back deployment those differ and the
 * durable one is the honest answer.
 *
 * Computed only for documents in the REQUIRED set. A published-not-required
 * document is listed separately with its cohort explicitly not computed, because
 * "every user has failed to accept the consent screen copy" is arithmetically true
 * and a false compliance finding.
 */
async function collectOutstanding(client, required, maxRoster) {
  const epochs = await client.query(
    `SELECT document_id, max(consent_epoch) AS epoch
       FROM legal_document_revisions
      GROUP BY document_id
      ORDER BY document_id`,
  );
  const total = await client.query(`SELECT count(*)::text AS n FROM users`);
  const userCount = Number(total.rows[0].n);

  const requiredSet = new Set(required);
  const documents = [];
  const notRequired = [];

  for (const row of epochs.rows) {
    const epoch = Number(row.epoch);
    if (!requiredSet.has(row.document_id)) {
      notRequired.push({
        documentId: row.document_id,
        currentEpoch: epoch,
        cohortComputed: false,
        why: "Published and versioned, but acceptance is not required, so no subject can be outstanding for it.",
      });
      continue;
    }
    const { rows } = await client.query(
      `SELECT u.id, u.created_at, a.epoch AS accepted_epoch
         FROM users u
         LEFT JOIN (
              SELECT user_id, max(consent_epoch) AS epoch
                FROM legal_consents
               WHERE document_id = $1
               GROUP BY user_id
         ) a ON a.user_id = u.id
        WHERE a.epoch IS NULL OR a.epoch < $2
        ORDER BY u.created_at, u.id
        LIMIT $3`,
      [row.document_id, epoch, maxRoster + 1],
    );
    const truncated = rows.length > maxRoster;
    const roster = (truncated ? rows.slice(0, maxRoster) : rows).map((r) => ({
      // A UUID and nothing else. No email under any flag; see the header.
      userId: r.id,
      createdAt: r.created_at.toISOString(),
      highestAcceptedEpoch:
        r.accepted_epoch === null ? null : Number(r.accepted_epoch),
      // The two tiers the gate enforces, named the way plugins/auth.ts names them,
      // because they are enforced differently and an auditor should not have to
      // infer which one a row is in.
      tier: r.accepted_epoch === null ? "never-accepted" : "revision-pending",
    }));
    if (truncated) {
      note(
        `the outstanding roster for ${row.document_id} was capped at ${maxRoster} ` +
          `entries; raise --max-roster for the full list`,
      );
    }
    documents.push({
      documentId: row.document_id,
      currentEpoch: epoch,
      cohortComputed: true,
      users: userCount,
      outstanding: roster.length,
      truncated,
      roster,
    });
  }

  return { users: userCount, required, documents, notRequired };
}

/** Questions 1 and 2: one subject, and the text they actually agreed to. */
async function collectSubject(client, outDir, identifier, unredact, revisions) {
  const byId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      identifier,
    );
  const { rows: users } = await client.query(
    byId
      ? `SELECT id, email, created_at FROM users WHERE id = $1`
      : `SELECT id, email, created_at FROM users WHERE lower(email) = lower($1)`,
    [identifier],
  );
  const user = users[0];
  if (user === undefined) {
    // NOT a finding and not an error. "No such subject" is a legitimate answer to
    // an auditor's question and the bundle should say it rather than fail, because
    // a deleted account is the most likely reason and deletion_log is where the
    // remaining record lives.
    note(
      `no live account matched the subject identifier supplied. If the account was ` +
        `deleted, the surviving record is deletion_log.consents, which is ` +
        `deliberately narrower than a live consent row: see BOUNDARY.md section 9.`,
    );
    return { found: false, resolvedFrom: byId ? "user-id" : "email" };
  }

  const { rows } = await client.query(
    `SELECT user_id, document_id, document_version, consent_epoch, content_sha256,
            accepted_at, gate, client_build, client_platform, user_agent, ip,
            auth_method, session_id
       FROM legal_consents
      WHERE user_id = $1
      ORDER BY accepted_at, document_id, document_version`,
    [user.id],
  );

  const consents = rows.map((row) => {
    const projected = projectConsent(row, unredact);
    const revision = revisions.find(
      (r) =>
        r.documentId === row.document_id && r.version === row.document_version,
    );

    // The text this person agreed to, at the version they agreed to, as its own
    // file. Written under the subject as well as under documents/ deliberately: the
    // dossier has to be readable as one artifact, and "cross-reference the digest
    // to another directory" is how an auditor is made to do our work.
    let acceptedTextFile = null;
    if (revision?.textFile != null) {
      acceptedTextFile = `subject/accepted/${row.document_id}@${row.document_version}.md`;
      writeBundleFile(
        outDir,
        acceptedTextFile,
        readFileSync(join(outDir, revision.textFile), "utf8"),
      );
    }

    if (
      revision !== undefined &&
      revision.contentSha256 !== row.content_sha256
    ) {
      finding(
        `CONSENT ROW DISAGREES WITH ITS REVISION: the row for ` +
          `${row.document_id}@${row.document_version} records digest ` +
          `${row.content_sha256} while the published revision records ` +
          `${revision.contentSha256}. One of the two is wrong and the row cannot be ` +
          `matched to a text.`,
      );
    }

    return {
      ...projected,
      acceptedTextFile,
      // SERVER-DERIVED AND BY TIME, never from the client. See BOUNDARY.md section
      // 5: this is the copy that WAS CURRENT when the acceptance arrived, which is
      // not the same claim as the copy that was shown, and the label says so.
      consentScreenCopyCurrentAtAcceptance: copyCurrentAt(
        revisions,
        row.accepted_at,
      ),
    };
  });

  const dossier = {
    found: true,
    resolvedFrom: byId ? "user-id" : "email",
    userId: user.id,
    ...(unredact ? { email: user.email } : {}),
    accountCreatedAt: user.created_at.toISOString(),
    acceptanceCount: consents.length,
    consents,
  };
  writeJson(outDir, "subject/consents.json", dossier);

  // The canonical strings are returned but deliberately NOT written into the
  // dossier file, because they are an input to the root digest rather than a
  // record. Built from the raw rows and not from the projection above, so the root
  // covers the corroborating fields too: a tampered IP address moves the root even
  // in a redacted bundle, which it would not if the root only saw what was
  // printed.
  return { ...dossier, canonical: rows.map(canonicalConsent).sort() };
}

/**
 * Which version of the consent screen copy was the current published one at a
 * given instant.
 *
 * Derived from two timestamps the DATABASE sets - `published_at` on an immutable
 * append-only row, and `accepted_at` on another - so it cannot be influenced by a
 * client and needs no column. What it is NOT is proof of what was displayed, and
 * the field name in the output carries that qualification rather than leaving it to
 * a footnote.
 */
function copyCurrentAt(revisions, when) {
  const candidates = revisions
    .filter(
      (r) =>
        r.documentId === "consent-presentation" &&
        new Date(r.publishedAt) <= when,
    )
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const current = candidates[0];
  if (current === undefined) return null;
  return {
    documentId: current.documentId,
    version: current.version,
    contentSha256: current.contentSha256,
    textFile: current.textFile,
  };
}

/** Question 4: what changed between two versions, and who re-consented after. */
async function collectRevisionDiff(client, outDir, spec, revisions) {
  const parsed = /^([a-z][a-z0-9-]{2,63})@(.+?)\.\.(.+)$/.exec(spec);
  if (parsed === null) {
    usage(
      `--revision must look like documentId@fromVersion..toVersion, got ${spec}`,
    );
  }
  const [, documentId, from, to] = parsed;

  const find = (version) =>
    revisions.find((r) => r.documentId === documentId && r.version === version);
  const a = find(from);
  const b = find(to);
  for (const [version, row] of [
    [from, a],
    [to, b],
  ]) {
    if (row === undefined) {
      usage(
        `${documentId}@${version} has never been published by this database, so ` +
          `there is nothing to diff. revisions.json in a bundle produced without ` +
          `--revision lists every version that has.`,
      );
    }
  }

  // `diff -u` rather than a hand-rolled differ, and the reason is the same reason
  // SHA256SUMS is in coreutils format: THE RECIPIENT CAN REGENERATE IT. Both texts
  // are in the bundle, so an auditor who does not trust this file can run the same
  // command over the same two files and compare. A bespoke diff would be one more
  // thing they had to take our word for.
  let diff = null;
  const relA = a.textFile;
  const relB = b.textFile;
  if (relA === null || relB === null) {
    note(
      `cannot diff ${documentId} ${from}..${to}: at least one version was published ` +
        `without its text on this database`,
    );
  } else {
    try {
      diff = execFileSync("diff", ["-u", relA, relB], {
        cwd: outDir,
        encoding: "utf8",
      });
    } catch (err) {
      // diff(1) exits 1 when the files differ, which is the normal case here.
      if (typeof err.stdout === "string" && err.status === 1) {
        diff = err.stdout;
      } else {
        note(
          `diff(1) was not usable, so no textual diff is included. Both texts are ` +
            `in the bundle: run "diff -u ${relA} ${relB}" yourself.`,
        );
      }
    }
  }
  if (diff !== null) {
    writeBundleFile(
      outDir,
      `revision/${documentId}/${from}..${to}.diff`,
      `# Regenerate this yourself: diff -u ${relA} ${relB}\n${diff}`,
    );
  }

  // Who re-consented, and who did not. Both halves, because "who accepted the new
  // one" without "who is still on the old one" is the answer that reads as
  // reassuring regardless of the facts.
  const { rows: after } = await client.query(
    `SELECT n.user_id, o.accepted_at AS accepted_from, n.accepted_at AS accepted_to
       FROM legal_consents n
       JOIN legal_consents o
         ON o.user_id = n.user_id
        AND o.document_id = n.document_id
        AND o.document_version = $2
      WHERE n.document_id = $1 AND n.document_version = $3
      ORDER BY n.accepted_at`,
    [documentId, from, to],
  );
  const { rows: stalled } = await client.query(
    `SELECT o.user_id, o.accepted_at AS accepted_from
       FROM legal_consents o
      WHERE o.document_id = $1 AND o.document_version = $2
        AND NOT EXISTS (
              SELECT 1 FROM legal_consents n
               WHERE n.user_id = o.user_id
                 AND n.document_id = $1
                 AND n.document_version = $3
        )
      ORDER BY o.accepted_at`,
    [documentId, from, to],
  );

  const report = {
    documentId,
    from: {
      version: from,
      consentEpoch: a.consentEpoch,
      contentSha256: a.contentSha256,
      publishedAt: a.publishedAt,
      isMaterial: a.isMaterial,
      textFile: a.textFile,
    },
    to: {
      version: to,
      consentEpoch: b.consentEpoch,
      contentSha256: b.contentSha256,
      publishedAt: b.publishedAt,
      isMaterial: b.isMaterial,
      textFile: b.textFile,
    },
    // Whether the change forced anybody to accept again. The epoch is the only
    // thing enforcement compares, so this is the answer to "did users have to act".
    epochRaised: b.consentEpoch > a.consentEpoch,
    diffFile:
      diff === null ? null : `revision/${documentId}/${from}..${to}.diff`,
    reconsented: after.map((r) => ({
      userId: r.user_id,
      acceptedFromAt: r.accepted_from.toISOString(),
      acceptedToAt: r.accepted_to.toISOString(),
    })),
    acceptedFromButNotTo: stalled.map((r) => ({
      userId: r.user_id,
      acceptedFromAt: r.accepted_from.toISOString(),
    })),
  };
  writeJson(outDir, `revision/${documentId}/${from}..${to}.json`, report);
  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const required = opts.required ?? readRequiredFromRegistry();
  if (required === null) {
    console.error(
      `could not determine which documents acceptance is REQUIRED of.\n\n` +
        `Tried to parse CONSENT_DOCUMENTS out of ${relative(process.cwd(), REGISTRY)}, ` +
        `which is where the running gate reads it from.\n\n` +
        `Pass --required terms-of-service,privacy-policy to override, having checked ` +
        `that list against the deployed build.\n\n` +
        `This refuses rather than guessing because a guess puts every user into an ` +
        `outstanding cohort for a document nobody is asked to accept, which is a ` +
        `false compliance finding rather than a missing one.`,
    );
    process.exit(2);
  }
  const requiredSource = opts.required === null ? "registry" : "--required";

  const outDir = resolve(opts.outDir);
  if (existsSync(outDir)) {
    // Refuse rather than merge. A bundle with files from two runs in it has a
    // SHA256SUMS that verifies and a manifest that lies about what it covers.
    console.error(
      `${opts.outDir} already exists. Give a new directory: a bundle must be the ` +
        `product of exactly one run, or its manifest describes a mixture.`,
    );
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const client = new pg.Client({ connectionString: resolveUrl() });
  await client.connect();

  let revisions;
  let outstanding;
  let schema;
  let subject = null;
  let revisionDiff = null;

  try {
    // ONE SNAPSHOT, AND NO WRITES POSSIBLE. Everything below sees the same
    // instant, so no two sections can disagree; and READ ONLY means producing the
    // evidence cannot alter the evidence, asserted by Postgres rather than by this
    // file's intentions.
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const snapshot = await client.query(
      "SELECT now() AS at, current_user AS role, current_database() AS db, version() AS server",
    );

    schema = await collectSchema(client);
    revisions = await collectRevisions(client, outDir);
    outstanding = await collectOutstanding(client, required, opts.maxRoster);
    if (opts.subject !== null) {
      subject = await collectSubject(
        client,
        outDir,
        opts.subject,
        opts.unredact,
        revisions,
      );
    }
    if (opts.revision !== null) {
      revisionDiff = await collectRevisionDiff(
        client,
        outDir,
        opts.revision,
        revisions,
      );
    }

    writeBundleFile(outDir, "schema/append-only.sql", schema.sql);
    writeJson(outDir, "revisions.json", revisions);
    writeJson(outDir, "outstanding.json", outstanding);

    // The boundary statement, byte-identical to the repository copy so its digest
    // in SHA256SUMS can be compared against the file in the repo. Copied rather
    // than restated: a second wording of the limits is a second wording to keep in
    // step, and the one that would go stale is the one an auditor reads.
    let boundary;
    try {
      boundary = readFileSync(BOUNDARY, "utf8");
    } catch {
      console.error(
        `could not read ${relative(process.cwd(), BOUNDARY)}, which states what these ` +
          `records prove and what they only assert. A bundle without it invites the ` +
          `reader to assume the record establishes more than it does, so this refuses ` +
          `to produce one. Run from a checkout.`,
      );
      process.exit(2);
    }
    writeBundleFile(outDir, "BOUNDARY.md", boundary);

    const recordsRootSha256 = sha256(
      [
        ...revisions
          .map((r) =>
            [
              r.documentId,
              r.version,
              String(r.consentEpoch),
              r.contentSha256,
              String(r.isMaterial),
              r.publishedAt,
              r.effectiveAt ?? "",
            ].join(""),
          )
          .sort(),
        // Already sorted and already canonical, so neither the database's row
        // order nor the redaction flags can move the root. See canonicalConsent.
        ...(subject?.found === true ? subject.canonical : []),
      ].join(""),
    );

    const manifest = {
      format: "pullfm-consent-evidence",
      formatVersion: 1,
      generatedAt: snapshot.rows[0].at.toISOString(),
      // WHAT WAS ASKED, so a reader can tell a narrow bundle from an empty result.
      // A bundle that does not record its own scope cannot be distinguished from a
      // bundle whose scope returned nothing.
      scope: {
        subject: opts.subject === null ? null : (subject?.resolvedFrom ?? null),
        revision: opts.revision,
        requiredDocuments: required,
        requiredDocumentsSource: requiredSource,
        maxRoster: opts.maxRoster,
      },
      redaction: {
        unredacted: opts.unredact,
        reason: opts.reason,
        // Restated in the manifest as well as in BOUNDARY.md, because this is the
        // field a reader checks first when deciding whether they are allowed to
        // hold the file.
        policy: opts.unredact
          ? "ip, user_agent, session_id and email are PRESENT in the subject dossier. The cohort listing never carries them."
          : "ip, user_agent, session_id and email are redacted to presence flags. Re-run with --unredact --reason to include them.",
      },
      source: {
        database: snapshot.rows[0].db,
        role: snapshot.rows[0].role,
        server: snapshot.rows[0].server,
        transaction: "REPEATABLE READ, READ ONLY",
      },
      schema: schema.summary,
      counts: {
        publishedRevisions: revisions.length,
        users: outstanding.users,
        subjectAcceptances:
          subject?.found === true ? subject.consents.length : 0,
      },
      // Stable across runs and across redaction flags for the same scope. Equal
      // roots taken at two different times mean no record in scope was added,
      // removed or rewritten in between. See BOUNDARY.md section 6.4, including
      // what it does not prove.
      recordsRootSha256,
      findings,
      notes,
    };
    writeJson(outDir, "MANIFEST.json", manifest);

    writeBundleFile(outDir, "README.md", readme(manifest, opts));

    // LAST, and not listed in itself. Written after everything else so it covers
    // the whole bundle, and excluded from its own contents because a file cannot
    // contain its own digest.
    const sums = written
      .filter((f) => f.path !== "SHA256SUMS")
      .map((f) => `${f.sha256}  ${f.path}`)
      .sort()
      .join("\n");
    writeFileSync(join(outDir, "SHA256SUMS"), `${sums}\n`, { mode: 0o600 });

    await client.query("COMMIT");

    say(`bundle written to ${opts.outDir}`);
    say(`  published revisions   ${revisions.length}`);
    say(`  accounts              ${outstanding.users}`);
    for (const doc of outstanding.documents) {
      say(
        `  outstanding           ${doc.documentId} epoch ${doc.currentEpoch}: ` +
          `${doc.outstanding} of ${doc.users}`,
      );
    }
    for (const doc of outstanding.notRequired) {
      say(
        `  published, not required  ${doc.documentId} epoch ${doc.currentEpoch}: ` +
          `no cohort computed`,
      );
    }
    if (subject?.found === true) {
      say(`  subject dossier       ${subject.consents.length} acceptance(s)`);
    }
    if (revisionDiff !== null) {
      say(
        `  revision              ${revisionDiff.documentId} ` +
          `${revisionDiff.from.version}..${revisionDiff.to.version}: ` +
          `${revisionDiff.reconsented.length} re-consented, ` +
          `${revisionDiff.acceptedFromButNotTo.length} still on the old version`,
      );
    }
    say(`  records root          ${recordsRootSha256}`);
    say("");
    say("Verify it without trusting us:");
    say(`  cd ${opts.outDir} && sha256sum -c SHA256SUMS`);
    say(
      "  sha256sum documents/*.md    # compare to content_sha256 in revisions.json",
    );
    say(
      "  read schema/append-only.sql # the LIVE triggers, not a copy of a migration",
    );
    say(
      "  read BOUNDARY.md            # what this proves, and what it does not",
    );
    say("");
    say(
      "RECORD THE RECORDS ROOT SOMEWHERE WE CANNOT REACH. A single bundle cannot " +
        "prove immutability; two bundles with the same root over the same scope can. " +
        "See BOUNDARY.md section 7.",
    );

    if (opts.json) {
      console.log(
        JSON.stringify({ ...manifest, ok: findings.length === 0 }, null, 2),
      );
    } else if (!opts.quiet) {
      console.error(out.join("\n"));
    }
    if (notes.length > 0 && !opts.json) {
      console.error(`\nNOTES (${notes.length}), not failures:\n`);
      for (const n of notes) console.error(`  - ${n}\n`);
    }
    if (findings.length > 0) {
      if (!opts.json) {
        console.error(`\nFINDINGS (${findings.length}):\n`);
        for (const f of findings) console.error(`  - ${f}\n`);
        console.error(
          "The bundle was still written: a finding is evidence too, and deleting it " +
            "would be the one edit nobody should make.\n",
        );
      }
      process.exit(1);
    }
  } catch (err) {
    // ROLLBACK on the way out. The transaction is READ ONLY so there is nothing to
    // undo; this releases the snapshot rather than leaving it pinned while the
    // process winds down.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is already gone */
    }
    // A half-written bundle is worse than none: it has a manifest describing files
    // that are not there, or files with no manifest, and either reads as a complete
    // artefact to somebody who did not run it.
    rmSync(outDir, { recursive: true, force: true });
    console.error(
      `\n${scrub(err instanceof Error ? err.message : String(err))}\n`,
    );
    console.error(
      `no bundle was written and ${opts.outDir} was removed, because a partial ` +
        `bundle reads as a complete one to anybody who did not run this.`,
    );
    process.exit(2);
  } finally {
    await client.end();
  }
}

/** The bundle's own front page. Generated, so it cannot describe a different run. */
function readme(manifest, opts) {
  return `# Pull.fm consent evidence bundle

Generated ${manifest.generatedAt} from database \`${manifest.source.database}\` as
role \`${manifest.source.role}\`, inside one ${manifest.source.transaction}
transaction. **Producing this bundle could not alter the records in it**, because
the transaction was opened READ ONLY and Postgres enforced that.

**Read \`BOUNDARY.md\` before relying on anything here.** It is the authoritative
statement of what these records prove and what they only assert on a client's word,
copied verbatim from \`docs/compliance/consent-evidence.md\`. The one-sentence
version: **the record proves a request arrived carrying the right version and
digest, on an interactive session, at a recorded time, unrewritten since; it does
not prove a screen was rendered or that a human saw anything.**

## Redaction

${manifest.redaction.policy}
${opts.unredact ? `\n**Reason given for unredaction:** ${opts.reason}\n` : ""}
## What is here

| Path | What it is |
| --- | --- |
| \`BOUNDARY.md\` | What the records prove and what they assert. Read first. |
| \`MANIFEST.json\` | What was asked, what was found, the records root digest. |
| \`SHA256SUMS\` | Every file's digest, coreutils format. \`sha256sum -c SHA256SUMS\`. |
| \`revisions.json\` | Every legal document version this database has published. |
| \`documents/<id>@<version>.md\` | The exact text of each, as the bytes its digest covers. |
| \`schema/append-only.sql\` | The append-only triggers and constraints, read out of the LIVE database. |
| \`outstanding.json\` | Who has not accepted the current epoch, per required document. |
${manifest.scope.subject === null ? "" : "| `subject/consents.json` | One subject's full consent history. |\n| `subject/accepted/<id>@<version>.md` | The text that subject agreed to, at the version they agreed to. |\n"}${manifest.scope.revision === null ? "" : "| `revision/<id>/<a>..<b>.diff` | What changed between two published versions. |\n| `revision/<id>/<a>..<b>.json` | Who re-consented after it, and who did not. |\n"}
## Verifying this without trusting us

\`\`\`bash
# 1. The bundle is intact as produced.
sha256sum -c SHA256SUMS

# 2. THE STRONGEST CHECK: the text is the preimage of the digest every
#    consent row cites. Compare each result to content_sha256 in
#    revisions.json, and to content_sha256 on each row in subject/consents.json.
sha256sum documents/*.md

# 3. The live enforcement, not a copy of a migration file.
cat schema/append-only.sql

# 4. Nothing recorded changed between two bundles of the same scope:
#    compare recordsRootSha256 in MANIFEST.json.
\`\`\`

**Records root:** \`${manifest.recordsRootSha256}\`

That root is stable across runs and across redaction flags for the same scope. **A
single bundle cannot prove immutability** - it is a snapshot. Two bundles taken at
different times with equal roots can, and are worth exactly as much as the
independence of whoever held the earlier one. \`BOUNDARY.md\` section 7 says what
that does not cover, including that an operator with database superuser can defeat
the triggers and re-export.

${manifest.findings.length === 0 ? "No findings: every append-only protection this bundle asserts was present in the live database, and every stored text hashed to the digest recorded beside it." : `## Findings (${manifest.findings.length})\n\n${manifest.findings.map((f) => `- ${f}`).join("\n")}\n\n**Do not hand this bundle over as clean.**`}
${manifest.notes.length === 0 ? "" : `\n## Notes (${manifest.notes.length}), not failures\n\n${manifest.notes.map((n) => `- ${n}`).join("\n")}\n`}`;
}

await main();
