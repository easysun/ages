import type { Bindings } from "../bindings";
import type { Asset } from "./model";

export async function cleanupExpiredUploads(bindings: Bindings, afterId = "") {
  const now = new Date();
  // A reservation can be released immediately. Object deletion waits beyond PUT expiry.
  await bindings.DB.prepare(`UPDATE assets SET status = 'failed', updated_at = ?
    WHERE status = 'pending' AND upload_expires_at <= ?`)
    .bind(now.toISOString(), now.toISOString())
    .run();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const batch = await bindings.DB.prepare(`SELECT * FROM assets
    WHERE status = 'failed' AND upload_expires_at < ? AND id > ? ORDER BY id LIMIT 100`)
    .bind(cutoff, afterId)
    .all<Asset>();
  for (const asset of batch.results) {
    await bindings.MEDIA.delete(asset.r2_key);
    await bindings.DB.prepare(
      "UPDATE assets SET status = 'purged', updated_at = ? WHERE id = ? AND status = 'failed'",
    )
      .bind(now.toISOString(), asset.id)
      .run();
  }
  return batch.results.length === 100 ? (batch.results[99]?.id ?? null) : null;
}
