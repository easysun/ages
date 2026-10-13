import type { Bindings } from "../bindings";

const pageLimit = 100;
const lookupChunkSize = 90;
const gracePeriodMs = 24 * 60 * 60 * 1000;
const checkpointTtlSeconds = 24 * 60 * 60;
const checkpointKey = "ops:original-object-reconciliation:v1";

export async function reconcileUntrackedOriginals(
  bindings: Bindings,
): Promise<void> {
  const now = Date.now();
  const cutoff = now - gracePeriodMs;
  const savedCursor = await bindings.LINK_CACHE.get(checkpointKey);
  const options = {
    prefix: "originals/",
    limit: pageLimit,
    ...(savedCursor === null ? {} : { cursor: savedCursor }),
  };

  let page: R2Objects;
  try {
    page = await bindings.MEDIA.list(options);
  } catch (error) {
    if (savedCursor !== null) {
      try {
        await bindings.LINK_CACHE.delete(checkpointKey);
      } catch {
        // A failed reset leaves the prior opaque cursor available to expire naturally.
      }
    }
    throw error;
  }

  if (page.truncated && (!page.cursor || page.cursor.length === 0))
    throw new Error("R2 continuation cursor is missing");

  const counts = {
    objects_scanned: page.objects.length,
    objects_eligible: 0,
    asset_rows_found: 0,
    missing_asset_rows: 0,
    bytes_scanned: 0,
    missing_asset_bytes: 0,
    skipped_recent: 0,
    skipped_future: 0,
    skipped_invalid_uploaded: 0,
  };
  const eligible = [] as typeof page.objects;
  counts.bytes_scanned = page.objects.reduce(
    (total, object) => total + object.size,
    0,
  );

  for (const object of page.objects) {
    const uploadedAt = object.uploaded.getTime();
    if (!Number.isFinite(uploadedAt)) {
      counts.skipped_invalid_uploaded++;
    } else if (uploadedAt > now) {
      counts.skipped_future++;
    } else if (uploadedAt < cutoff) {
      eligible.push(object);
    } else {
      counts.skipped_recent++;
    }
  }

  counts.objects_eligible = eligible.length;

  const foundKeys = new Set<string>();
  for (let offset = 0; offset < eligible.length; offset += lookupChunkSize) {
    const keys = eligible
      .slice(offset, offset + lookupChunkSize)
      .map((object) => object.key);
    const placeholders = keys.map(() => "?").join(", ");
    const rows = await bindings.DB.prepare(
      `SELECT r2_key FROM assets WHERE r2_key IN (${placeholders})`,
    )
      .bind(...keys)
      .all<{ r2_key: string }>();
    for (const row of rows.results) foundKeys.add(row.r2_key);
  }

  for (const object of eligible) {
    if (foundKeys.has(object.key)) {
      counts.asset_rows_found++;
    } else {
      counts.missing_asset_rows++;
      counts.missing_asset_bytes += object.size;
    }
  }

  if (page.truncated) {
    await bindings.LINK_CACHE.put(checkpointKey, page.cursor, {
      expirationTtl: checkpointTtlSeconds,
    });
  } else {
    await bindings.LINK_CACHE.delete(checkpointKey);
  }

  console.info(
    JSON.stringify({
      event: "original_object_reconciliation_page",
      ...counts,
    }),
  );
}
