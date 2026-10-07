import { z } from "zod";
import { linkUrlSchema } from "../links/model";
import { timelineContentAvailableSql } from "../moderation/availability";
import { moderationSchema } from "../moderation/model";

export type ContentNode = {
  id: string;
  owner_id: string;
  kind: "timeline" | "external";
  visibility: "private" | "unlisted" | "public";
  timeline_id: string | null;
  url: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  moderation_blocked: number;
};

type ContentNodeRow = ContentNode & {
  available_timeline_id: string | null;
  timeline_title: string | null;
  timeline_visibility: ContentNode["visibility"] | null;
};

const visibilitySchema = z.enum(["private", "unlisted", "public"]);
const titleSchema = z
  .string()
  .max(200)
  .refine((value) => value.length <= 200)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }),
  );

export const createContentNodeSchema = z.union([
  z.strictObject({
    kind: z.literal("timeline"),
    timeline_id: z.string().min(1).max(100),
    visibility: visibilitySchema.default("private"),
  }),
  z.strictObject({
    kind: z.literal("external"),
    url: linkUrlSchema,
    title: titleSchema
      .nullable()
      .optional()
      .transform((title) => title ?? null),
    visibility: visibilitySchema.default("private"),
  }),
]);

export const updateContentNodeSchema = z
  .strictObject({
    title: titleSchema.nullable().optional(),
    visibility: visibilitySchema.optional(),
    removed: z.literal(false).optional(),
  })
  .refine((value) => {
    if (value.removed === false) return Object.keys(value).length === 1;
    return value.title !== undefined || value.visibility !== undefined;
  });

export const contentNodeModerationSchema = moderationSchema.pick({
  blocked: true,
  reason: true,
});

export async function effectiveNode(
  db: D1Database,
  id: string,
  viewerId: string | null,
): Promise<{
  node: ContentNode;
  visibility: ContentNode["visibility"];
} | null> {
  const row = await db
    .prepare(
      "SELECT n.*, t.id AS available_timeline_id, t.title AS timeline_title, " +
        "t.visibility AS timeline_visibility FROM content_nodes n " +
        "LEFT JOIN timelines t ON t.id = n.timeline_id AND t.owner_id = n.owner_id AND " +
        timelineContentAvailableSql +
        " WHERE n.id = ? AND n.removed_at IS NULL AND n.moderation_blocked = 0",
    )
    .bind(id)
    .first<ContentNodeRow>();
  if (!row) return null;

  let effectiveVisibility = row.visibility;
  let title = row.title;
  if (row.kind === "timeline") {
    if (!row.available_timeline_id || !row.timeline_visibility) return null;
    title = row.timeline_title;
    const rank = { private: 0, unlisted: 1, public: 2 };
    effectiveVisibility =
      rank[row.visibility] <= rank[row.timeline_visibility]
        ? row.visibility
        : row.timeline_visibility;
  }

  if (effectiveVisibility === "private" && viewerId !== row.owner_id)
    return null;

  const {
    available_timeline_id: _availableTimelineId,
    timeline_title: _timelineTitle,
    timeline_visibility: _timelineVisibility,
    ...storedNode
  } = row;
  return {
    node: { ...storedNode, title },
    visibility: effectiveVisibility,
  };
}

export function publicNodePayload(node: ContentNode) {
  const {
    owner_id: _owner,
    removed_at: _removed,
    moderation_blocked: _blocked,
    ...payload
  } = node;
  return payload;
}
