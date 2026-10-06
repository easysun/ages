import { type Context, Hono } from "hono";
import { encodeCursor, libraryQuery } from "../assets/library";
import type { Asset } from "../assets/model";
import { appOrigin, assertSameOrigin } from "../auth/config";
import { requireUser } from "../auth/session";
import type { AppContext } from "../bindings";
import { ApiError } from "../http/errors";
import { parseJson } from "../http/json";
import { clickSource, recordLinkClick } from "../links/analytics";
import {
  createLinkSchema,
  type Link,
  linkPayload,
  linkTrackingProvidersSchema,
  linkUrlSchema,
  updateLinkSchema,
} from "../links/model";
import { applyLinkParameters, getLinkTracking } from "../links/tracking";
import { streamAssetMedia } from "../media/stream";
import { publicLinkSql, visibleTimelineSql } from "../moderation/availability";
import { appTrackingOrigin } from "../tracking/config";
import { resolveLinkProviders } from "../tracking/providers";
import {
  consumeTrackingTicket,
  createTrackingTicket,
} from "../tracking/tickets";

export const links = new Hono<AppContext>();
links.use("*", requireUser, async (context, next) => {
  appOrigin(context.env);
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
  if (
    target.kind === "asset" &&
    !(await db
      .prepare(
        "SELECT id FROM assets WHERE id = ? AND owner_id = ? AND status = 'ready' AND deleted_at IS NULL",
      )
      .bind(target.asset_id, owner)
      .first())
  )
    throw new ApiError("CONFLICT");
  let row: Link | null;
  try {
    row = await db
      .prepare(`INSERT INTO distribution_links (id, owner_id, slug, target_kind, target_url, timeline_id, asset_id, expires_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM usage_quotas q WHERE user_id = ?
      AND (SELECT count(*) FROM distribution_links WHERE owner_id = q.user_id) < link_limit
      AND (? IS NULL OR EXISTS (SELECT 1 FROM timelines WHERE id = ? AND owner_id = q.user_id AND visibility IN ('public', 'unlisted')))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM assets WHERE id = ? AND owner_id = q.user_id AND status = 'ready' AND deleted_at IS NULL))
      RETURNING *`)
      .bind(
        `ln_${crypto.randomUUID()}`,
        owner,
        slug,
        target.kind,
        target.kind === "url" ? target.url : null,
        target.kind === "timeline" ? target.timeline_id : null,
        target.kind === "asset" ? target.asset_id : null,
        input.expires_at,
        now,
        now,
        owner,
        target.kind === "timeline" ? target.timeline_id : null,
        target.kind === "timeline" ? target.timeline_id : null,
        target.kind === "asset" ? target.asset_id : null,
        target.kind === "asset" ? target.asset_id : null,
      )
      .first<Link>();
  } catch (failure) {
    if (
      failure instanceof Error &&
      (failure.message.includes(
        "UNIQUE constraint failed: distribution_links.slug",
      ) ||
        failure.message.includes(
          "UNIQUE constraint failed: reserved_link_slugs.slug",
        ) ||
        failure.message.includes("invalid_link_asset"))
    )
      throw new ApiError("CONFLICT");
    throw failure;
  }
  if (!row) {
    const quota = await db
      .prepare(
        "SELECT link_limit, (SELECT count(*) FROM distribution_links WHERE owner_id = ?) AS count FROM usage_quotas WHERE user_id = ?",
      )
      .bind(owner, owner)
      .first<{ link_limit: number; count: number }>();
    throw new ApiError(
      !quota || quota.count >= quota.link_limit
        ? "LINK_QUOTA_EXCEEDED"
        : "CONFLICT",
    );
  }
  return context.json({ link: linkPayload(row, appOrigin(context.env)) }, 201);
});
links.get("/", async (context) => {
  const owner = context.get("user").id;
  const url = new URL(context.req.url);
  const encoded = url.searchParams.get("cursor");
  if (encoded !== null) {
    if (!encoded.startsWith("links.")) throw new ApiError("INVALID_REQUEST");
    if (url.searchParams.getAll("cursor").length !== 1)
      throw new ApiError("INVALID_REQUEST");
    url.searchParams.set("cursor", encoded.slice(6));
  }
  const { limit, tag, cursor } = libraryQuery(url.href, owner);
  const clauses = ["owner_id = ?"];
  const values: (string | number)[] = [owner];
  if (tag !== null) {
    clauses.push(
      "EXISTS (SELECT 1 FROM link_tags t WHERE t.link_id = distribution_links.id AND t.owner_id = distribution_links.owner_id AND t.tag = ?)",
    );
    values.push(tag);
  }
  if (cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
    values.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const result = await context.env.DB.prepare(`SELECT * FROM distribution_links
    WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...values, limit + 1)
    .all<Link>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return context.json({
    links: rows.map((row) => linkPayload(row, appOrigin(context.env))),
    next_cursor:
      result.results.length > limit && last
        ? `links.${encodeCursor({
            v: 1,
            owner,
            tag,
            created_at: last.created_at,
            id: last.id,
          })}`
        : null,
  });
});
links.get("/:id", async (context) => {
  const row = await context.env.DB.prepare(
    "SELECT * FROM distribution_links WHERE id = ? AND owner_id = ?",
  )
    .bind(context.req.param("id"), context.get("user").id)
    .first<Link>();
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({ link: linkPayload(row, appOrigin(context.env)) });
});
links.get("/:id/tracking/providers", async (context) => {
  const row = await context.env.DB.prepare(`SELECT allow_ga4, allow_meta_pixel,
    allow_gtm FROM distribution_links WHERE id = ? AND owner_id = ?`)
    .bind(context.req.param("id"), context.get("user").id)
    .first<{
      allow_ga4: number;
      allow_meta_pixel: number;
      allow_gtm: number;
    }>();
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    providers: {
      allow_ga4: row.allow_ga4 === 1,
      allow_meta_pixel: row.allow_meta_pixel === 1,
      allow_gtm: row.allow_gtm === 1,
    },
  });
});
links.put("/:id/tracking/providers", async (context) => {
  const input = await parseJson(context, linkTrackingProvidersSchema);
  const row = await context.env.DB.prepare(`UPDATE distribution_links SET
    allow_ga4 = ?, allow_meta_pixel = ?, allow_gtm = ?, updated_at = ?
    WHERE id = ? AND owner_id = ?
    RETURNING allow_ga4, allow_meta_pixel, allow_gtm`)
    .bind(
      Number(input.allow_ga4),
      Number(input.allow_meta_pixel),
      Number(input.allow_gtm),
      new Date().toISOString(),
      context.req.param("id"),
      context.get("user").id,
    )
    .first<{
      allow_ga4: number;
      allow_meta_pixel: number;
      allow_gtm: number;
    }>();
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({
    providers: {
      allow_ga4: row.allow_ga4 === 1,
      allow_meta_pixel: row.allow_meta_pixel === 1,
      allow_gtm: row.allow_gtm === 1,
    },
  });
});
links.patch("/:id", async (context) => {
  const input = await parseJson(context, updateLinkSchema);
  let row: Link | null;
  try {
    row =
      await context.env.DB.prepare(`UPDATE distribution_links SET active = CASE WHEN ? THEN ? ELSE active END,
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
  } catch (failure) {
    if (
      failure instanceof Error &&
      failure.message.includes("invalid_link_asset")
    )
      throw new ApiError("CONFLICT");
    throw failure;
  }
  if (!row) throw new ApiError("NOT_FOUND");
  return context.json({ link: linkPayload(row, appOrigin(context.env)) });
});

export const linkResolver = new Hono<AppContext>();
linkResolver.post("/continue", async (context) => {
  if (context.req.header("Origin") !== appTrackingOrigin(context.env))
    throw new ApiError("FORBIDDEN");
  if (
    context.req
      .header("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/x-www-form-urlencoded"
  )
    throw new ApiError("INVALID_REQUEST");

  const bodyBytes = await context.req.arrayBuffer();
  if (bodyBytes.byteLength > 4096) throw new ApiError("PAYLOAD_TOO_LARGE");
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bodyBytes,
    );
  } catch {
    throw new ApiError("INVALID_REQUEST");
  }
  const fields = [...new URLSearchParams(body)];
  if (
    fields.length !== 1 ||
    fields[0]?.[0] !== "token" ||
    !/^[0-9a-f]{64}$/.test(fields[0][1])
  )
    throw new ApiError("INVALID_REQUEST");

  const consumed = await consumeTrackingTicket(
    context.env.DB,
    fields[0][1],
    new Date(),
  );
  if (!consumed) throw new ApiError("NOT_FOUND");

  const now = new Date().toISOString();
  const row = await context.env.DB.prepare(
    `SELECT l.* FROM distribution_links l WHERE l.id = ? AND ${publicLinkSql}`,
  )
    .bind(consumed.linkId, now)
    .first<Link>();
  if (!row || row.target_kind !== consumed.targetKind)
    throw new ApiError("NOT_FOUND");

  const origin = appOrigin(context.env);
  let destination: string;
  if (row.target_kind === "url") {
    const validated = linkUrlSchema.safeParse(row.target_url);
    if (!validated.success) throw new ApiError("NOT_FOUND");
    const tracking = await getLinkTracking(context.env.DB, row.id);
    destination = applyLinkParameters(validated.data, tracking, origin);
    if (new URL(destination).origin !== origin) {
      context.header("Cache-Control", "no-store, max-age=0");
      context.header("Referrer-Policy", "no-referrer");
      context.header("X-Content-Type-Options", "nosniff");
      context.header("X-Robots-Tag", "noindex, nofollow");
      context.header(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      return context.html(renderExternalContinuation(destination));
    }
  } else if (row.target_kind === "timeline") {
    destination = new URL(
      `/t/${encodeURIComponent(row.timeline_id ?? "")}`,
      origin,
    ).href;
  } else {
    destination = new URL(`/s/${encodeURIComponent(row.slug)}/media`, origin)
      .href;
  }
  return context.redirect(destination, 302);
});

linkResolver.on(["GET", "HEAD"], "/:slug", async (context) => {
  context.header("Cache-Control", "private, no-store");
  const row = await context.env.DB.prepare(
    "SELECT * FROM distribution_links WHERE slug = ? AND active = 1 AND moderation_blocked = 0",
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
  if (row.target_kind === "asset") {
    const grant = async () => {
      const current =
        await context.env.DB.prepare(`SELECT a.*, l.expires_at AS link_expires_at FROM assets a
        JOIN distribution_links l ON l.asset_id = a.id AND l.owner_id = a.owner_id
        WHERE l.id = ? AND l.slug = ? AND l.active = 1 AND l.moderation_blocked = 0 AND l.target_kind = 'asset'
          AND a.status = 'ready' AND a.deleted_at IS NULL AND a.moderation_blocked = 0`)
          .bind(row.id, row.slug)
          .first<Asset & { link_expires_at: string | null }>();
      const deadline =
        current?.link_expires_at === null
          ? null
          : Date.parse(current?.link_expires_at ?? "");
      if (
        !current ||
        (deadline !== null &&
          (!Number.isFinite(deadline) || deadline <= Date.now()))
      )
        throw new ApiError("NOT_FOUND");
      return current;
    };
    const asset = await grant();
    const tracking = await getLinkTracking(context.env.DB, row.id);
    const response = await streamAssetMedia(context, asset, async () => {
      const current = await grant();
      if (current.etag !== asset.etag || current.mime_type !== asset.mime_type)
        throw new ApiError("NOT_FOUND");
    });
    if (
      context.req.method === "GET" &&
      (response.status === 200 || response.status === 206)
    ) {
      const providers = await resolveLinkProviders(
        context.env.DB,
        row.id,
        row.owner_id,
      );
      if (
        providers.ga4 !== null ||
        providers.meta !== null ||
        providers.gtm !== null
      ) {
        try {
          const trackingOrigin = appTrackingOrigin(context.env);
          const ticket = await createTrackingTicket(
            context.env.DB,
            row,
            tracking,
            clickSource(context.req.raw, new Date(), tracking.channels),
            providers,
            new Date(),
          );
          await response.body?.cancel();
          clearMediaResponseHeaders(context);
          await recordLinkClick(
            context.env.DB,
            row,
            clickSource(context.req.raw, new Date(), tracking.channels),
          );
          context.header("Referrer-Policy", "no-referrer");
          return context.redirect(`${trackingOrigin}/${ticket.token}`, 302);
        } catch (error) {
          try {
            await response.body?.cancel();
          } catch {
            // Preserve the ticket, count, or availability error if cancellation fails.
          }
          clearMediaResponseHeaders(context);
          throw error;
        }
      }
      try {
        await recordLinkClick(
          context.env.DB,
          row,
          clickSource(context.req.raw, new Date(), tracking.channels),
        );
      } catch (error) {
        try {
          await response.body?.cancel();
        } catch {
          // Preserve the recording or availability error if stream cancellation fails.
        }
        context.header("Content-Length", undefined);
        context.header("Content-Range", undefined);
        context.header("Accept-Ranges", undefined);
        throw error;
      }
    }
    return response;
  }
  let target = row.target_url;
  if (row.target_kind === "timeline") {
    const visible = await context.env.DB.prepare(
      `SELECT t.id FROM timelines t WHERE t.id = ? AND t.owner_id = ? AND ${visibleTimelineSql}`,
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
  const tracking = await getLinkTracking(context.env.DB, row.id);
  const destinationUrl =
    row.target_kind === "url"
      ? applyLinkParameters(destination.data, tracking, appOrigin(context.env))
      : destination.data;
  if (context.req.method === "GET") {
    const providers = await resolveLinkProviders(
      context.env.DB,
      row.id,
      row.owner_id,
    );
    if (
      providers.ga4 !== null ||
      providers.meta !== null ||
      providers.gtm !== null
    ) {
      const trackingOrigin = appTrackingOrigin(context.env);
      const ticket = await createTrackingTicket(
        context.env.DB,
        row,
        tracking,
        clickSource(context.req.raw, new Date(), tracking.channels),
        providers,
        new Date(),
      );
      await recordLinkClick(
        context.env.DB,
        row,
        clickSource(context.req.raw, new Date(), tracking.channels),
      );
      context.header("Referrer-Policy", "no-referrer");
      return context.redirect(`${trackingOrigin}/${ticket.token}`, 302);
    }
    await recordLinkClick(
      context.env.DB,
      row,
      clickSource(context.req.raw, new Date(), tracking.channels),
    );
  }
  return context.redirect(destinationUrl, 302);
});

linkResolver.on(["GET", "HEAD"], "/:slug/media", async (context) => {
  const grant = async () =>
    context.env.DB.prepare(`SELECT a.* FROM assets a
      JOIN distribution_links l ON l.asset_id = a.id AND l.owner_id = a.owner_id
      WHERE l.slug = ? AND l.target_kind = 'asset' AND ${publicLinkSql}`)
      .bind(context.req.param("slug"), new Date().toISOString())
      .first<Asset>();
  const asset = await grant();
  if (!asset) throw new ApiError("NOT_FOUND");
  return streamAssetMedia(context, asset, async () => {
    const current = await grant();
    if (
      !current ||
      current.etag !== asset.etag ||
      current.mime_type !== asset.mime_type ||
      current.size_bytes !== asset.size_bytes ||
      current.r2_key !== asset.r2_key
    )
      throw new ApiError("NOT_FOUND");
  });
});

function clearMediaResponseHeaders(context: Context<AppContext>) {
  context.header("Content-Type", undefined);
  context.header("Content-Disposition", undefined);
  context.header("Content-Length", undefined);
  context.header("Content-Range", undefined);
  context.header("Accept-Ranges", undefined);
}

function renderExternalContinuation(destination: string) {
  const escaped = destination
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${escaped}"><title>Continue</title></head><body><p>Continue to the requested destination: <a href="${escaped}" rel="noreferrer">Continue</a></p></body></html>`;
}
