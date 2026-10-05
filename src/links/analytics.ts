import { ApiError } from "../http/errors";
import { publicLinkSql } from "../moderation/availability";
import type { Link } from "./model";

export type ClickSource = {
  day: string;
  channel: {
    kind: "configured" | "other";
    label: string | null;
  };
  referrer: {
    kind: "host" | "other" | "direct";
    hostname: string | null;
  };
};

const taipeiDate = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function taipeiDay(now: Date) {
  const parts = new Map(
    taipeiDate
      .formatToParts(now)
      .map((part) => [part.type, part.value] as const),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function referrerSource(request: Request): ClickSource["referrer"] {
  const value = request.headers.get("Referer");
  if (!value) return { kind: "direct", hostname: null };

  try {
    const referrer = new URL(value);
    if (
      !["http:", "https:"].includes(referrer.protocol) ||
      referrer.username !== "" ||
      referrer.password !== ""
    )
      return { kind: "other", hostname: null };

    let hostname = referrer.hostname.toLowerCase();
    if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
    if (
      !hostname ||
      hostname.endsWith(".") ||
      hostname.startsWith("[") ||
      /^[0-9.]+$/.test(hostname) ||
      !hostname.includes(".") ||
      hostname === "localhost" ||
      [
        ".localhost",
        ".local",
        ".internal",
        ".test",
        ".invalid",
        ".example",
      ].some((suffix) => hostname.endsWith(suffix))
    )
      return { kind: "other", hostname: null };

    return { kind: "host", hostname };
  } catch {
    return { kind: "other", hostname: null };
  }
}

export function clickSource(
  request: Request,
  now: Date,
  channels: readonly string[],
): ClickSource {
  const requestedChannels = new URL(request.url).searchParams.getAll(
    "ages_channel",
  );
  const label = requestedChannels[0];
  return {
    day: taipeiDay(now),
    channel:
      requestedChannels.length === 1 &&
      label !== undefined &&
      channels.includes(label)
        ? { kind: "configured", label }
        : { kind: "other", label: null },
    referrer: referrerSource(request),
  };
}

export async function recordLinkClick(
  db: D1Database,
  link: Link,
  source: ClickSource,
): Promise<void> {
  const recordedAt = new Date().toISOString();
  const linkId = link.id;
  const channelLabel = source.channel.label;
  const channelKey = `c:${channelLabel ?? ""}`;
  const referrerHost = source.referrer.hostname;
  const referrerHostKey = `h:${referrerHost ?? ""}`;
  const channelFallbackKey = "o:";
  const referrerFallbackKind =
    source.referrer.kind === "direct" ? "direct" : "other";
  const referrerFallbackKey = referrerFallbackKind === "direct" ? "d:" : "o:";
  const guard = `FROM distribution_links l WHERE l.id = ? AND ${publicLinkSql}`;

  const statements = [
    db
      .prepare(`INSERT INTO link_daily_totals (link_id, day, clicks)
        SELECT ?, ?, 1 ${guard}
        ON CONFLICT(link_id, day) DO UPDATE SET clicks = link_daily_totals.clicks + 1`)
      .bind(linkId, source.day, linkId, recordedAt),
    db
      .prepare(`INSERT INTO link_daily_channels (
          link_id, day, bucket_kind, channel_label, bucket_key, clicks
        )
        SELECT ?, ?, 'configured', ?, ?, 1 ${guard}
          AND ? = 'configured' AND ? IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM link_daily_channels c
              WHERE c.link_id = ? AND c.day = ? AND c.bucket_key = ?)
            OR (SELECT count(*) FROM link_daily_channels c
              WHERE c.link_id = ? AND c.day = ? AND c.bucket_kind = 'configured') < 20
          )
        ON CONFLICT(link_id, day, bucket_key)
        DO UPDATE SET clicks = link_daily_channels.clicks + 1`)
      .bind(
        linkId,
        source.day,
        channelLabel,
        channelKey,
        linkId,
        recordedAt,
        source.channel.kind,
        channelLabel,
        linkId,
        source.day,
        channelKey,
        linkId,
        source.day,
      ),
    db
      .prepare(`INSERT INTO link_daily_channels (
          link_id, day, bucket_kind, channel_label, bucket_key, clicks
        )
        SELECT ?, ?, 'other', NULL, ?, 1 ${guard}
          AND (
            ? = 'other'
            OR (? = 'configured' AND NOT EXISTS (
              SELECT 1 FROM link_daily_channels c
              WHERE c.link_id = ? AND c.day = ? AND c.bucket_key = ?
            ))
          )
        ON CONFLICT(link_id, day, bucket_key)
        DO UPDATE SET clicks = link_daily_channels.clicks + 1`)
      .bind(
        linkId,
        source.day,
        channelFallbackKey,
        linkId,
        recordedAt,
        source.channel.kind,
        source.channel.kind,
        linkId,
        source.day,
        channelKey,
      ),
    db
      .prepare(`INSERT INTO link_daily_referrers (
          link_id, day, bucket_kind, hostname, bucket_key, clicks
        )
        SELECT ?, ?, 'host', ?, ?, 1 ${guard}
          AND ? = 'host' AND ? IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM link_daily_referrers r
              WHERE r.link_id = ? AND r.day = ? AND r.bucket_key = ?)
            OR (SELECT count(*) FROM link_daily_referrers r
              WHERE r.link_id = ? AND r.day = ? AND r.bucket_kind = 'host') < 20
          )
        ON CONFLICT(link_id, day, bucket_key)
        DO UPDATE SET clicks = link_daily_referrers.clicks + 1`)
      .bind(
        linkId,
        source.day,
        referrerHost,
        referrerHostKey,
        linkId,
        recordedAt,
        source.referrer.kind,
        referrerHost,
        linkId,
        source.day,
        referrerHostKey,
        linkId,
        source.day,
      ),
    db
      .prepare(`INSERT INTO link_daily_referrers (
          link_id, day, bucket_kind, hostname, bucket_key, clicks
        )
        SELECT ?, ?, ?, NULL, ?, 1 ${guard}
          AND (
            ? IN ('other', 'direct')
            OR (? = 'host' AND NOT EXISTS (
              SELECT 1 FROM link_daily_referrers r
              WHERE r.link_id = ? AND r.day = ? AND r.bucket_key = ?
            ))
          )
        ON CONFLICT(link_id, day, bucket_key)
        DO UPDATE SET clicks = link_daily_referrers.clicks + 1`)
      .bind(
        linkId,
        source.day,
        referrerFallbackKind,
        referrerFallbackKey,
        linkId,
        recordedAt,
        source.referrer.kind,
        source.referrer.kind,
        linkId,
        source.day,
        referrerHostKey,
      ),
  ];

  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    if (results.some((result) => (result.meta.changes ?? 0) !== 0))
      throw new Error("Link analytics availability guard was inconsistent.");
    throw new ApiError("NOT_FOUND");
  }
}
