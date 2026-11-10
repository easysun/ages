// Each caller aliases the Timeline; a blocked member hides its captions and OG too.
export function timelineContentAvailableSqlFor(timelineAlias: string) {
  return `${timelineAlias}.moderation_blocked = 0
  AND NOT EXISTS (SELECT 1 FROM assets blocked WHERE blocked.id = ${timelineAlias}.cover_asset_id AND blocked.moderation_blocked = 1)
  AND NOT EXISTS (SELECT 1 FROM timeline_items i JOIN assets blocked ON blocked.id = i.asset_id
    WHERE i.timeline_id = ${timelineAlias}.id AND blocked.moderation_blocked = 1)`;
}

export const timelineContentAvailableSql = timelineContentAvailableSqlFor("t");

export const visibleTimelineSql = `t.visibility IN ('unlisted', 'public') AND ${timelineContentAvailableSql}`;

export const publicLinkSql = `l.active = 1 AND l.moderation_blocked = 0
  AND (l.expires_at IS NULL OR julianday(l.expires_at) > julianday(?))
  AND (l.target_kind = 'url'
    OR (l.target_kind = 'asset' AND EXISTS (SELECT 1 FROM assets a WHERE a.id = l.asset_id
      AND a.owner_id = l.owner_id AND a.status = 'ready' AND a.deleted_at IS NULL AND a.moderation_blocked = 0))
    OR (l.target_kind = 'timeline' AND EXISTS (SELECT 1 FROM timelines t WHERE t.id = l.timeline_id
      AND t.owner_id = l.owner_id AND ${visibleTimelineSql})))`;
