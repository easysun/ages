import { Hono } from "hono";
import { encodeCursor, libraryQuery } from "../assets/library";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { contentEdgeModerationSchema } from "../graph/edges";
import { contentNodeModerationSchema } from "../graph/nodes";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";
import {
  moderationSchema,
  moderationTables,
  reportSchema,
} from "../moderation/model";
import { createReport } from "../moderation/reports";

export const reports = new Hono<AppContext>();
reports.use("*", requireUser, async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});
reports.post("/", async (context) =>
  createReport(context, await parseJson(context, reportSchema)),
);

export const administration = new Hono<AppContext>();
administration.use("*", async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  await next();
});
administration.use("*", requireUser, async (context, next) => {
  if (context.get("user").plan !== "admin") throw new ApiError("FORBIDDEN");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});
administration.get("/content-nodes/:id", async (context) => {
  const operator = context.get("user").id;
  const id = context.req.param("id");
  const result = await context.env.DB.batch([
    context.env.DB.prepare(
      "SELECT moderation_blocked FROM content_nodes WHERE id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')",
    ).bind(id, operator),
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(operator),
  ]);
  if ((result[1]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const row = result[0]?.results[0] as
    | { moderation_blocked: number }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    moderation: { node_id: id, blocked: row.moderation_blocked === 1 },
  });
});
administration.get("/content-edges/:id", async (context) => {
  const operator = context.get("user").id;
  const id = context.req.param("id");
  const result = await context.env.DB.batch([
    context.env.DB.prepare(`SELECT admin_blocked FROM content_edges
      WHERE id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      id,
      operator,
    ),
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(operator),
  ]);
  if ((result[1]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const row = result[0]?.results[0] as { admin_blocked: number } | undefined;
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    moderation: { edge_id: id, blocked: row.admin_blocked === 1 },
  });
});
administration.patch("/content-nodes/:id", async (context) => {
  const input = await parseJson(context, contentNodeModerationSchema);
  const operator = context.get("user").id;
  const id = context.req.param("id");
  const action = `cne_${crypto.randomUUID()}`;
  const blocked = Number(input.blocked);
  const stamp = new Date().toISOString();
  const result = await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO content_node_moderation_events
      (id, moderator_id, node_id, previous_blocked, blocked, reason, created_at)
      SELECT ?, ?, id, moderation_blocked, ?, ?, ? FROM content_nodes
      WHERE id=? AND moderation_blocked != ?
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      action,
      operator,
      blocked,
      input.reason,
      stamp,
      id,
      blocked,
      operator,
    ),
    context.env.DB.prepare(`UPDATE content_nodes SET moderation_blocked=?, updated_at=?
      WHERE id=? AND moderation_blocked != ?
        AND EXISTS(SELECT 1 FROM content_node_moderation_events
          WHERE id=? AND moderator_id=? AND node_id=? AND blocked=?)
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      blocked,
      stamp,
      id,
      blocked,
      action,
      operator,
      id,
      blocked,
      operator,
    ),
    context.env.DB.prepare(`SELECT moderation_blocked FROM content_nodes WHERE id=?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      id,
      operator,
    ),
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(operator),
  ]);
  if ((result[3]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const row = result[2]?.results[0] as
    | { moderation_blocked: number }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    moderation: { node_id: id, blocked: row.moderation_blocked === 1 },
  });
});
administration.get("/reports", async (context) => {
  const owner = context.get("user").id;
  const url = new URL(context.req.url);
  if (url.searchParams.has("tag")) throw new ApiError("INVALID_REQUEST");
  const encoded = url.searchParams.get("cursor");
  if (encoded !== null) {
    if (
      !encoded.startsWith("admin-reports.") ||
      url.searchParams.getAll("cursor").length !== 1
    )
      throw new ApiError("INVALID_REQUEST");
    url.searchParams.set("cursor", encoded.slice("admin-reports.".length));
  }
  const { limit, cursor } = libraryQuery(url.href, owner);
  const result = await context.env.DB.batch([
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(owner),
    context.env.DB.prepare(`SELECT r.*,l.target_kind AS subject_kind,l.asset_id,l.timeline_id FROM report_events r
      LEFT JOIN distribution_links l ON r.target_kind='link' AND l.id=r.target_id
      WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')
      ${cursor ? "AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))" : ""}
      ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).bind(
      owner,
      ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
      limit + 1,
    ),
  ]);
  if ((result[0]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const found = (result[1]?.results ?? []) as {
    id: string;
    target_kind: string;
    target_id: string;
    category: string;
    detail: string;
    reporter_id: string;
    created_at: string;
    observed_timeline_version: number | null;
    subject_kind: string | null;
    asset_id: string | null;
    timeline_id: string | null;
  }[];
  const rows = found.slice(0, limit);
  const last = rows.at(-1);
  return context.json({
    next_cursor:
      found.length > limit && last
        ? `admin-reports.${encodeCursor({ v: 1, owner, tag: null, created_at: last.created_at, id: last.id })}`
        : null,
    reports: rows.map((row) => ({
      id: row.id,
      target: { kind: row.target_kind, id: row.target_id },
      category: row.category,
      detail: row.detail,
      reporter_id: row.reporter_id,
      created_at: row.created_at,
      observed_timeline_version: row.observed_timeline_version,
      ...(row.subject_kind === "asset"
        ? { subject: { kind: "asset", id: row.asset_id } }
        : row.subject_kind === "timeline"
          ? { subject: { kind: "timeline", id: row.timeline_id } }
          : {}),
    })),
  });
});
administration.get("/content-edge-reports", async (context) => {
  const owner = context.get("user").id;
  const url = new URL(context.req.url);
  if (url.searchParams.has("tag")) throw new ApiError("INVALID_REQUEST");
  const encoded = url.searchParams.get("cursor");
  if (encoded !== null) {
    if (
      !encoded.startsWith("edge-reports.") ||
      url.searchParams.getAll("cursor").length !== 1
    )
      throw new ApiError("INVALID_REQUEST");
    url.searchParams.set("cursor", encoded.slice("edge-reports.".length));
  }
  const { limit, cursor } = libraryQuery(url.href, owner);
  const result = await context.env.DB.batch([
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(owner),
    context.env.DB.prepare(`SELECT r.id,r.edge_id,r.category,r.detail,r.reporter_id,r.created_at,
        e.source_id,e.target_id,e.type FROM content_edge_reports r
      JOIN content_edges e ON e.id=r.edge_id
      WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')
      ${cursor ? "AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))" : ""}
      ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).bind(
      owner,
      ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
      limit + 1,
    ),
  ]);
  if ((result[0]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const found = (result[1]?.results ?? []) as {
    id: string;
    edge_id: string;
    category: string;
    detail: string;
    reporter_id: string;
    created_at: string;
    source_id: string;
    target_id: string;
    type: string;
  }[];
  const rows = found.slice(0, limit);
  const last = rows.at(-1);
  return context.json({
    next_cursor:
      found.length > limit && last
        ? `edge-reports.${encodeCursor({
            v: 1,
            owner,
            tag: null,
            created_at: last.created_at,
            id: last.id,
          })}`
        : null,
    reports: rows.map((row) => ({
      id: row.id,
      edge_id: row.edge_id,
      category: row.category,
      detail: row.detail,
      reporter_id: row.reporter_id,
      created_at: row.created_at,
      source_id: row.source_id,
      target_id: row.target_id,
      type: row.type,
    })),
  });
});
administration.patch("/content-edges/:id", async (context) => {
  const input = await parseJson(context, contentEdgeModerationSchema);
  const operator = context.get("user").id;
  const id = context.req.param("id");
  const action = `cem_${crypto.randomUUID()}`;
  const blocked = Number(input.blocked);
  const stamp = new Date().toISOString();
  const result = await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO content_edge_moderation_events
      (id,moderator_id,edge_id,previous_blocked,blocked,reason,created_at)
      SELECT ?,?,id,admin_blocked,?,?,? FROM content_edges
      WHERE id=? AND admin_blocked != ?
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      action,
      operator,
      blocked,
      input.reason,
      stamp,
      id,
      blocked,
      operator,
    ),
    context.env.DB.prepare(`UPDATE content_edges SET admin_blocked=?
      WHERE id=? AND admin_blocked != ?
        AND EXISTS(SELECT 1 FROM content_edge_moderation_events
          WHERE id=? AND moderator_id=? AND edge_id=? AND blocked=?)
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      blocked,
      id,
      blocked,
      action,
      operator,
      id,
      blocked,
      operator,
    ),
    context.env.DB.prepare(`SELECT admin_blocked FROM content_edges WHERE id=?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      id,
      operator,
    ),
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(operator),
  ]);
  if ((result[3]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const row = result[2]?.results[0] as { admin_blocked: number } | undefined;
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    moderation: { edge_id: id, blocked: row.admin_blocked === 1 },
  });
});
administration.get("/content", async (context) => {
  const query = new URL(context.req.url).searchParams;
  if (
    [...query.keys()].some((key) => key !== "kind" && key !== "id") ||
    query.getAll("kind").length !== 1 ||
    query.getAll("id").length !== 1
  )
    throw new ApiError("INVALID_REQUEST");
  const parsed = moderationSchema.shape.target.safeParse({
    kind: query.get("kind"),
    id: query.get("id"),
  });
  if (!parsed.success) throw new ApiError("INVALID_REQUEST");
  const target = parsed.data;
  const owner = context.get("user").id;
  const result = await context.env.DB.batch([
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(owner),
    context.env.DB.prepare(`SELECT moderation_blocked FROM ${moderationTables[target.kind]}
      WHERE id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      target.id,
      owner,
    ),
  ]);
  if ((result[0]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const row = result[1]?.results[0] as
    | { moderation_blocked: number }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    moderation: { target, blocked: row.moderation_blocked === 1 },
  });
});
administration.put("/content", async (context) => {
  const input = await parseJson(context, moderationSchema);
  const owner = context.get("user").id;
  const table = moderationTables[input.target.kind];
  const action = `ma_${crypto.randomUUID()}`;
  const blocked = Number(input.blocked);
  const stamp = new Date().toISOString();
  const timelineUpdate =
    input.target.kind === "timeline"
      ? ", version=version+1, last_mutation_token=?, updated_at=?"
      : "";
  const result = await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO moderation_audit(id,moderator_id,target_kind,target_id,previous_blocked,blocked,reason,created_at)
      SELECT ?,?,?,id,moderation_blocked,?,?,? FROM ${table} WHERE id=? AND moderation_blocked != ?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      action,
      owner,
      input.target.kind,
      blocked,
      input.reason,
      stamp,
      input.target.id,
      blocked,
      owner,
    ),
    context.env.DB.prepare(`UPDATE ${table} SET moderation_blocked=?${timelineUpdate} WHERE id=?
      AND EXISTS(SELECT 1 FROM moderation_audit WHERE id=? AND moderator_id=? AND target_kind=? AND target_id=?)
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      blocked,
      ...(input.target.kind === "timeline" ? [action, stamp] : []),
      input.target.id,
      action,
      owner,
      input.target.kind,
      input.target.id,
      owner,
    ),
    context.env.DB.prepare(
      `SELECT moderation_blocked FROM ${table} WHERE id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`,
    ).bind(input.target.id, owner),
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(owner),
  ]);
  if ((result[3]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  const row = result[2]?.results[0] as
    | { moderation_blocked: number }
    | undefined;
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    moderation: { target: input.target, blocked: row.moderation_blocked === 1 },
  });
});
