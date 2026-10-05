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

function taipeiDay(now: Date) {
  const parts = new Map(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value] as const),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function shiftDay(day: string, offset: number) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function validDay(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

function analyticsRange(url: URL) {
  const params = url.searchParams;
  const keys = [...params.keys()];
  const fromValues = params.getAll("from");
  const toValues = params.getAll("to");
  if (
    keys.some((key) => key !== "from" && key !== "to") ||
    fromValues.length > 1 ||
    toValues.length > 1
  )
    throw new ApiError("INVALID_REQUEST");

  const currentDay = taipeiDay(new Date());
  const to = toValues[0] ?? currentDay;
  if (!validDay(to)) throw new ApiError("INVALID_REQUEST");
  const from = fromValues[0] ?? shiftDay(to, -29);
  if (!validDay(from)) throw new ApiError("INVALID_REQUEST");

  const first = Date.parse(`${from}T00:00:00.000Z`);
  const last = Date.parse(`${to}T00:00:00.000Z`);
  const days = (last - first) / 86_400_000 + 1;
  if (days < 1 || days > 366) throw new ApiError("INVALID_REQUEST");
  return { from, to, first, days };
}

linkAnalytics.get("/:id/analytics", async (context) => {
  const linkId = context.req.param("id");
  const link = await context.env.DB.prepare(
    "SELECT id FROM distribution_links WHERE id = ? AND owner_id = ?",
  )
    .bind(linkId, context.get("user").id)
    .first();
  if (!link) throw new ApiError("NOT_FOUND");

  const {
    from,
    to,
    first,
    days: dayCount,
  } = analyticsRange(new URL(context.req.url));
  const [totals, channels, referrers] = await Promise.all([
    context.env.DB.prepare(`SELECT day, clicks FROM link_daily_totals
      WHERE link_id = ? AND day BETWEEN ? AND ? ORDER BY day`)
      .bind(linkId, from, to)
      .all<{ day: string; clicks: number }>(),
    context.env.DB.prepare(`SELECT bucket_kind, channel_label, sum(clicks) AS clicks
      FROM link_daily_channels WHERE link_id = ? AND day BETWEEN ? AND ?
      GROUP BY bucket_kind, channel_label
      ORDER BY CASE bucket_kind WHEN 'configured' THEN 0 ELSE 1 END, channel_label COLLATE BINARY`)
      .bind(linkId, from, to)
      .all<{
        bucket_kind: "configured" | "other";
        channel_label: string | null;
        clicks: number;
      }>(),
    context.env.DB.prepare(`SELECT bucket_kind, hostname, sum(clicks) AS clicks
      FROM link_daily_referrers WHERE link_id = ? AND day BETWEEN ? AND ?
      GROUP BY bucket_kind, hostname
      ORDER BY CASE bucket_kind WHEN 'host' THEN 0 WHEN 'direct' THEN 1 ELSE 2 END, hostname COLLATE BINARY`)
      .bind(linkId, from, to)
      .all<{
        bucket_kind: "host" | "other" | "direct";
        hostname: string | null;
        clicks: number;
      }>(),
  ]);
  const totalsByDay = new Map(
    totals.results.map((row) => [row.day, row.clicks]),
  );
  const days = Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(first + index * 86_400_000).toISOString().slice(0, 10);
    return { day, clicks: totalsByDay.get(day) ?? 0 };
  });
  return context.json({
    timezone: "Asia/Taipei" as const,
    from,
    to,
    total: days.reduce((sum, row) => sum + row.clicks, 0),
    days,
    channels: channels.results.map((row) => ({
      kind: row.bucket_kind,
      label: row.channel_label,
      clicks: row.clicks,
    })),
    referrers: referrers.results.map((row) => ({
      kind: row.bucket_kind,
      hostname: row.hostname,
      clicks: row.clicks,
    })),
  });
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
