/**
 * Postgres PreviewStore over `track_previews`.
 *
 * Writes iTunes rows only, and every row carries `store_url`: Apple's licence
 * condition (ii) requires the preview to sit next to a store badge linking to
 * the page where THAT track can be purchased, so a row without one describes a
 * preview nobody may legally render. See packages/upstream/src/preview/
 * resolver.ts and docs/compliance/apple-itunes-terms-review.md.
 *
 * The Deezer rejection here is intentional
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
  store_url: unknown;
  resolved_at: unknown;
  revalidate_after: unknown;
}

/** Postgres hands timestamps back as a Date or, through some poolers, a string. */
function toEpochMs(v: unknown, fallback: number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export class PgPreviewStore implements PreviewStore {
  constructor(private readonly db: Queryable) {}

  async get(recordingMbid: string): Promise<StoredPreview | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT recording_mbid::text AS recording_mbid, preview_url, duration_ms,
              store_url, resolved_at, revalidate_after
         FROM track_previews
        WHERE recording_mbid = $1::uuid AND provider = 'itunes'`,
      [recordingMbid],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (typeof row.recording_mbid !== "string") return null;
    if (typeof row.preview_url !== "string") return null;
    const now = Date.now();
    return {
      recordingMbid: row.recording_mbid,
      provider: "itunes",
      url: row.preview_url,
      durationMs:
        typeof row.duration_ms === "number" ? row.duration_ms : undefined,
      // Apple licence condition (ii). A row without it is not servable and the
      // resolver treats it as absent; see preview/resolver.ts.
      storeUrl: typeof row.store_url === "string" ? row.store_url : null,
      resolvedAt: toEpochMs(row.resolved_at, now),
      // An unreadable timestamp reads as due NOW rather than as never due. The
      // conservative direction is re-resolving a row we did not have to, not
      // serving one Apple may have withdrawn.
      revalidateAfter: toEpochMs(row.revalidate_after, now),
    };
  }

  async put(row: PreviewWrite): Promise<void> {
    if (row.provider !== "itunes") throw new DeezerPreviewNotCacheableError();
    await this.db.query(
      `INSERT INTO track_previews
         (recording_mbid, provider, preview_url, duration_ms, url_expires_at,
          store_url, revalidate_after)
       VALUES ($1::uuid, 'itunes', $2, $3, NULL, $4, now() + interval '30 days')
       ON CONFLICT (recording_mbid, provider) DO UPDATE
          SET preview_url = EXCLUDED.preview_url,
              duration_ms = EXCLUDED.duration_ms,
              store_url = EXCLUDED.store_url,
              resolved_at = now(),
              -- Re-resolving is what the revalidation window is FOR, so a
              -- refresh restarts it. Leaving it untouched would make a row
              -- permanently due and re-resolve it on every request.
              revalidate_after = now() + interval '30 days'`,
      [row.recordingMbid, row.url, row.durationMs ?? null, row.storeUrl],
    );
  }
}
