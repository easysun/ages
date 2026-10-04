import type { Bindings } from "../bindings";
import type { Asset } from "./model";

export async function cleanupExpiredUploads(bindings: Bindings) {
  const now = new Date();
  // A reservation can be released immediately. Object deletion waits beyond PUT expiry.
  await bindings.DB.prepare(`UPDATE assets SET status = 'failed', updated_at = ?
    WHERE id IN (SELECT id FROM assets WHERE status = 'pending' AND upload_expires_at <= ? ORDER BY upload_expires_at, id LIMIT 100)`)
    .bind(now.toISOString(), now.toISOString())
    .run();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const batch = await bindings.DB.prepare(`SELECT * FROM assets
    WHERE status = 'failed' AND upload_expires_at < ? ORDER BY updated_at, id LIMIT 100`)
    .bind(cutoff)
    .all<Asset>();
  for (const asset of batch.results) {
    // Rotate attempts before R2 access so a persistently failing page cannot starve later rows.
    const attempted =
      await bindings.DB.prepare(`UPDATE assets SET updated_at = ?
      WHERE id = ? AND status = 'failed' AND upload_expires_at < ? RETURNING id`)
        .bind(now.toISOString(), asset.id, cutoff)
        .first();
    if (!attempted) continue;
    try {
      await bindings.MEDIA.delete(asset.r2_key);
      await bindings.DB.prepare(
        "UPDATE assets SET status = 'purged', updated_at = ? WHERE id = ? AND status = 'failed'",
      )
        .bind(now.toISOString(), asset.id)
        .run();
    } catch {
      console.error(JSON.stringify({ event: "upload_cleanup_retry" }));
    }
  }
}
