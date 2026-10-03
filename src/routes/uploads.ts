import { Hono } from "hono";
import { type Asset, assetPayload } from "../assets/model";
import { signUpload } from "../assets/signing";
import { uploadSchema, validateSignature } from "../assets/validation";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";

export const uploads = new Hono<AppContext>();
uploads.use("*", requireUser, async (context, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});

uploads.post("/upload-intent", async (context) => {
  const input = await parseJson(context, uploadSchema);
  const owner = context.get("user").id;
  const quota = await context.env.DB.prepare(
    "SELECT max_asset_bytes FROM usage_quotas WHERE user_id = ?",
  )
    .bind(owner)
    .first<{ max_asset_bytes: number }>();
  if (!quota) throw new ApiError("SERVICE_UNAVAILABLE");
  const kind = input.mime_type.startsWith("image/") ? "image" : "video";
  const mediaLimit = (kind === "image" ? 25 : 250) * 1024 ** 2;
  if (input.size_bytes > Math.min(mediaLimit, quota.max_asset_bytes))
    throw new ApiError("ASSET_TOO_LARGE");
  const now = new Date();
  const id = `as_${crypto.randomUUID()}`;
  const key = `originals/${owner}/${id}/${crypto.randomUUID()}`;
  const upload = await signUpload(
    context.env,
    key,
    input.mime_type,
    input.size_bytes,
    now,
  );
  // A single serialized SQL statement reserves capacity for all live pending intents.
  const asset = await context.env.DB.prepare(`INSERT INTO assets
    (id, owner_id, kind, original_name, mime_type, size_bytes, r2_key, captured_at,
      upload_expires_at, created_at, updated_at)
    SELECT ?, user_id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM usage_quotas q
    WHERE user_id = ? AND ? <= max_asset_bytes
      AND storage_used_bytes + ? + COALESCE((SELECT SUM(size_bytes) FROM assets
        WHERE owner_id = q.user_id AND status IN ('pending', 'failed')
          AND upload_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 0) <= storage_limit_bytes
    RETURNING *`)
    .bind(
      id,
      kind,
      input.filename,
      input.mime_type,
      input.size_bytes,
      key,
      input.captured_at ?? null,
      upload.expires_at,
      now.toISOString(),
      now.toISOString(),
      owner,
      input.size_bytes,
      input.size_bytes,
    )
    .first<Asset>();
  if (!asset) throw new ApiError("QUOTA_EXCEEDED");
  return context.json({ asset: assetPayload(asset), upload }, 201);
});

uploads.post("/:id/complete", async (context) => {
  const db = context.env.DB;
  const owner = context.get("user").id;
  const asset = await db
    .prepare("SELECT * FROM assets WHERE id = ? AND owner_id = ?")
    .bind(context.req.param("id"), owner)
    .first<Asset>();
  if (!asset || asset.status === "deleted" || asset.status === "purged")
    throw new ApiError("NOT_FOUND");
  if (asset.status === "ready")
    return context.json({ asset: assetPayload(asset) });
  if (asset.upload_expires_at <= new Date().toISOString())
    throw new ApiError("UPLOAD_EXPIRED");
  if (asset.status !== "pending")
    throw new ApiError("UPLOAD_VALIDATION_FAILED");
  const head = await context.env.MEDIA.head(asset.r2_key);
  // Missing objects remain retryable while a direct PUT is still in flight.
  if (!head) throw new ApiError("UPLOAD_VALIDATION_FAILED");
  let dimensions: { width: number | null; height: number | null };
  try {
    if (
      head.size !== asset.size_bytes ||
      head.httpMetadata?.contentType !== asset.mime_type
    ) {
      throw new ApiError("UPLOAD_VALIDATION_FAILED");
    }
    const sample = await context.env.MEDIA.get(asset.r2_key, {
      range: { offset: 0, length: Math.min(head.size, 256 * 1024) },
      onlyIf: { etagMatches: head.etag },
    });
    if (!sample || !("body" in sample))
      throw new ApiError("UPLOAD_VALIDATION_FAILED");
    dimensions = await validateSignature(
      await sample.arrayBuffer(),
      asset.mime_type,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      await db
        .prepare(
          "UPDATE assets SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .bind(new Date().toISOString(), asset.id)
        .run();
    }
    throw error;
  }
  const now = new Date().toISOString();
  // Status transition and its accounting trigger are one atomic write; duplicates are no-ops.
  await db
    .prepare(`UPDATE assets SET status = 'ready', etag = ?, width = ?, height = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
      AND upload_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .bind(head.etag, dimensions.width, dimensions.height, now, asset.id)
    .run();
  const completed = await db
    .prepare("SELECT * FROM assets WHERE id = ? AND owner_id = ?")
    .bind(asset.id, owner)
    .first<Asset>();
  if (completed?.status !== "ready") throw new ApiError("UPLOAD_EXPIRED");
  return context.json({ asset: assetPayload(completed) });
});
