import type { Context } from "hono";
import type { AppContext } from "../bindings";
import { ApiError, errorResponse } from "../http/errors";
import { type Link, linkUrlSchema } from "../links/model";
import { publicLinkSql, visibleTimelineSql } from "./availability";
import type { ReportInput } from "./model";

export async function createReport(
  context: Context<AppContext>,
  input: ReportInput,
) {
  const db = context.env.DB;
  const now = new Date();
  const stamp = now.toISOString();
  const owner = context.get("user").id;
  const kind = input.target.kind;
  let id: string;
  if (input.target.kind === "timeline") {
    const subject = await db
      .prepare(
        `SELECT t.id FROM timelines t WHERE t.id=? AND ${visibleTimelineSql}`,
      )
      .bind(input.target.timeline_id)
      .first<{ id: string }>();
    if (!subject) throw new ApiError("NOT_FOUND");
    id = subject.id;
  } else {
    const subject = await db
      .prepare(
        `SELECT l.* FROM distribution_links l WHERE l.slug=? AND ${publicLinkSql}`,
      )
      .bind(input.target.slug, stamp)
      .first<Link>();
    if (
      !subject ||
      (subject.target_kind === "url" &&
        !linkUrlSchema.safeParse(subject.target_url).success)
    )
      throw new ApiError("NOT_FOUND");
    id = subject.id;
  }
  const eligible =
    kind === "timeline"
      ? `EXISTS(SELECT 1 FROM timelines t WHERE t.id=? AND ${visibleTimelineSql})`
      : `EXISTS(SELECT 1 FROM distribution_links l WHERE l.id=? AND ${publicLinkSql})`;
  const eligibilityValues = kind === "timeline" ? [id] : [id, stamp];
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const result = await db.batch([
    db
      .prepare(`INSERT INTO content_reports(id,reporter_id,target_kind,target_id,category,detail,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${eligible}
      AND (SELECT count(*) FROM content_reports WHERE reporter_id=? AND created_at>?) < 20
      ON CONFLICT(reporter_id,target_kind,target_id) DO NOTHING RETURNING id`)
      .bind(
        `rp_${crypto.randomUUID()}`,
        owner,
        kind,
        id,
        input.category,
        input.detail,
        stamp,
        ...eligibilityValues,
        owner,
        cutoff,
      ),
    db
      .prepare(
        `SELECT id FROM content_reports WHERE reporter_id=? AND target_kind=? AND target_id=? AND ${eligible}`,
      )
      .bind(owner, kind, id, ...eligibilityValues),
    db.prepare(`SELECT ${eligible} AS eligible`).bind(...eligibilityValues),
    db
      .prepare(
        "SELECT min(created_at) AS oldest FROM content_reports WHERE reporter_id=? AND created_at>?",
      )
      .bind(owner, cutoff),
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
}
