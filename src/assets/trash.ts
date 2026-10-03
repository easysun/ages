import type { Bindings } from "../bindings";
import { ApiError } from "../http/errors";
import type { Asset } from "./model";

const retentionMs = 30 * 24 * 60 * 60 * 1000;
function ownedAsset(asset: Asset | null | undefined) {
  if (!asset || asset.status === "purged") throw new ApiError("NOT_FOUND");
  return asset;
}

export async function trashAsset(db: D1Database, id: string, owner: string) {
  const now = new Date().toISOString();
  let result: D1Result[];
  try {
    result = await db.batch([
      db
        .prepare(`UPDATE assets SET status = 'deleted', deleted_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM timeline_items WHERE asset_id = assets.id)
          AND NOT EXISTS (SELECT 1 FROM timelines WHERE cover_asset_id = assets.id)
        RETURNING *`)
        .bind(now, now, id, owner),
      db
        .prepare("SELECT * FROM assets WHERE id = ? AND owner_id = ?")
        .bind(id, owner),
    ]);
  } catch (error) {
    // Existing reference triggers also protect callers which bypass the precondition.
    if (
      error instanceof Error &&
      error.message.includes("asset_referenced_by_timeline")
    )
      throw new ApiError("CONFLICT");
    throw error;
  }
  const asset = ownedAsset(
    (result[0]?.results[0] ?? result[1]?.results[0]) as Asset | undefined,
  );
  if (asset.status !== "deleted") throw new ApiError("CONFLICT");
  return asset;
}

export async function restoreAsset(
  bindings: Bindings,
  id: string,
  owner: string,
) {
  const db = bindings.DB;
  const asset = ownedAsset(
    await db
      .prepare("SELECT * FROM assets WHERE id = ? AND owner_id = ?")
      .bind(id, owner)
      .first<Asset>(),
  );
  if (asset.status === "ready") return asset;
  const deletedAt =
    asset.deleted_at === null ? Number.NaN : Date.parse(asset.deleted_at);
  if (
    asset.status !== "deleted" ||
    !Number.isFinite(deletedAt) ||
    deletedAt + retentionMs <= Date.now()
  )
    throw new ApiError("CONFLICT");
  const head = await bindings.MEDIA.head(asset.r2_key);
  if (
    !head ||
    !asset.etag ||
    head.etag !== asset.etag ||
    head.size !== asset.size_bytes ||
    head.httpMetadata?.contentType !== asset.mime_type
  )
    throw new ApiError("CONFLICT");
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  // Match the inspected trash generation and recheck retention after the R2 read.
  const result = await db.batch([
    db
      .prepare(`UPDATE assets SET status = 'ready', deleted_at = NULL, updated_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'deleted' AND deleted_at = ?
        AND etag = ? AND mime_type = ? AND julianday(deleted_at) > julianday(?) RETURNING *`)
      .bind(
        now.toISOString(),
        id,
        owner,
        asset.deleted_at,
        asset.etag,
        asset.mime_type,
        cutoff,
      ),
    db
      .prepare("SELECT * FROM assets WHERE id = ? AND owner_id = ?")
      .bind(id, owner),
  ]);
  const restored = ownedAsset(
    (result[0]?.results[0] ?? result[1]?.results[0]) as Asset | undefined,
  );
  if (restored.status !== "ready") throw new ApiError("CONFLICT");
  return restored;
}
