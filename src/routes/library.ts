import { type Context, Hono } from "hono";
import {
  emptyMutationSchema,
  encodeCursor,
  libraryQuery,
  mediaRange,
  tagsSchema,
} from "../assets/library";
import { type Asset, assetPayload } from "../assets/model";
import { restoreAsset, trashAsset } from "../assets/trash";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";

export const library = new Hono<AppContext>();
library.use("*", requireUser, async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});

async function findAsset(db: D1Database, id: string, owner: string) {
  const asset = await db
    .prepare(
      "SELECT * FROM assets WHERE id = ? AND owner_id = ? AND status NOT IN ('deleted', 'purged')",
    )
    .bind(id, owner)
    .first<Asset>();
  if (!asset) throw new ApiError("NOT_FOUND");
  return asset;
}
async function payloads(db: D1Database, assets: Asset[], owner: string) {
  if (assets.length === 0) return [];
  // A JSON parameter keeps a hundred-asset page below D1's bound-parameter limit.
  const result = await db
    .prepare(`SELECT asset_id, tag FROM asset_tags
    WHERE owner_id = ? AND asset_id IN (SELECT value FROM json_each(?)) ORDER BY tag`)
    .bind(owner, JSON.stringify(assets.map((asset) => asset.id)))
    .all<{ asset_id: string; tag: string }>();
  const tags = new Map<string, string[]>();
  for (const row of result.results) {
    const values = tags.get(row.asset_id) ?? [];
    values.push(row.tag);
    tags.set(row.asset_id, values);
  }
  return assets.map((asset) => ({
    ...assetPayload(asset),
    tags: tags.get(asset.id) ?? [],
  }));
}

async function listAssets(
  context: Context<AppContext>,
  status: "ready" | "deleted",
) {
  const owner = context.get("user").id;
  const { limit, tag, cursor } = libraryQuery(
    context.req.url,
    owner,
    status === "deleted" ? "trash" : undefined,
  );
  const clauses = ["owner_id = ?", "status = ?"];
  const values: (string | number)[] = [owner, status];
  if (tag !== null) {
    clauses.push(
      "EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = assets.id AND t.owner_id = assets.owner_id AND t.tag = ?)",
    );
    values.push(tag);
  }
  if (cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    values.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const result = await context.env.DB.prepare(
    `SELECT * FROM assets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...values, limit + 1)
    .all<Asset>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  const nextCursor =
    result.results.length > limit && last
      ? encodeCursor({
          v: 1,
          ...(status === "deleted" ? { collection: "trash" as const } : {}),
          owner,
          tag,
          created_at: last.created_at,
          id: last.id,
        })
      : null;
  return context.json({
    assets: await payloads(context.env.DB, rows, owner),
    next_cursor: nextCursor,
  });
}

library.get("/", (context) => listAssets(context, "ready"));
library.get("/trash", (context) => listAssets(context, "deleted"));

library.post("/:id/trash", async (context) => {
  await parseJson(context, emptyMutationSchema);
  const owner = context.get("user").id;
  const asset = await trashAsset(
    context.env.DB,
    context.req.param("id"),
    owner,
  );
  return context.json({
    asset: (await payloads(context.env.DB, [asset], owner))[0],
  });
});
library.post("/:id/restore", async (context) => {
  await parseJson(context, emptyMutationSchema);
  const owner = context.get("user").id;
  const asset = await restoreAsset(context.env, context.req.param("id"), owner);
  return context.json({
    asset: (await payloads(context.env.DB, [asset], owner))[0],
  });
});

library.get("/:id", async (context) => {
  const asset = await findAsset(
    context.env.DB,
    context.req.param("id"),
    context.get("user").id,
  );
  return context.json({
    asset: (await payloads(context.env.DB, [asset], asset.owner_id))[0],
  });
});

library.put("/:id/tags", async (context) => {
  const owner = context.get("user").id;
  const id = context.req.param("id");
  const input = await parseJson(context, tagsSchema);
  await findAsset(context.env.DB, id, owner);
  const db = context.env.DB;
  // Every statement is scoped to a live owned asset; D1 batches commit or roll back together.
  const live =
    "EXISTS (SELECT 1 FROM assets WHERE id = ? AND owner_id = ? AND status NOT IN ('deleted', 'purged'))";
  await db.batch([
    db
      .prepare(
        `DELETE FROM asset_tags WHERE asset_id = ? AND owner_id = ? AND ${live}`,
      )
      .bind(id, owner, id, owner),
    ...input.tags.map((tag) =>
      db
        .prepare(
          `INSERT INTO asset_tags (asset_id, owner_id, tag) SELECT ?, ?, ? WHERE ${live}`,
        )
        .bind(id, owner, tag, id, owner),
    ),
    db
      .prepare(
        "UPDATE assets SET updated_at = ? WHERE id = ? AND owner_id = ? AND status NOT IN ('deleted', 'purged')",
      )
      .bind(new Date().toISOString(), id, owner),
  ]);
  return context.json({
    asset: (await payloads(db, [await findAsset(db, id, owner)], owner))[0],
  });
});

library.on(["GET", "HEAD"], "/:id/media", async (context) => {
  const asset = await findAsset(
    context.env.DB,
    context.req.param("id"),
    context.get("user").id,
  );
  if (asset.status !== "ready" || !asset.etag) throw new ApiError("NOT_FOUND");
  const head = await context.env.MEDIA.head(asset.r2_key);
  if (
    !head ||
    head.etag !== asset.etag ||
    head.size !== asset.size_bytes ||
    head.httpMetadata?.contentType !== asset.mime_type
  )
    throw new ApiError("NOT_FOUND");
  if (context.req.method === "HEAD") {
    context.header("Content-Type", asset.mime_type);
    context.header("Content-Length", String(asset.size_bytes));
    context.header("Accept-Ranges", "bytes");
    return context.body(null, 200);
  }
  // If-Range cannot match an undisclosed validator, so return the complete representation.
  const rangeHeader = context.req.header("If-Range")
    ? undefined
    : context.req.header("Range");
  const range =
    rangeHeader === undefined
      ? undefined
      : mediaRange(rangeHeader, asset.size_bytes);
  if (range === null) {
    context.header("Accept-Ranges", "bytes");
    context.header("Content-Length", "0");
    context.header("Content-Range", `bytes */${asset.size_bytes}`);
    return context.body(null, 416);
  }
  const object = await context.env.MEDIA.get(asset.r2_key, {
    onlyIf: { etagMatches: asset.etag },
    ...(range ? { range } : {}),
  });
  if (!object || !("body" in object)) throw new ApiError("NOT_FOUND");
  if (
    object.version !== head.version ||
    object.etag !== asset.etag ||
    object.size !== asset.size_bytes ||
    object.httpMetadata?.contentType !== asset.mime_type
  ) {
    await object.body.cancel();
    throw new ApiError("NOT_FOUND");
  }
  context.header("Content-Type", asset.mime_type);
  context.header("Accept-Ranges", "bytes");
  context.header("Content-Length", String(range?.length ?? asset.size_bytes));
  if (range) {
    context.header("Content-Length", String(range.length));
    context.header(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${asset.size_bytes}`,
    );
  }
  return context.body(object.body, range ? 206 : 200);
});
