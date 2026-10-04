import { cleanupLimits } from "./abuse/limits";
import { cleanupExpiredUploads } from "./assets/cleanup";
import { purgeExpiredTrash } from "./assets/purge";
import { cleanupAuth } from "./auth/session";
import type { Bindings } from "./bindings";

export async function scheduledCleanup(bindings: Bindings) {
  await cleanupAuth(bindings);
  await cleanupLimits(bindings.DB);
  await cleanupExpiredUploads(bindings);
  await purgeExpiredTrash(bindings);
}
