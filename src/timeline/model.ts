import type { EventAt } from "./validation";
export type Timeline = {
  id: string;
  owner_id: string;
  title: string;
  visibility: "private" | "unlisted" | "public";
  cover_asset_id: string | null;
  version: number;
  moderation_blocked: number;
  last_mutation_token: string | null;
  created_at: string;
  updated_at: string;
};
export type TimelineItem = {
  id: string;
  timeline_id: string;
  owner_id: string;
  asset_id: string;
  position: number;
  caption: string;
  event_at: string | null;
  created_at: string;
  updated_at: string;
};
export function timelinePayload(row: Timeline, items?: TimelineItem[]) {
  const {
    owner_id: _owner,
    last_mutation_token: _token,
    moderation_blocked: _blocked,
    ...timeline
  } = row;
  return {
    ...timeline,
    ...(items === undefined
      ? {}
      : {
          items: items.map(({ owner_id: _owner, ...item }) => ({
            ...item,
            event_at:
              item.event_at === null
                ? null
                : (JSON.parse(item.event_at) as EventAt),
          })),
        }),
  };
}
