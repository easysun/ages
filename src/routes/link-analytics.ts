import { Hono } from "hono";
import { appOrigin, assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";
import { getLinkTracking, linkTrackingSchema } from "../links/tracking";

export const linkAnalytics = new Hono<AppContext>();

linkAnalytics.use("*", requireUser, async (context, next) => {
  appOrigin(context.env);
  context.header("Cache-Control", "private, no-store");
  if (!(["GET", "HEAD", "OPTIONS"] as string[]).includes(context.req.method))
    assertSameOrigin(context);
  await next();
});

linkAnalytics.get("/:id/tracking", async (context) => {
  const linkId = context.req.param("id");
  const link = await context.env.DB.prepare(
    "SELECT id FROM distribution_links WHERE id = ? AND owner_id = ?",
  )
    .bind(linkId, context.get("user").id)
    .first();
  if (!link) throw new ApiError("NOT_FOUND");
  return context.json({
    tracking: await getLinkTracking(context.env.DB, linkId),
  });
});

linkAnalytics.put("/:id/tracking", async (context) => {
  const linkId = context.req.param("id");
  const owner = context.get("user").id;
  const link = await context.env.DB.prepare(
    "SELECT id FROM distribution_links WHERE id = ? AND owner_id = ?",
  )
    .bind(linkId, owner)
    .first();
  if (!link) throw new ApiError("NOT_FOUND");
  const input = await parseJson(context, linkTrackingSchema);
  const db = context.env.DB;
  const statements = [
    db
      .prepare(`INSERT INTO link_tracking_settings (
        link_id, owner_id, utm_source, utm_medium, utm_campaign, utm_term,
        utm_content, custom_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(link_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        utm_source = excluded.utm_source,
        utm_medium = excluded.utm_medium,
        utm_campaign = excluded.utm_campaign,
        utm_term = excluded.utm_term,
        utm_content = excluded.utm_content,
        custom_json = excluded.custom_json`)
      .bind(
        linkId,
        owner,
        input.utm.utm_source ?? null,
        input.utm.utm_medium ?? null,
        input.utm.utm_campaign ?? null,
        input.utm.utm_term ?? null,
        input.utm.utm_content ?? null,
        JSON.stringify(input.custom),
      ),
    db
      .prepare("DELETE FROM link_tags WHERE link_id = ? AND owner_id = ?")
      .bind(linkId, owner),
    db
      .prepare("DELETE FROM link_channels WHERE link_id = ? AND owner_id = ?")
      .bind(linkId, owner),
    ...input.tags.map((tag, position) =>
      db
        .prepare(
          "INSERT INTO link_tags (link_id, owner_id, tag, position) VALUES (?, ?, ?, ?)",
        )
        .bind(linkId, owner, tag, position),
    ),
    ...input.channels.map((channel, position) =>
      db
        .prepare(
          "INSERT INTO link_channels (link_id, owner_id, channel, position) VALUES (?, ?, ?, ?)",
        )
        .bind(linkId, owner, channel, position),
    ),
  ];
  await db.batch(statements);
  return context.json({ tracking: await getLinkTracking(db, linkId) });
});
