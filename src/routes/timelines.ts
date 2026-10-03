import { Hono } from "hono";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";
import {
  type Timeline,
  type TimelineItem,
  timelinePayload,
} from "../timeline/model";
import { mutateTimeline } from "../timeline/mutations";
import {
  appendItemSchema,
  createTimelineSchema,
  cursorSchema,
  listSchema,
  orderSchema,
  removeItemSchema,
  updateItemSchema,
  updateTimelineSchema,
} from "../timeline/validation";

export const timelines = new Hono<AppContext>();
timelines.use("*", requireUser, async (context, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});
timelines.post("/", async (context) => {
  const input = await parseJson(context, createTimelineSchema);
  const owner = context.get("user").id;
  const now = new Date().toISOString();
  const row =
    await context.env.DB.prepare(`INSERT INTO timelines (id, owner_id, title, created_at, updated_at)
    SELECT ?, user_id, ?, ?, ? FROM usage_quotas q WHERE user_id = ?
      AND (SELECT count(*) FROM timelines WHERE owner_id = q.user_id) < timeline_limit RETURNING *`)
      .bind(`tl_${crypto.randomUUID()}`, input.title, now, now, owner)
      .first<Timeline>();
  if (!row) throw new ApiError("TIMELINE_QUOTA_EXCEEDED");
  return context.json({ timeline: timelinePayload(row, []) }, 201);
});
timelines.get("/", async (context) => {
  const parsed = listSchema.safeParse(context.req.query());
  if (!parsed.success) throw new ApiError("INVALID_REQUEST");
  const { limit, cursor } = parsed.data;
  let after: { created_at: string; id: string } | undefined;
  if (cursor) {
    try {
      after = cursorSchema.parse(JSON.parse(atob(cursor)));
    } catch {
      throw new ApiError("INVALID_REQUEST");
    }
  }
  const page =
    await context.env.DB.prepare(`SELECT * FROM timelines WHERE owner_id = ?
    ${after ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(
        context.get("user").id,
        ...(after ? [after.created_at, after.created_at, after.id] : []),
        limit + 1,
      )
      .all<Timeline>();
  const rows = page.results.slice(0, limit);
  const last = rows.at(-1);
  return context.json({
    timelines: rows.map((row) => timelinePayload(row)),
    next_cursor:
      page.results.length > limit && last
        ? btoa(JSON.stringify({ created_at: last.created_at, id: last.id }))
        : null,
  });
});
timelines.get("/:id", async (context) => {
  const id = context.req.param("id");
  const owner = context.get("user").id;
  const rows = await context.env.DB.batch([
    context.env.DB.prepare(
      "SELECT * FROM timelines WHERE id = ? AND owner_id = ?",
    ).bind(id, owner),
    context.env.DB.prepare(
      "SELECT * FROM timeline_items WHERE timeline_id = ? AND owner_id = ? ORDER BY position, id",
    ).bind(id, owner),
  ]);
  const row = rows[0]?.results[0] as Timeline | undefined;
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    timeline: timelinePayload(row, rows[1]?.results as TimelineItem[]),
  });
});
timelines.patch("/:id", async (context) => {
  const { expected_version, ...change } = await parseJson(
    context,
    updateTimelineSchema,
  );
  return context.json({
    timeline: await mutateTimeline(
      context.env.DB,
      context.get("user").id,
      context.req.param("id"),
      expected_version,
      { kind: "metadata", ...change },
    ),
  });
});
timelines.post("/:id/items", async (context) => {
  const { expected_version, ...change } = await parseJson(
    context,
    appendItemSchema,
  );
  return context.json(
    {
      timeline: await mutateTimeline(
        context.env.DB,
        context.get("user").id,
        context.req.param("id"),
        expected_version,
        { kind: "append", ...change },
      ),
    },
    201,
  );
});
timelines.patch("/:id/items/:itemId", async (context) => {
  const { expected_version, ...change } = await parseJson(
    context,
    updateItemSchema,
  );
  return context.json({
    timeline: await mutateTimeline(
      context.env.DB,
      context.get("user").id,
      context.req.param("id"),
      expected_version,
      { kind: "edit", item_id: context.req.param("itemId"), ...change },
    ),
  });
});
timelines.delete("/:id/items/:itemId", async (context) => {
  const { expected_version } = await parseJson(context, removeItemSchema);
  return context.json({
    timeline: await mutateTimeline(
      context.env.DB,
      context.get("user").id,
      context.req.param("id"),
      expected_version,
      { kind: "remove", item_id: context.req.param("itemId") },
    ),
  });
});
timelines.put("/:id/order", async (context) => {
  const { expected_version, item_ids } = await parseJson(context, orderSchema);
  return context.json({
    timeline: await mutateTimeline(
      context.env.DB,
      context.get("user").id,
      context.req.param("id"),
      expected_version,
      { kind: "order", item_ids },
    ),
  });
});
