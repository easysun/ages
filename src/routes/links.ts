import { Hono } from "hono";
import { encodeCursor, libraryQuery } from "../assets/library";
import { appOrigin, assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";
import {
  createLinkSchema,
  type Link,
  linkPayload,
  linkUrlSchema,
  updateLinkSchema,
} from "../links/model";

export const links = new Hono<AppContext>();
links.use("*", requireUser, async (context, next) => {
  context.header("Cache-Control", "private, no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method))
    assertSameOrigin(context);
  await next();
});
links.post("/", async (context) => {
  const input = await parseJson(context, createLinkSchema);
  const owner = context.get("user").id;
  const slug =
    input.slug ?? crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const now = new Date().toISOString();
  const target = input.target;
  const db = context.env.DB;
  if (
    target.kind === "timeline" &&
    !(await db
      .prepare(
        "SELECT id FROM timelines WHERE id = ? AND owner_id = ? AND visibility IN ('public', 'unlisted')",
      )
      .bind(target.timeline_id, owner)
      .first())
  )
    throw new ApiError("CONFLICT");
  let row: Link | null;
  try {
    row = await db
      .prepare(`INSERT INTO links (id, owner_id, slug, target_kind, target_url, timeline_id, expires_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? FROM usage_quotas q WHERE user_id = ?
      AND (SELECT count(*) FROM links WHERE owner_id = q.user_id) < link_limit
      AND (? IS NULL OR EXISTS (SELECT 1 FROM timelines WHERE id = ? AND owner_id = q.user_id AND visibility IN ('public', 'unlisted')))
      RETURNING *`)
      .bind(
        `ln_${crypto.randomUUID()}`,
        owner,
        slug,
        target.kind,
        target.kind === "url" ? target.url : null,
        target.kind === "timeline" ? target.timeline_id : null,
        input.expires_at,
        now,
        now,
        owner,
        target.kind === "timeline" ? target.timeline_id : null,
        target.kind === "timeline" ? target.timeline_id : null,
      )
      .first<Link>();
  } catch (failure) {
    if (
      failure instanceof Error &&
      failure.message.includes("UNIQUE constraint failed: links.slug")
    )
      throw new ApiError("CONFLICT");
    throw failure;
  }
  if (!row) {
    const quota = await db
      .prepare(
        "SELECT link_limit, (SELECT count(*) FROM links WHERE owner_id = ?) AS count FROM usage_quotas WHERE user_id = ?",
      )
      .bind(owner, owner)
      .first<{ link_limit: number; count: number }>();
    throw new ApiError(
      !quota || quota.count >= quota.link_limit
        ? "LINK_QUOTA_EXCEEDED"
        : "CONFLICT",
    );
  }
  return context.json({ link: linkPayload(row) }, 201);
});
links.get("/", async (context) => {
  const owner = context.get("user").id;
  // Reuse the strict owner-bound keyset contract; Links have no tag filter.
  const url = new URL(context.req.url);
  if (url.searchParams.has("tag")) throw new ApiError("INVALID_REQUEST");
  const encoded = url.searchParams.get("cursor");
  if (encoded !== null) {
    if (!encoded.startsWith("links.")) throw new ApiError("INVALID_REQUEST");
    if (url.searchParams.getAll("cursor").length !== 1)
      throw new ApiError("INVALID_REQUEST");
    url.searchParams.set("cursor", encoded.slice(6));
  }
  const { limit, cursor } = libraryQuery(url.href, owner);
  const result =
    await context.env.DB.prepare(`SELECT * FROM links WHERE owner_id = ?
    ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(
        owner,
        ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
        limit + 1,
      )
      .all<Link>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return context.json({
    links: rows.map(linkPayload),
    next_cursor:
      result.results.length > limit && last
        ? `links.${encodeCursor({
            v: 1,
            owner,
            tag: null,
            created_at: last.created_at,
            id: last.id,
          })}`
        : null,
  });
});
links.get("/:id", async (context) => {
  const row = await context.env.DB.prepare(
    "SELECT * FROM links WHERE id = ? AND owner_id = ?",
  )
    .bind(context.req.param("id"), context.get("user").id)
    .first<Link>();
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({ link: linkPayload(row) });
});
links.patch("/:id", async (context) => {
  const input = await parseJson(context, updateLinkSchema);
  const row =
    await context.env.DB.prepare(`UPDATE links SET active = CASE WHEN ? THEN ? ELSE active END,
    expires_at = CASE WHEN ? THEN ? ELSE expires_at END, updated_at = ? WHERE id = ? AND owner_id = ? RETURNING *`)
      .bind(
        Number(input.active !== undefined),
        Number(input.active),
        Number(input.expires_at !== undefined),
        input.expires_at ?? null,
        new Date().toISOString(),
        context.req.param("id"),
        context.get("user").id,
      )
      .first<Link>();
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({ link: linkPayload(row) });
});

export const linkResolver = new Hono<AppContext>();
linkResolver.on(["GET", "HEAD"], "/:slug", async (context) => {
  const row = await context.env.DB.prepare(
    "SELECT * FROM links WHERE slug = ? AND active = 1",
  )
    .bind(context.req.param("slug"))
    .first<Link>();
  const expiration =
    row?.expires_at === null ? null : new Date(row?.expires_at ?? "").getTime();
  if (
    !row ||
    (expiration !== null &&
      (!Number.isFinite(expiration) || expiration <= Date.now()))
  )
    throw new ApiError("NOT_FOUND");
  let target = row.target_url;
  if (row.target_kind === "timeline") {
    const visible = await context.env.DB.prepare(
      "SELECT id FROM timelines WHERE id = ? AND owner_id = ? AND visibility IN ('public', 'unlisted')",
    )
      .bind(row.timeline_id, row.owner_id)
      .first();
    if (!visible) throw new ApiError("NOT_FOUND");
    target = new URL(
      `/t/${encodeURIComponent(row.timeline_id ?? "")}`,
      appOrigin(context.env),
    ).href;
  }
  const destination = linkUrlSchema.safeParse(target);
  if (!destination.success) throw new ApiError("NOT_FOUND");
  return context.redirect(destination.data, 302);
});
