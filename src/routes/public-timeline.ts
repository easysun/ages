import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Asset } from "../assets/model";
import { appOrigin } from "../auth/config";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { streamAssetMedia } from "../media/stream";
import { visibleTimelineSql } from "../moderation/availability";
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
        `SELECT * FROM timelines t WHERE t.id = ? AND ${visibleTimelineSql}`,
      )
      .bind(id),
    db
      .prepare(`SELECT i.id, i.caption, i.event_at, i.asset_id, a.kind, a.width, a.height FROM timeline_items i
      LEFT JOIN assets a ON a.id = i.asset_id AND a.owner_id = i.owner_id
      JOIN timelines t ON t.id = i.timeline_id AND t.owner_id = i.owner_id
      WHERE t.id = ? AND ${visibleTimelineSql} AND (i.asset_id IS NULL OR (a.status = 'ready' AND a.deleted_at IS NULL))
      ORDER BY i.position, i.id`)
      .bind(id),
    db
      .prepare(`SELECT a.* FROM assets a JOIN timelines t ON t.cover_asset_id = a.id AND t.owner_id = a.owner_id
      WHERE t.id = ? AND ${visibleTimelineSql} AND a.status = 'ready' AND a.deleted_at IS NULL`)
      .bind(id),
  ]);
  const timeline = result[0]?.results[0] as Timeline | undefined;
  if (!timeline) throw new ApiError("NOT_FOUND");
  context.header(
    "X-Robots-Tag",
    timeline.visibility === "unlisted" ? "noindex, nofollow" : "index, follow",
  );
  const preference = getCookie(context, "ages_locale");
  const language = context.req.header("Accept-Language") ?? "";
  const orderedLanguages = language
    .split(",")
    .map((part, index) => {
      const [tag = "", ...parameters] = part.trim().split(";");
      const quality = parameters.find((value) => value.trim().startsWith("q="));
      const parsed = quality ? Number(quality.trim().slice(2)) : 1;
      return {
        tag: tag.trim().toLowerCase(),
        quality:
          Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0,
        index,
      };
    })
    .filter(({ tag, quality }) => /^(en|zh)(-|$)/.test(tag) && quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  const locale =
    preference === "zh-Hant" || preference === "en"
      ? preference
      : orderedLanguages[0]?.tag.startsWith("zh")
        ? "zh-Hant"
        : "en";
  return context.html(
    renderTimeline(
      timeline,
      result[1]?.results as ViewerItem[],
      (result[2]?.results[0] as Asset | undefined) ?? null,
      appOrigin(context.env),
      locale,
    ),
  );
});

publicTimeline.on(["GET", "HEAD"], "/:id/media/:assetId", async (context) => {
  const membership = async () =>
    context.env.DB.prepare(`SELECT a.* FROM assets a JOIN timelines t ON t.owner_id = a.owner_id
    WHERE t.id = ? AND ${visibleTimelineSql} AND a.id = ? AND a.status = 'ready' AND a.deleted_at IS NULL
      AND (t.cover_asset_id = a.id OR EXISTS (SELECT 1 FROM timeline_items i WHERE i.timeline_id = t.id AND i.owner_id = t.owner_id AND i.asset_id = a.id))`)
      .bind(context.req.param("id"), context.req.param("assetId"))
      .first<Asset>();
  const asset = await membership();
  if (!asset) throw new ApiError("NOT_FOUND");
  return streamAssetMedia(context, asset, async () => {
    if (!(await membership())) throw new ApiError("NOT_FOUND");
  });
});
