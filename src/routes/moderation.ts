import { Hono } from "hono";
import { assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
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
administration.use("*", requireUser, async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  if (context.get("user").plan !== "admin") throw new ApiError("FORBIDDEN");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});
administration.get("/reports", async (context) => {
  const query = new URL(context.req.url).searchParams;
  const value = query.get("limit");
  if (
    [...query.keys()].some((key) => key !== "limit") ||
    query.getAll("limit").length > 1 ||
    (value !== null && !/^[1-9]\d*$/.test(value))
  )
    throw new ApiError("INVALID_REQUEST");
  const limit = value === null ? 30 : Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100)
    throw new ApiError("INVALID_REQUEST");
  const owner = context.get("user").id;
  const result = await context.env.DB.batch([
    context.env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(owner),
    context.env.DB.prepare(`SELECT r.*,l.target_kind AS subject_kind,l.asset_id,l.timeline_id FROM content_reports r
      LEFT JOIN distribution_links l ON r.target_kind='link' AND l.id=r.target_id
      WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin') ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).bind(
      owner,
      limit,
    ),
  ]);
  if ((result[0]?.results[0] as { plan: string } | undefined)?.plan !== "admin")
    throw new ApiError("FORBIDDEN");
  return context.json({
    reports: (
      (result[1]?.results ?? []) as {
        id: string;
        target_kind: string;
        target_id: string;
        category: string;
        detail: string;
        reporter_id: string;
        created_at: string;
        subject_kind: string | null;
        asset_id: string | null;
        timeline_id: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      target: { kind: row.target_kind, id: row.target_id },
      category: row.category,
      detail: row.detail,
      reporter_id: row.reporter_id,
      created_at: row.created_at,
      ...(row.subject_kind === "asset"
        ? { subject: { kind: "asset", id: row.asset_id } }
        : row.subject_kind === "timeline"
          ? { subject: { kind: "timeline", id: row.timeline_id } }
          : {}),
    })),
  });
});
administration.put("/content", async (context) => {
  const input = await parseJson(context, moderationSchema);
  const owner = context.get("user").id;
  const table = moderationTables[input.target.kind];
  const action = `ma_${crypto.randomUUID()}`;
  const blocked = Number(input.blocked);
  const result = await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO moderation_audit(id,moderator_id,target_kind,target_id,previous_blocked,blocked,reason,created_at)
      SELECT ?,?,?,id,moderation_blocked,?,?,? FROM ${table} WHERE id=? AND moderation_blocked != ?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      action,
      owner,
      input.target.kind,
      blocked,
      input.reason,
      new Date().toISOString(),
      input.target.id,
      blocked,
      owner,
    ),
    context.env.DB.prepare(`UPDATE ${table} SET moderation_blocked=? WHERE id=?
      AND EXISTS(SELECT 1 FROM moderation_audit WHERE id=? AND moderator_id=? AND target_kind=? AND target_id=?)
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND plan='admin')`).bind(
      blocked,
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
