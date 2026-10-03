import type { Bindings } from "../bindings";
import type { Asset } from "./model";

const retentionMs = 30 * 24 * 60 * 60 * 1000;
export async function purgeExpiredTrash(bindings: Bindings) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  const rows = await bindings.DB.prepare(`SELECT * FROM assets
    WHERE status='deleted' AND julianday(deleted_at) <= julianday(?)
      AND trash_generation IS NOT NULL ORDER BY updated_at,id LIMIT 100`)
    .bind(cutoff)
    .all<Asset>();
  for (const asset of rows.results) {
    // Claim the exact generation BEFORE deleting bytes. Restore must lose after this write.
    const claimed =
      await bindings.DB.prepare(`UPDATE assets SET purge_claim=trash_generation,updated_at=?
      WHERE id=? AND status='deleted' AND trash_generation=? AND deleted_at=?
        AND julianday(deleted_at) <= julianday(?) AND (purge_claim IS NULL OR purge_claim=trash_generation)
      RETURNING *`)
        .bind(
          now.toISOString(),
          asset.id,
          asset.trash_generation,
          asset.deleted_at,
          cutoff,
        )
        .first<Asset>();
    if (!claimed) continue;
    try {
      await bindings.MEDIA.delete(claimed.r2_key);
      // The existing status trigger releases storage once, only after deletion succeeds.
      await bindings.DB.prepare(`UPDATE assets SET status='purged',updated_at=?
        WHERE id=? AND status='deleted' AND purge_claim=? AND trash_generation=?`)
        .bind(
          now.toISOString(),
          claimed.id,
          claimed.trash_generation,
          claimed.trash_generation,
        )
        .run();
    } catch {
      // Keep the claim and quota for the next retry; never record storage keys or errors.
      console.error(JSON.stringify({ event: "trash_purge_retry" }));
    }
  }
}
