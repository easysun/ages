import { Hono } from "hono";
import type { Asset } from "../assets/model";
import { appOrigin } from "../auth/config";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { streamAssetMedia } from "../media/stream";
import type { Timeline } from "../timeline/model";
import { renderTimeline, type ViewerItem } from "../timeline/render";

export const publicTimeline = new Hono<AppContext>();
publicTimeline.use("*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  context.header("X-Robots-Tag", "noindex, nofollow");
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  await next();
});

publicTimeline.get("/:id", async (context) => {
  const id = context.req.param("id");
  const db = context.env.DB;
  // A serialized read batch provides one coherent view of metadata, ordered items, and cover.
  const result = await db.batch([
    db
      .prepare(
        "SELECT * FROM timelines WHERE id = ? AND visibility IN ('unlisted', 'public')",
      )
      .bind(id),
    db
      .prepare(`SELECT i.id, i.caption, i.event_at, a.id AS asset_id, a.kind FROM timeline_items i
      JOIN assets a ON a.id = i.asset_id AND a.owner_id = i.owner_id
      JOIN timelines t ON t.id = i.timeline_id AND t.owner_id = i.owner_id
      WHERE t.id = ? AND t.visibility IN ('unlisted', 'public') AND a.status = 'ready' AND a.deleted_at IS NULL
      ORDER BY i.position, i.id`)
      .bind(id),
    db
      .prepare(`SELECT a.* FROM assets a JOIN timelines t ON t.cover_asset_id = a.id AND t.owner_id = a.owner_id
      WHERE t.id = ? AND t.visibility IN ('unlisted', 'public') AND a.status = 'ready' AND a.deleted_at IS NULL`)
      .bind(id),
  ]);
  const timeline = result[0]?.results[0] as Timeline | undefined;
  if (!timeline) throw new ApiError("NOT_FOUND");
  context.header(
    "X-Robots-Tag",
    timeline.visibility === "unlisted" ? "noindex, nofollow" : "index, follow",
  );
  return context.html(
    renderTimeline(
      timeline,
      result[1]?.results as ViewerItem[],
      (result[2]?.results[0] as Asset | undefined) ?? null,
      appOrigin(context.env),
    ),
  );
});

publicTimeline.on(["GET", "HEAD"], "/:id/media/:assetId", async (context) => {
  const asset =
    await context.env.DB.prepare(`SELECT a.* FROM assets a JOIN timelines t ON t.owner_id = a.owner_id
    WHERE t.id = ? AND t.visibility IN ('unlisted', 'public') AND a.id = ? AND a.status = 'ready' AND a.deleted_at IS NULL
      AND (t.cover_asset_id = a.id OR EXISTS (SELECT 1 FROM timeline_items i WHERE i.timeline_id = t.id AND i.owner_id = t.owner_id AND i.asset_id = a.id))`)
      .bind(context.req.param("id"), context.req.param("assetId"))
      .first<Asset>();
  if (!asset) throw new ApiError("NOT_FOUND");
  return streamAssetMedia(context, asset);
});
