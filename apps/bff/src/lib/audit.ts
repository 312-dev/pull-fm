/**
 * Append-only audit trail for credential-affecting events (THREAT-MODEL M22).
 *
 * Repudiation is usually the least interesting STRIDE letter. Here it decides
 * whether a credential incident produces a scoped disclosure notice naming the
 * affected connections, or an instruction to every user to rotate everything.
 *
 * Two rules this module enforces rather than documents:
 *
 *   - Writing an audit row must never fail a request. An audit write that can
 *     500 the operation it is recording turns observability into an outage, and
 *     the operation is the thing the user actually asked for.
 *   - `detail` carries non-secret context only. There is no legitimate reason
 *     for a token, a session key, or key material to reach this table, and the
 *     redaction list plus the Semgrep rule both apply to anything on the way
 *     to it.
 */

import type { FastifyBaseLogger } from "fastify";

import type { Database } from "./db.js";

/**
 * The closed set of auditable actions.
 *
 * Closed on purpose: adding one is a deliberate decision about what a future
 * incident responder will need, made at the time the feature is written rather
 * than during the incident.
 */
export type AuditAction =
  | "auth.callback"
  // Magic-link sign-in. `subjectRef` on these carries a TRUNCATED SHA-256 of
  // the address, never the address: these rows deliberately outlive the user
  // (there is no foreign key, see migration 0002), so putting an email here
  // would create a record of a person that survives their own erasure request.
  | "auth.magic_auth.requested"
  | "auth.magic_auth.verified"
  | "auth.magic_auth.failed"
  | "auth.session.refreshed"
  | "auth.session.revoked"
  | "account.profile_updated"
  // The directory reaper. `subjectRef` is the WorkOS id and never the address:
  // the subject of this row is by definition NOT a user of ours, so recording
  // their address permanently in order to note that we deleted their record
  // would defeat the purpose of deleting it.
  | "directory.unverified_reaped"
  | "connection.created"
  | "connection.deleted"
  | "connection.connect_started"
  | "connection.callback"
  | "token.created"
  | "token.rotated"
  | "token.revoked"
  | "token.used_expired"
  // Recorded assent to a published legal document. `subjectRef` is
  // `<documentId>@<version>` and `detail` carries the epoch, the content digest
  // and which gate presented it. This is the audit-trail HALF of the evidence;
  // `legal_consents` is the record. Both exist because they answer different
  // questions: the table answers "what does this user's contract consist of", and
  // the trail answers "what happened on this account, in order, including the
  // acceptance". The trail is also anonymized at 91 days, which is why it is not
  // the record.
  | "account.terms_accepted"
  | "account.export_requested"
  | "account.export_downloaded"
  | "account.deleted"
  | "webhook.user_deleted"
  | "webhook.rejected";

export interface AuditEntry {
  readonly userId: string | null;
  readonly action: AuditAction;
  /** The object acted on: a connection id, a token id, a provider name. */
  readonly subjectRef?: string | null;
  readonly outcome: "ok" | "denied" | "error";
  readonly detail?: Record<string, unknown>;
  readonly ip?: string | null;
}

export class AuditLog {
  readonly #db: Database;
  readonly #log: FastifyBaseLogger;

  constructor(db: Database, log: FastifyBaseLogger) {
    this.#db = db;
    this.#log = log;
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.#db.query(
        `INSERT INTO audit_log (user_id, action, subject_ref, outcome, detail, ip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entry.userId,
          entry.action,
          entry.subjectRef ?? null,
          entry.outcome,
          entry.detail === undefined ? null : JSON.stringify(entry.detail),
          entry.ip ?? null,
        ],
      );
    } catch (err) {
      // Deliberately swallowed. The audit trail is evidence, not a
      // precondition, and a failed INSERT must not roll back a completed
      // deletion or hand the caller a 500 for an operation that succeeded.
      this.#log.error({ err, action: entry.action }, "audit write failed");
    }
  }
}
