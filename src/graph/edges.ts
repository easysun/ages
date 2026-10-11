import { z } from "zod";
import { ApiError } from "../http/errors";
import { reportSchema } from "../moderation/model";
import {
  contentNodeModerationSchema,
  effectiveNode,
  effectiveNodeAvailableSql,
  effectiveNodeTimelineJoinSql,
  effectiveNodeTitleSql,
  effectiveNodeVisibilitySql,
} from "./nodes";

export type ContentEdge = {
  id: string;
  source_id: string;
  target_id: string;
  type: "related_to" | "references" | "continuation";
  creator_id: string;
  accepted_at: string | null;
  suppressed_at: string | null;
  target_owner_blocked_at: string | null;
  admin_blocked: boolean;
  removed_at: string | null;
  created_at: string;
};

export type PublicEdge = {
  id: string;
  type: ContentEdge["type"];
  source: { id: string; title: string | null };
  target: { id: string; title: string | null };
  attribution: "added by source owner";
  created_at: string;
};

type EdgeRow = Omit<ContentEdge, "admin_blocked"> & {
  admin_blocked: number;
};
type VisibleEdgeRow = EdgeRow & {
  source_title: string | null;
  target_title: string | null;
};

const nodeId = z.string().min(1).max(100);
const edgeType = z.enum(["related_to", "references", "continuation"]);
export const createContentEdgeSchema = z.strictObject({
  source_id: nodeId,
  target_id: nodeId,
  type: edgeType,
});
export const contentEdgeActionSchema = z.strictObject({
  action: z.enum(["accept", "suppress", "unsuppress", "block", "unblock"]),
});
export const contentEdgeModerationSchema = contentNodeModerationSchema;
export const contentEdgeReportSchema = z.strictObject({
  category: reportSchema.shape.category,
  detail: reportSchema.shape.detail,
});

const cursorSchema = z.strictObject({
  v: z.literal(1),
  viewer: z.string().nullable(),
  node: nodeId,
  direction: z.enum(["incoming", "outgoing"]),
  known_node: nodeId.nullable(),
  created_at: z.iso.datetime(),
  id: nodeId,
});
type EdgeCursor = z.infer<typeof cursorSchema>;

function encodeEdgeCursor(cursor: EdgeCursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `edges.${encoded}`;
}

function decodeEdgeCursor(value: string): EdgeCursor {
  try {
    if (!value.startsWith("edges."))
      throw new Error("Invalid cursor namespace");
    const encoded = value.slice("edges.".length);
    if (!/^[A-Za-z0-9_-]{1,2000}$/.test(encoded))
      throw new Error("Invalid cursor encoding");
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    const cursor = cursorSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
    if (encodeEdgeCursor(cursor) !== value)
      throw new Error("Non-canonical cursor");
    return cursor;
  } catch {
    throw new ApiError("INVALID_REQUEST");
  }
}

function cursorMatches(
  cursor: EdgeCursor,
  viewerId: string | null,
  node: string,
  direction: "incoming" | "outgoing",
  knownNodeId: string | null,
) {
  return (
    cursor.viewer === viewerId &&
    cursor.node === node &&
    cursor.direction === direction &&
    cursor.known_node === knownNodeId
  );
}

export async function visibleEdges(
  db: D1Database,
  nodeId: string,
  direction: "incoming" | "outgoing",
  viewerId: string | null,
  knownNodeId: string | null,
  cursorValue: string | null,
  limit: number,
): Promise<{ edges: PublicEdge[]; next_cursor: string | null }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError("INVALID_REQUEST");

  const queriedNode = await effectiveNode(db, nodeId, viewerId);
  if (!queriedNode) throw new ApiError("NOT_FOUND");

  let cursor: EdgeCursor | null = null;
  if (cursorValue !== null) {
    cursor = decodeEdgeCursor(cursorValue);
    if (!cursorMatches(cursor, viewerId, nodeId, direction, knownNodeId))
      throw new ApiError("INVALID_REQUEST");
  }

  const nodeColumn = direction === "incoming" ? "target_id" : "source_id";
  const oppositeColumn = direction === "incoming" ? "source_id" : "target_id";
  const after = cursor
    ? { created_at: cursor.created_at, id: cursor.id }
    : null;
  const sourceVisibility = effectiveNodeVisibilitySql(
    "source",
    "source_timeline",
  );
  const targetVisibility = effectiveNodeVisibilitySql(
    "target",
    "target_timeline",
  );
  const viewerOwnsBoth = viewerId
    ? "(source.owner_id=? AND target.owner_id=?)"
    : "0";
  const knownNodeFilter =
    knownNodeId === null ? "" : `AND e.${oppositeColumn}=?`;
  const relationVisibility =
    knownNodeId === null
      ? `AND (${viewerOwnsBoth} OR (${sourceVisibility}='public' AND ${targetVisibility}='public'))`
      : `AND (${viewerOwnsBoth} OR (${sourceVisibility}!='private' AND ${targetVisibility}!='private'))
      AND (source.owner_id=target.owner_id
        OR (${sourceVisibility}!='unlisted' AND ${targetVisibility}!='unlisted')
        OR e.accepted_at IS NOT NULL)`;
  const afterFilter = after
    ? "AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))"
    : "";
  const rows = await db
    .prepare(`SELECT e.*,
        ${effectiveNodeTitleSql("source", "source_timeline")} AS source_title,
        ${effectiveNodeTitleSql("target", "target_timeline")} AS target_title
      FROM content_edges e
      JOIN content_nodes source ON source.id=e.source_id
      ${effectiveNodeTimelineJoinSql("source", "source_timeline")}
      JOIN content_nodes target ON target.id=e.target_id
      ${effectiveNodeTimelineJoinSql("target", "target_timeline")}
      WHERE e.${nodeColumn}=? AND e.removed_at IS NULL AND e.suppressed_at IS NULL
        AND e.target_owner_blocked_at IS NULL AND e.admin_blocked=0
        ${knownNodeFilter}
        ${afterFilter}
        AND ${effectiveNodeAvailableSql("source", "source_timeline")}
        AND ${effectiveNodeAvailableSql("target", "target_timeline")}
        AND (${sourceVisibility}!='private' OR source.owner_id=?)
        AND (${targetVisibility}!='private' OR target.owner_id=?)
        ${relationVisibility}
      ORDER BY e.created_at DESC,e.id DESC LIMIT ?`)
    .bind(
      nodeId,
      ...(knownNodeId === null ? [] : [knownNodeId]),
      ...(after ? [after.created_at, after.created_at, after.id] : []),
      viewerId ?? "",
      viewerId ?? "",
      ...(viewerId === null ? [] : [viewerId, viewerId]),
      limit + 1,
    )
    .all<VisibleEdgeRow>();

  const page = rows.results.slice(0, limit).map<PublicEdge>((edge) => ({
    id: edge.id,
    type: edge.type,
    source: { id: edge.source_id, title: edge.source_title },
    target: { id: edge.target_id, title: edge.target_title },
    attribution: "added by source owner",
    created_at: edge.created_at,
  }));
  const last = page.at(-1);
  return {
    edges: page,
    next_cursor:
      rows.results.length > limit && last
        ? encodeEdgeCursor({
            v: 1,
            viewer: viewerId,
            node: nodeId,
            direction,
            known_node: knownNodeId,
            created_at: last.created_at,
            id: last.id,
          })
        : null,
  };
}
