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
  timelineItemsQuerySchema,
  timelineOverviewQuerySchema,
  timelineReadCursorSchema,
  updateItemSchema,
  updateTimelineSchema,
} from "../timeline/validation";

type TimelineReadPosition = { id: string; position: number };
type TimelineDetailRow = {
  id: string;
  asset_id: string;
  position: number;
  caption: string;
  event_at: string | null;
  asset_summary_id: string;
  asset_kind: string;
  asset_original_name: string;
  asset_width: number | null;
  asset_height: number | null;
  asset_duration_ms: number | null;
};

function readQuery(url: string) {
  const params = new URL(url).searchParams;
  const query = Object.create(null) as Record<string, string>;
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1) throw new ApiError("INVALID_REQUEST");
    query[key] = params.get(key) ?? "";
  }
  return query;
}

function encodeReadCursor(cursor: {
  timeline_id: string;
  position: number;
  id: string;
}) {
  const value = timelineReadCursorSchema.parse({ v: 1, ...cursor });
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeReadCursor(encoded: string, timelineId: string) {
  try {
    if (!/^[A-Za-z0-9_-]{1,1000}$/.test(encoded))
      throw new Error("Invalid cursor");
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const cursor = timelineReadCursorSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
    if (
      cursor.timeline_id !== timelineId ||
      encodeReadCursor(cursor) !== encoded
    )
      throw new Error("Cursor scope mismatch");
    return cursor;
  } catch {
    throw new ApiError("INVALID_REQUEST");
  }
}

function pageSelector(
  cursor: { position: number; id: string } | undefined,
  fromPosition: number | undefined,
  fromId: string | undefined,
  tableAlias?: "i",
) {
  const positionColumn = tableAlias ? `${tableAlias}.position` : "position";
  const idColumn = tableAlias ? `${tableAlias}.id` : "id";
  if (cursor)
    return {
      sql: `AND (${positionColumn} > ? OR (${positionColumn} = ? AND ${idColumn} > ?))`,
      values: [cursor.position, cursor.position, cursor.id],
    };
  if (fromPosition !== undefined && fromId !== undefined)
    return {
      sql: `AND (${positionColumn} > ? OR (${positionColumn} = ? AND ${idColumn} >= ?))`,
      values: [fromPosition, fromPosition, fromId],
    };
  return { sql: "", values: [] as (string | number)[] };
}

function nextReadCursor(
  rows: readonly TimelineReadPosition[],
  hasMore: boolean,
  timelineId: string,
) {
  const last = rows.at(-1);
  return hasMore && last
    ? encodeReadCursor({
        timeline_id: timelineId,
        position: last.position,
        id: last.id,
      })
    : null;
}

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
timelines.get("/:id/overview", async (context) => {
  const parsed = timelineOverviewQuerySchema.safeParse(
    readQuery(context.req.url),
  );
  if (!parsed.success) throw new ApiError("INVALID_REQUEST");
  const { limit, version, cursor, from_position, from_id } = parsed.data;
  const id = context.req.param("id");
  const owner = context.get("user").id;
  const after = cursor ? decodeReadCursor(cursor, id) : undefined;
  const selector = pageSelector(after, from_position, from_id);
  const result = await context.env.DB.batch([
    context.env.DB.prepare(
      "SELECT * FROM timelines WHERE id = ? AND owner_id = ?",
    ).bind(id, owner),
    context.env.DB.prepare(`SELECT id, position FROM timeline_items
      WHERE timeline_id = ? AND owner_id = ? ${selector.sql}
      ORDER BY position, id LIMIT ?`).bind(
      id,
      owner,
      ...selector.values,
      limit + 1,
    ),
    context.env.DB.prepare(`SELECT COUNT(*) AS total_items FROM timeline_items
      WHERE timeline_id = ? AND owner_id = ?`).bind(id, owner),
  ]);
  const timeline = result[0]?.results[0] as Timeline | undefined;
  if (!timeline) throw new ApiError("NOT_FOUND");
  if (version !== undefined && version !== timeline.version)
    throw new ApiError("CONFLICT");

  const page = (result[1]?.results ?? []) as TimelineReadPosition[];
  const rows = page.slice(0, limit);
  const count = result[2]?.results[0] as { total_items: number } | undefined;
  return context.json({
    timeline: timelinePayload(timeline),
    total_items: count?.total_items ?? 0,
    items: rows,
    next_cursor: nextReadCursor(rows, page.length > limit, id),
  });
});
timelines.get("/:id/items", async (context) => {
  const parsed = timelineItemsQuerySchema.safeParse(readQuery(context.req.url));
  if (!parsed.success) throw new ApiError("INVALID_REQUEST");
  const { limit, version, cursor, from_position, from_id } = parsed.data;
  const id = context.req.param("id");
  const owner = context.get("user").id;
  const after = cursor ? decodeReadCursor(cursor, id) : undefined;
  const selector = pageSelector(after, from_position, from_id, "i");
  const result = await context.env.DB.batch([
    context.env.DB.prepare(
      "SELECT * FROM timelines WHERE id = ? AND owner_id = ?",
    ).bind(id, owner),
    context.env.DB.prepare(`SELECT i.id, i.asset_id, i.position, i.caption, i.event_at,
        a.id AS asset_summary_id, a.kind AS asset_kind,
        a.original_name AS asset_original_name, a.width AS asset_width,
        a.height AS asset_height, a.duration_ms AS asset_duration_ms
      FROM timeline_items i
      JOIN assets a ON a.id = i.asset_id AND a.owner_id = i.owner_id
      WHERE i.timeline_id = ? AND i.owner_id = ? ${selector.sql}
      ORDER BY i.position, i.id LIMIT ?`).bind(
      id,
      owner,
      ...selector.values,
      limit + 1,
    ),
  ]);
  const timeline = result[0]?.results[0] as Timeline | undefined;
  if (!timeline) throw new ApiError("NOT_FOUND");
  if (version !== timeline.version) throw new ApiError("CONFLICT");

  const page = (result[1]?.results ?? []) as TimelineDetailRow[];
  const rows = page.slice(0, limit);
  return context.json({
    version: timeline.version,
    items: rows.map((item) => ({
      id: item.id,
      asset_id: item.asset_id,
      position: item.position,
      caption: item.caption,
      event_at: item.event_at === null ? null : JSON.parse(item.event_at),
      asset: {
        id: item.asset_summary_id,
        kind: item.asset_kind,
        original_name: item.asset_original_name,
        width: item.asset_width,
        height: item.asset_height,
        duration_ms: item.asset_duration_ms,
      },
    })),
    next_cursor: nextReadCursor(rows, page.length > limit, id),
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
