import { Hono } from "hono";
import { encodeCursor, libraryQuery } from "../assets/library";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import {
  type ContentNode,
  createContentNodeSchema,
  effectiveNode,
  publicNodePayload,
  updateContentNodeSchema,
} from "../graph/nodes";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";

type ContentNodeRow = ContentNode & { timeline_title: string | null };

export const contentNodes = new Hono<AppContext>();

contentNodes.use("*", requireUser, async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
    assertSameOrigin(context);
  }
  await next();
});

function nodeWithReadTimeTitle(row: ContentNodeRow): ContentNode {
  const { timeline_title: timelineTitle, ...node } = row;
  return {
    ...node,
    title: node.kind === "timeline" ? timelineTitle : node.title,
  };
}

async function readOwnedNode(
  db: D1Database,
  id: string,
  owner: string,
  includeRemoved = false,
): Promise<ContentNode | null> {
  const row = await db
    .prepare(
      "SELECT n.*, t.title AS timeline_title FROM content_nodes n " +
        "LEFT JOIN timelines t ON t.id=n.timeline_id AND t.owner_id=n.owner_id " +
        "WHERE n.id=? AND n.owner_id=?" +
        (includeRemoved ? "" : " AND n.removed_at IS NULL"),
    )
    .bind(id, owner)
    .first<ContentNodeRow>();
  return row ? nodeWithReadTimeTitle(row) : null;
}

function isLiveTimelineConflict(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes(
      "UNIQUE constraint failed: content_nodes.owner_id, content_nodes.timeline_id",
    )
  );
}

contentNodes.post("/", async (context) => {
  const input = await parseJson(context, createContentNodeSchema);
  const owner = context.get("user").id;
  const now = new Date().toISOString();
  const id = `cn_${crypto.randomUUID()}`;
  const db = context.env.DB;

  if (input.kind === "timeline") {
    const source = await db
      .prepare("SELECT id FROM timelines WHERE id=? AND owner_id=?")
      .bind(input.timeline_id, owner)
      .first();
    if (!source) throw new ApiError("NOT_FOUND");
    const duplicate = await db
      .prepare(
        "SELECT id FROM content_nodes WHERE owner_id=? AND timeline_id=? AND kind='timeline' AND removed_at IS NULL",
      )
      .bind(owner, input.timeline_id)
      .first();
    if (duplicate) throw new ApiError("CONFLICT");
    try {
      await db
        .prepare(
          "INSERT INTO content_nodes (id, owner_id, kind, visibility, timeline_id, url, title, created_at, updated_at) VALUES (?, ?, 'timeline', ?, ?, NULL, NULL, ?, ?)",
        )
        .bind(id, owner, input.visibility, input.timeline_id, now, now)
        .run();
    } catch (error) {
      if (isLiveTimelineConflict(error)) throw new ApiError("CONFLICT");
      throw error;
    }
  } else {
    await db
      .prepare(
        "INSERT INTO content_nodes (id, owner_id, kind, visibility, timeline_id, url, title, created_at, updated_at) VALUES (?, ?, 'external', ?, NULL, ?, ?, ?, ?)",
      )
      .bind(id, owner, input.visibility, input.url, input.title, now, now)
      .run();
  }

  const created = await readOwnedNode(db, id, owner);
  if (!created) throw new ApiError("NOT_FOUND");
  return context.json({ node: publicNodePayload(created) }, 201);
});

contentNodes.get("/", async (context) => {
  const owner = context.get("user").id;
  const url = new URL(context.req.url);
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (
      !["limit", "cursor", "removed"].includes(key) ||
      params.getAll(key).length !== 1
    ) {
      throw new ApiError("INVALID_REQUEST");
    }
  }

  const removedValues = params.getAll("removed");
  const removed = removedValues.length === 1 && removedValues[0] === "true";
  if (removedValues.length > 0 && !removed)
    throw new ApiError("INVALID_REQUEST");

  const cursorPrefix = removed ? "removed-nodes." : "nodes.";
  const encoded = params.get("cursor");
  if (encoded !== null) {
    if (!encoded.startsWith(cursorPrefix))
      throw new ApiError("INVALID_REQUEST");
    params.set("cursor", encoded.slice(cursorPrefix.length));
  }
  params.delete("removed");

  const { limit, cursor } = libraryQuery(
    url.href,
    owner,
    removed ? "trash" : undefined,
  );
  const rows = await context.env.DB.prepare(
    "SELECT n.*, t.title AS timeline_title FROM content_nodes n " +
      "LEFT JOIN timelines t ON t.id=n.timeline_id AND t.owner_id=n.owner_id " +
      "WHERE n.owner_id=? AND " +
      (removed ? "n.removed_at IS NOT NULL" : "n.removed_at IS NULL") +
      (cursor
        ? " AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))"
        : "") +
      " ORDER BY n.created_at DESC, n.id DESC LIMIT ?",
  )
    .bind(
      owner,
      ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
      limit + 1,
    )
    .all<ContentNodeRow>();

  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.results.length > limit && last
      ? cursorPrefix +
        encodeCursor({
          v: 1,
          ...(removed ? { collection: "trash" as const } : {}),
          owner,
          tag: null,
          created_at: last.created_at,
          id: last.id,
        })
      : null;

  return context.json({
    nodes: page.map((row) => publicNodePayload(nodeWithReadTimeTitle(row))),
    next_cursor: nextCursor,
  });
});

contentNodes.get("/:id", async (context) => {
  const owner = context.get("user").id;
  const id = context.req.param("id");
  const row = await readOwnedNode(context.env.DB, id, owner);
  if (!row) throw new ApiError("NOT_FOUND");
  const effective = await effectiveNode(context.env.DB, id, owner);
  return context.json({
    node: publicNodePayload(row),
    effective_visibility: effective?.visibility ?? null,
  });
});

contentNodes.patch("/:id", async (context) => {
  const input = await parseJson(context, updateContentNodeSchema);
  const db = context.env.DB;
  const id = context.req.param("id");
  const owner = context.get("user").id;
  const now = new Date().toISOString();

  if (input.removed === false) {
    const removed = await readOwnedNode(db, id, owner, true);
    if (!removed || removed.removed_at === null)
      throw new ApiError("NOT_FOUND");
    try {
      const result = await db
        .prepare(
          "UPDATE content_nodes SET removed_at=NULL, updated_at=? WHERE id=? AND owner_id=? AND removed_at IS NOT NULL",
        )
        .bind(now, id, owner)
        .run();
      if (result.meta.changes === 0) throw new ApiError("NOT_FOUND");
    } catch (error) {
      if (isLiveTimelineConflict(error)) throw new ApiError("CONFLICT");
      throw error;
    }
    const restored = await readOwnedNode(db, id, owner);
    if (!restored) throw new ApiError("NOT_FOUND");
    return context.json({ node: publicNodePayload(restored) });
  }

  const existing = await readOwnedNode(db, id, owner);
  if (!existing) throw new ApiError("NOT_FOUND");
  if (input.title !== undefined && existing.kind !== "external") {
    throw new ApiError("INVALID_REQUEST");
  }

  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  if (input.title !== undefined) {
    assignments.push("title=?");
    values.push(input.title);
  }
  if (input.visibility !== undefined) {
    assignments.push("visibility=?");
    values.push(input.visibility);
  }
  assignments.push("updated_at=?");
  values.push(now, id, owner);
  const updated = await db
    .prepare(
      "UPDATE content_nodes SET " +
        assignments.join(", ") +
        " WHERE id=? AND owner_id=? AND removed_at IS NULL",
    )
    .bind(...values)
    .run();
  if (updated.meta.changes === 0) throw new ApiError("NOT_FOUND");

  const row = await readOwnedNode(db, id, owner);
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({ node: publicNodePayload(row) });
});

contentNodes.delete("/:id", async (context) => {
  const id = context.req.param("id");
  const owner = context.get("user").id;
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(
    "UPDATE content_nodes SET removed_at=?, updated_at=? WHERE id=? AND owner_id=? AND removed_at IS NULL",
  )
    .bind(now, now, id, owner)
    .run();
  if (result.meta.changes === 0) throw new ApiError("NOT_FOUND");
  const row = await readOwnedNode(context.env.DB, id, owner, true);
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({ node: publicNodePayload(row) });
});
