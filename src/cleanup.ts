import { cleanupLimits } from "./abuse/limits";
import { cleanupExpiredUploads } from "./assets/cleanup";
import { purgeExpiredTrash } from "./assets/purge";
import { reconcileUntrackedOriginals } from "./assets/reconciliation";
import { cleanupAuth } from "./auth/session";
import type { Bindings } from "./bindings";

async function cleanupTrackingTickets(db: D1Database) {
  await db
    .prepare(`DELETE FROM tracking_tickets WHERE token_hash IN (
      SELECT token_hash FROM tracking_tickets
      WHERE consumed_at IS NOT NULL OR julianday(expires_at) <= julianday(?)
      ORDER BY expires_at, token_hash LIMIT 100
    )`)
    .bind(new Date().toISOString())
    .run();
}

export async function scheduledCleanup(bindings: Bindings) {
  await cleanupAuth(bindings);
  await cleanupLimits(bindings.DB);
  await cleanupTrackingTickets(bindings.DB);
  await cleanupExpiredUploads(bindings);
  await purgeExpiredTrash(bindings);
  try {
    await reconcileUntrackedOriginals(bindings);
  } catch {
    console.error(
      JSON.stringify({ event: "original_object_reconciliation_failed" }),
    );
  }
}
