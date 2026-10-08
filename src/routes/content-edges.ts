import { Hono } from "hono";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import {
  type ContentEdge,
  contentEdgeActionSchema,
  contentEdgeReportSchema,
  createContentEdgeSchema,
} from "../graph/edges";
import { effectiveNode } from "../graph/nodes";
import { ApiError, errorResponse } from "../http/errors";
import { parseJson } from "../http/json";

export const contentEdges = new Hono<AppContext>();

type ContentEdgeRow = Omit<ContentEdge, "admin_blocked"> & {
  admin_blocked: number;
};

contentEdges.use("*", requireUser, async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});

function ownerEdgePayload(edge: ContentEdgeRow) {
  return {
    id: edge.id,
    source_id: edge.source_id,
    target_id: edge.target_id,
    type: edge.type,
    accepted_at: edge.accepted_at,
    suppressed_at: edge.suppressed_at,
    target_owner_blocked_at: edge.target_owner_blocked_at,
    admin_blocked: edge.admin_blocked === 1,
    removed_at: edge.removed_at,
    created_at: edge.created_at,
  };
}

function isLiveTripleConflict(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes(
      "UNIQUE constraint failed: content_edges.source_id, content_edges.target_id, content_edges.type",
    )
  );
}

contentEdges.post("/", async (context) => {
  const input = await parseJson(context, createContentEdgeSchema);
  if (input.source_id === input.target_id)
    throw new ApiError("INVALID_REQUEST");

  const owner = context.get("user").id;
  const db = context.env.DB;
  const [source, target] = await Promise.all([
    effectiveNode(db, input.source_id, owner),
    effectiveNode(db, input.target_id, owner),
  ]);
  if (!source || source.node.owner_id !== owner || !target)
    throw new ApiError("NOT_FOUND");
  if (
    source.node.owner_id !== target.node.owner_id &&
    (source.visibility === "private" || target.visibility === "private")
  )
    throw new ApiError("NOT_FOUND");

  const now = new Date().toISOString();
  const id = `ce_${crypto.randomUUID()}`;
  try {
    await db
      .prepare(`INSERT INTO content_edges
        (id,source_id,target_id,type,creator_id,created_at)
        VALUES (?,?,?,?,?,?)`)
      .bind(id, input.source_id, input.target_id, input.type, owner, now)
      .run();
  } catch (error) {
    if (isLiveTripleConflict(error)) throw new ApiError("CONFLICT");
    throw error;
  }
  const edge = await db
    .prepare("SELECT * FROM content_edges WHERE id=?")
    .bind(id)
    .first<ContentEdgeRow>();
  if (!edge) throw new ApiError("NOT_FOUND");
  return context.json({ edge: ownerEdgePayload(edge) }, 201);
});

contentEdges.patch("/:id", async (context) => {
  const input = await parseJson(context, contentEdgeActionSchema);
  const owner = context.get("user").id;
  const id = context.req.param("id");
  const stamp = new Date().toISOString();
  const update = {
    accept: "accepted_at=COALESCE(accepted_at, ?)",
    suppress: "suppressed_at=COALESCE(suppressed_at, ?)",
    unsuppress: "suppressed_at=NULL",
    block: "target_owner_blocked_at=COALESCE(target_owner_blocked_at, ?)",
    unblock: "target_owner_blocked_at=NULL",
  }[input.action];
  const values = ["accept", "suppress", "block"].includes(input.action)
    ? [stamp]
    : [];
  await context.env.DB.prepare(`UPDATE content_edges SET ${update}
      WHERE id=? AND removed_at IS NULL AND EXISTS (
        SELECT 1 FROM content_nodes target
        WHERE target.id=content_edges.target_id AND target.owner_id=?
      )`)
    .bind(...values, id, owner)
    .run();

  const edge = await context.env.DB.prepare(`SELECT e.* FROM content_edges e
      JOIN content_nodes target ON target.id=e.target_id
      WHERE e.id=? AND target.owner_id=? AND e.removed_at IS NULL`)
    .bind(id, owner)
    .first<ContentEdgeRow>();
  if (!edge) throw new ApiError("NOT_FOUND");
  return context.json({ edge: ownerEdgePayload(edge) });
});

contentEdges.delete("/:id", async (context) => {
  const owner = context.get("user").id;
  const id = context.req.param("id");
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(`UPDATE content_edges
      SET removed_at=? WHERE id=? AND creator_id=? AND removed_at IS NULL`)
    .bind(now, id, owner)
    .run();
  if (result.meta.changes === 0) throw new ApiError("NOT_FOUND");
  return context.json({ removed: true });
});

contentEdges.post("/:id/reports", async (context) => {
  const input = await parseJson(context, contentEdgeReportSchema);
  const reporter = context.get("user").id;
  const edgeId = context.req.param("id");
  const now = new Date();
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const db = context.env.DB;
  const eligible = `SELECT e.id FROM content_edges e
    JOIN content_nodes target ON target.id=e.target_id
    WHERE e.id=? AND target.owner_id=? AND e.removed_at IS NULL`;
  const result = await db.batch([
    db
      .prepare(`WITH subject AS (${eligible})
      INSERT INTO content_edge_reports(id,reporter_id,edge_id,category,detail,created_at)
      SELECT ?,?,subject.id,?,?,? FROM subject
      WHERE (SELECT count(*) FROM report_events WHERE reporter_id=? AND created_at>?)
        + (SELECT count(*) FROM content_edge_reports WHERE reporter_id=? AND created_at>?) < 20
        AND NOT EXISTS (SELECT 1 FROM content_edge_reports r
          WHERE r.reporter_id=? AND r.edge_id=subject.id AND r.created_at>?)
      RETURNING id`)
      .bind(
        edgeId,
        reporter,
        `cer_${crypto.randomUUID()}`,
        reporter,
        input.category,
        input.detail,
        stamp,
        reporter,
        cutoff,
        reporter,
        cutoff,
        reporter,
        cutoff,
      ),
    db
      .prepare(`WITH subject AS (${eligible})
      SELECT r.id FROM content_edge_reports r,subject
      WHERE r.reporter_id=? AND r.edge_id=subject.id AND r.created_at>?
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`)
      .bind(edgeId, reporter, reporter, cutoff),
    db.prepare(`SELECT EXISTS(${eligible}) AS eligible`).bind(edgeId, reporter),
    db
      .prepare(`SELECT min(created_at) AS oldest FROM (
      SELECT created_at FROM report_events WHERE reporter_id=? AND created_at>?
      UNION ALL
      SELECT created_at FROM content_edge_reports WHERE reporter_id=? AND created_at>?
    )`)
      .bind(reporter, cutoff, reporter, cutoff),
  ]);

  const report = (result[0]?.results[0] ?? result[1]?.results[0]) as
    | { id: string }
    | undefined;
  if (report)
    return context.json(
      { report: { id: report.id, status: "received" } },
      result[0]?.results.length ? 201 : 200,
    );
  if (!(result[2]?.results[0] as { eligible: number } | undefined)?.eligible)
    throw new ApiError("NOT_FOUND");

  const oldest = (
    result[3]?.results[0] as { oldest: string | null } | undefined
  )?.oldest;
  const retry = oldest
    ? Date.parse(oldest) + 24 * 60 * 60 * 1000 - now.getTime()
    : 60_000;
  context.header("Retry-After", String(Math.max(1, Math.ceil(retry / 1000))));
  return errorResponse(context, "RATE_LIMITED");
});
