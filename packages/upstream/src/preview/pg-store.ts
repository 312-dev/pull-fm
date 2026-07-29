/**
 * Postgres PreviewStore over `track_previews`.
 *
 * Writes iTunes rows only. The Deezer rejection here is intentional
 * duplication: the schema allows a Deezer row as long as it carries an expiry
 * (`track_previews_deezer_expiry_chk`), because the constraint's job is to stop
 * an *unexpiring* Deezer row. Our policy is stricter than the schema - never
 * store one at all - and policy belongs in code where it can carry a reason.
 */

import type { Queryable } from "../cache/pg-store.js";
import type { PreviewStore, PreviewWrite, StoredPreview } from "./resolver.js";
import { DeezerPreviewNotCacheableError } from "./resolver.js";

interface Row {
  recording_mbid: unknown;
  preview_url: unknown;
  duration_ms: unknown;
  resolved_at: unknown;
}

export class PgPreviewStore implements PreviewStore {
  constructor(private readonly db: Queryable) {}

  async get(recordingMbid: string): Promise<StoredPreview | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT recording_mbid::text AS recording_mbid, preview_url, duration_ms, resolved_at
         FROM track_previews
        WHERE recording_mbid = $1::uuid AND provider = 'itunes'`,
      [recordingMbid],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (typeof row.recording_mbid !== "string") return null;
    if (typeof row.preview_url !== "string") return null;
    const resolvedAt =
      row.resolved_at instanceof Date
        ? row.resolved_at.getTime()
        : typeof row.resolved_at === "string"
          ? Date.parse(row.resolved_at)
          : Date.now();
    return {
      recordingMbid: row.recording_mbid,
      provider: "itunes",
      url: row.preview_url,
      durationMs:
        typeof row.duration_ms === "number" ? row.duration_ms : undefined,
      resolvedAt: Number.isFinite(resolvedAt) ? resolvedAt : Date.now(),
    };
  }

  async put(row: PreviewWrite): Promise<void> {
    if (row.provider !== "itunes") throw new DeezerPreviewNotCacheableError();
    await this.db.query(
      `INSERT INTO track_previews (recording_mbid, provider, preview_url, duration_ms, url_expires_at)
       VALUES ($1::uuid, 'itunes', $2, $3, NULL)
       ON CONFLICT (recording_mbid, provider) DO UPDATE
          SET preview_url = EXCLUDED.preview_url,
              duration_ms = EXCLUDED.duration_ms,
              resolved_at = now()`,
      [row.recordingMbid, row.url, row.durationMs ?? null],
    );
  }
}
