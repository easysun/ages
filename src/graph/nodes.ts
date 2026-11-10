import { z } from "zod";
import { linkUrlSchema } from "../links/model";
import { timelineContentAvailableSqlFor } from "../moderation/availability";
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

type EffectiveNodeRow = ContentNode & {
  effective_title: string | null;
  effective_visibility: ContentNode["visibility"];
};

export function effectiveNodeTimelineJoinSql(
  nodeAlias: string,
  timelineAlias: string,
) {
  return `LEFT JOIN timelines ${timelineAlias} ON ${timelineAlias}.id = ${nodeAlias}.timeline_id
    AND ${timelineAlias}.owner_id = ${nodeAlias}.owner_id
    AND ${timelineContentAvailableSqlFor(timelineAlias)}`;
}

export function effectiveNodeAvailableSql(
  nodeAlias: string,
  timelineAlias: string,
) {
  return `${nodeAlias}.removed_at IS NULL
    AND ${nodeAlias}.moderation_blocked = 0
    AND (${nodeAlias}.kind != 'timeline' OR ${timelineAlias}.id IS NOT NULL)`;
}

export function effectiveNodeVisibilitySql(
  nodeAlias: string,
  timelineAlias: string,
) {
  return `CASE WHEN ${nodeAlias}.kind = 'timeline' THEN
    CASE
      WHEN ${nodeAlias}.visibility = 'private' OR ${timelineAlias}.visibility = 'private' THEN 'private'
      WHEN ${nodeAlias}.visibility = 'unlisted' OR ${timelineAlias}.visibility = 'unlisted' THEN 'unlisted'
      ELSE 'public'
    END
  ELSE ${nodeAlias}.visibility END`;
}

export function effectiveNodeTitleSql(
  nodeAlias: string,
  timelineAlias: string,
) {
  return `CASE WHEN ${nodeAlias}.kind = 'timeline' THEN ${timelineAlias}.title
    ELSE ${nodeAlias}.title END`;
}

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
  const visibilitySql = effectiveNodeVisibilitySql("n", "t");
  const row = await db
    .prepare(`SELECT n.*,
        ${effectiveNodeTitleSql("n", "t")} AS effective_title,
        ${visibilitySql} AS effective_visibility
      FROM content_nodes n
      ${effectiveNodeTimelineJoinSql("n", "t")}
      WHERE n.id = ? AND ${effectiveNodeAvailableSql("n", "t")}
        AND (${visibilitySql} != 'private' OR n.owner_id = ?)`)
    .bind(id, viewerId ?? "")
    .first<EffectiveNodeRow>();
  if (!row) return null;
  const {
    effective_title: effectiveTitle,
    effective_visibility: effectiveVisibility,
    ...storedNode
  } = row;
  return {
    node: { ...storedNode, title: effectiveTitle },
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
