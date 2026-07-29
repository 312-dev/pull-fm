/**
 * The wishlist: cursor-paginated reads and idempotent writes.
 *
 * This is the reference implementation of the two patterns every user-scoped
 * resource in this API follows, and it is worth reading as a pattern rather
 * than as a feature:
 *
 *   Reads   The ownership predicate and the keyset predicate are in the SAME
 *           statement. There is no "fetch the row, then compare user_id", ever.
 *           A fetch-then-check is not merely slower: it puts the security
 *           property in application code where it can be forgotten, instead of
 *           in the query where it is visible to a reviewer and to grep.
 *
 *   Writes  Idempotency-Key claimed in the same transaction as the write, so a
 *           retried request returns the ORIGINAL response instead of
 *           re-executing. See lib/idempotency.ts for why the record is keyed on
 *           (subject, key) and not on key alone.
 *
 * Denial is 404, never 403 (see the note in lib/errors.ts). A 403 on a foreign
 * id confirms that the id exists and belongs to someone, which is an
 * enumeration oracle over the whole table.
 */

import { errors } from "../lib/errors.js";
import {
  decodeCursor,
  encodeCursor,
  type CursorPosition,
} from "../lib/cursor.js";
import type { SigningKeys } from "../lib/keys.js";
import type { Database, Queryable } from "../lib/db.js";

export const WISHLIST_SOURCES = [
  "manual",
  "lastfm_loved",
  "listenbrainz_loved",
  "recommendation",
] as const;

export const WISHLIST_STATUSES = [
  "wanted",
  "acquired",
  "unavailable",
  "dismissed",
] as const;

export interface WishlistItem {
  readonly id: string;
  readonly recordingMbid: string | null;
  readonly releaseMbid: string | null;
  readonly artistMbid: string | null;
  readonly artistName: string;
  readonly title: string;
  readonly source: string;
  readonly status: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly acquiredAt: string | null;
}

interface WishlistRow {
  id: string;
  recording_mbid: string | null;
  release_mbid: string | null;
  artist_mbid: string | null;
  artist_name: string;
  title: string;
  source: string;
  status: string;
  note: string | null;
  created_at: Date;
  acquired_at: Date | null;
}

const COLUMNS = `id, recording_mbid, release_mbid, artist_mbid, artist_name,
                 title, source, status, note, created_at, acquired_at`;

function toItem(row: WishlistRow): WishlistItem {
  return {
    id: row.id,
    recordingMbid: row.recording_mbid,
    releaseMbid: row.release_mbid,
    artistMbid: row.artist_mbid,
    artistName: row.artist_name,
    title: row.title,
    source: row.source,
    status: row.status,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    acquiredAt: row.acquired_at?.toISOString() ?? null,
  };
}

export interface Page<T> {
  readonly items: T[];
  readonly cursor: string | null;
}

export interface CreateWishlistInput {
  readonly recordingMbid?: string | undefined;
  readonly releaseMbid?: string | undefined;
  readonly artistMbid?: string | undefined;
  readonly artistName: string;
  readonly title: string;
  readonly source?: string | undefined;
  readonly note?: string | undefined;
}

/** Per-subject ceiling. An authenticated write with no ceiling is API6/API4. */
const MAX_ITEMS_PER_USER = 5_000;

export class WishlistService {
  readonly #db: Database;
  readonly #keys: SigningKeys;

  constructor(db: Database, keys: SigningKeys) {
    this.#db = db;
    this.#keys = keys;
  }

  /**
   * One page, newest first.
   *
   * The `(created_at, id) < (cursor.t, cursor.i)` comparison is a row
   * constructor, which Postgres can satisfy directly from the
   * (user_id, created_at DESC) index. It is also the only correct way to page a
   * non-unique sort key: comparing only `created_at` either skips or repeats
   * rows that share a timestamp.
   */
  async list(
    userId: string,
    opts: {
      limit: number;
      cursor?: string | undefined;
      status?: string | undefined;
    },
  ): Promise<Page<WishlistItem>> {
    const position: CursorPosition | null =
      opts.cursor === undefined
        ? null
        : decodeCursor(this.#keys, "wishlist", userId, opts.cursor);

    // Note: `user_id = $1` is present unconditionally and is not derived from
    // the cursor. Even a perfectly forged cursor can only reposition the caller
    // inside their own rows (M15).
    const params: unknown[] = [userId, opts.limit + 1];
    let where = `user_id = $1`;
    if (position !== null) {
      params.push(position.createdAt, position.id);
      where += ` AND (created_at, id) < ($3::timestamptz, $4::uuid)`;
    }
    if (opts.status !== undefined) {
      params.push(opts.status);
      where += ` AND status = $${String(params.length)}`;
    }

    const { rows } = await this.#db.query<WishlistRow>(
      `SELECT ${COLUMNS} FROM wishlist_items
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      params,
    );

    // One row beyond the page size is fetched purely to answer "is there
    // another page" without a second COUNT query over the whole table.
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toItem),
      cursor:
        hasMore && last !== undefined
          ? encodeCursor(this.#keys, "wishlist", userId, {
              createdAt: last.created_at.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  /**
   * Fetches one item.
   *
   * `id = $1 AND user_id = $2`, in that single statement. A foreign id returns
   * no row and the caller gets 404.
   */
  async get(userId: string, id: string): Promise<WishlistItem> {
    const { rows } = await this.#db.query<WishlistRow>(
      `SELECT ${COLUMNS} FROM wishlist_items
        WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = rows[0];
    if (row === undefined) throw errors.notFound("No such wishlist item.");
    return toItem(row);
  }

  /**
   * Adds an item, inside the caller's transaction so the idempotency claim and
   * the insert commit or roll back together.
   *
   * The unique constraint on (user_id, recording_mbid) makes a duplicate add a
   * no-op that returns the existing row, so a retry that arrives after the
   * idempotency record expired still does the right thing.
   */
  async create(
    client: Queryable,
    userId: string,
    input: CreateWishlistInput,
  ): Promise<WishlistItem> {
    const { rows: counted } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM wishlist_items WHERE user_id = $1`,
      [userId],
    );
    if (Number(counted[0]?.n ?? 0) >= MAX_ITEMS_PER_USER) {
      throw errors.conflict(
        `A wishlist is limited to ${String(MAX_ITEMS_PER_USER)} items.`,
      );
    }

    const { rows } = await client.query<WishlistRow>(
      `INSERT INTO wishlist_items
         (user_id, recording_mbid, release_mbid, artist_mbid, artist_name, title, source, note)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'manual'), $8)
       ON CONFLICT (user_id, recording_mbid) DO UPDATE
          SET note = COALESCE(EXCLUDED.note, wishlist_items.note)
       RETURNING ${COLUMNS}`,
      [
        userId,
        input.recordingMbid ?? null,
        input.releaseMbid ?? null,
        input.artistMbid ?? null,
        input.artistName,
        input.title,
        input.source ?? null,
        input.note ?? null,
      ],
    );

    const row = rows[0];
    if (row === undefined) {
      // Reachable when recording_mbid is NULL: the unique constraint does not
      // apply to NULLs, so DO UPDATE cannot fire and a genuine conflict on some
      // other constraint surfaces here.
      throw errors.conflict("The item could not be added.");
    }
    return toItem(row);
  }

  /** Removes an item. Ownership predicate in the DELETE; 404 on a foreign id. */
  async remove(userId: string, id: string): Promise<void> {
    const { rowCount } = await this.#db.query(
      `DELETE FROM wishlist_items WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if ((rowCount ?? 0) === 0) throw errors.notFound("No such wishlist item.");
  }

  /**
   * Purchase links for an item.
   *
   * Pull.fm is non-commercial (docs/PLAN.md section 1a), so these carry NO
   * affiliate parameters, ever. An affiliate tag would retroactively breach the
   * Last.fm, Deezer, and Apple terms simultaneously. The links are constructed
   * from encoded components rather than concatenated, which is the same rule
   * the upstream clients follow for the SSRF reason (T15).
   */
  async acquire(
    userId: string,
    id: string,
  ): Promise<{ item: WishlistItem; links: { store: string; url: string }[] }> {
    const item = await this.get(userId, id);
    const q = `${item.artistName} ${item.title}`;
    const links = [
      {
        store: "bandcamp",
        url: `https://bandcamp.com/search?${new URLSearchParams({ q }).toString()}`,
      },
      {
        store: "qobuz",
        url: `https://www.qobuz.com/us-en/search?${new URLSearchParams({ q }).toString()}`,
      },
      {
        store: "apple_music",
        url: `https://music.apple.com/us/search?${new URLSearchParams({ term: q }).toString()}`,
      },
    ];
    return { item, links };
  }
}
