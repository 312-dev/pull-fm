/**
 * The local user record.
 *
 * WorkOS owns authentication; this table owns everything else. The link is the
 * WorkOS subject id, and it is the only identifier a client's token can
 * influence. The Pull.fm user id is minted here and never accepted from input,
 * which is the structural half of THREAT-MODEL M14.
 */

import type { Database, Queryable } from "../lib/db.js";

export interface User {
  readonly id: string;
  readonly workosUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

interface UserRow {
  id: string;
  workos_user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    workosUserId: row.workos_user_id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

const COLUMNS = `id, workos_user_id, email, display_name, created_at, deleted_at`;

export interface UpsertInput {
  readonly workosUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export class UserService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Creates or refreshes the local record for a WorkOS subject.
   *
   * ON CONFLICT rather than SELECT-then-INSERT: two concurrent first requests
   * from a freshly signed-up user race, and the loser of that race must get the
   * winner's row rather than a unique-violation 500.
   *
   * A previously soft-deleted account is NOT resurrected here. Signing in again
   * after deletion produces a conflict the caller surfaces as a fresh signup at
   * the identity provider, because silently reattaching a new session to a
   * deleted account's row would undo an erasure request.
   */
  async upsert(input: UpsertInput): Promise<User> {
    const { rows } = await this.#db.query<UserRow>(
      `INSERT INTO users (workos_user_id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (workos_user_id) DO UPDATE
          SET email        = COALESCE(EXCLUDED.email, users.email),
              display_name = COALESCE(EXCLUDED.display_name, users.display_name)
       RETURNING ${COLUMNS}`,
      [
        input.workosUserId,
        input.email === null ? null : input.email.toLowerCase(),
        input.displayName,
      ],
    );
    const row = rows[0];
    /* c8 ignore next 3 -- RETURNING on an upsert always yields a row */
    if (row === undefined) {
      throw new Error("upsert returned no row");
    }
    return toUser(row);
  }

  /**
   * Resolves the subject of an authenticated request.
   *
   * `deleted_at IS NULL` is a predicate rather than a post-check so a token
   * minted before deletion cannot outlive the account it belongs to.
   */
  async findActiveByWorkOsId(workosUserId: string): Promise<User | null> {
    const { rows } = await this.#db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users
        WHERE workos_user_id = $1 AND deleted_at IS NULL`,
      [workosUserId],
    );
    const row = rows[0];
    return row === undefined ? null : toUser(row);
  }

  async findActiveById(id: string): Promise<User | null> {
    const { rows } = await this.#db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toUser(row);
  }
}

/** Reads a user inside an existing transaction, locking the row. */
export async function lockUser(
  client: Queryable,
  id: string,
): Promise<User | null> {
  const { rows } = await client.query<UserRow>(
    `SELECT ${COLUMNS} FROM users WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : toUser(row);
}
