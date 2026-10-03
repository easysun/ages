import { type Context, Hono } from "hono";
import {
  emptyMutationSchema,
  encodeCursor,
  libraryQuery,
  tagsSchema,
} from "../assets/library";
import { type Asset, assetPayload } from "../assets/model";
import { restoreAsset, trashAsset } from "../assets/trash";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";
import { streamAssetMedia } from "../media/stream";

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
  return streamAssetMedia(context, asset);
});
