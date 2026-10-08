import { z } from "zod";
import { ApiError } from "../http/errors";
import { reportSchema } from "../moderation/model";
import { contentNodeModerationSchema, effectiveNode } from "./nodes";

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

function isPairQualified(
  edge: EdgeRow,
  direction: "incoming" | "outgoing",
  knownNodeId: string | null,
) {
  return (
    knownNodeId !== null &&
    knownNodeId === (direction === "incoming" ? edge.source_id : edge.target_id)
  );
}

async function publicEdgeForViewer(
  db: D1Database,
  edge: EdgeRow,
  viewerId: string | null,
  direction: "incoming" | "outgoing",
  knownNodeId: string | null,
): Promise<PublicEdge | null> {
  const [source, target] = await Promise.all([
    effectiveNode(db, edge.source_id, viewerId),
    effectiveNode(db, edge.target_id, viewerId),
  ]);
  if (!source || !target) return null;

  const pairQualified = isPairQualified(edge, direction, knownNodeId);
  if (knownNodeId !== null && !pairQualified) return null;
  const sameOwner = source.node.owner_id === target.node.owner_id;
  const viewerOwnsBoth =
    viewerId !== null &&
    source.node.owner_id === viewerId &&
    target.node.owner_id === viewerId;
  const crossOwner = !sameOwner;

  if (
    crossOwner &&
    (source.visibility === "unlisted" || target.visibility === "unlisted") &&
    (!pairQualified || !edge.accepted_at)
  )
    return null;
  if (
    (source.visibility === "private" || target.visibility === "private") &&
    !viewerOwnsBoth
  )
    return null;
  if (
    !pairQualified &&
    !viewerOwnsBoth &&
    (source.visibility !== "public" || target.visibility !== "public")
  )
    return null;

  return {
    id: edge.id,
    type: edge.type,
    source: { id: source.node.id, title: source.node.title },
    target: { id: target.node.id, title: target.node.title },
    attribution: "added by source owner",
    created_at: edge.created_at,
  };
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

  const pageSize = Math.max(30, limit + 1);
  const nodeColumn = direction === "incoming" ? "target_id" : "source_id";
  let after: Pick<EdgeCursor, "created_at" | "id"> | null = cursor
    ? { created_at: cursor.created_at, id: cursor.id }
    : null;
  const visible: PublicEdge[] = [];
  let hasMoreVisible = false;

  while (!hasMoreVisible) {
    const rows = await db
      .prepare(`SELECT e.* FROM content_edges e
        WHERE e.${nodeColumn}=? AND e.removed_at IS NULL AND e.suppressed_at IS NULL
          AND e.target_owner_blocked_at IS NULL AND e.admin_blocked=0
          ${after ? "AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))" : ""}
        ORDER BY e.created_at DESC,e.id DESC LIMIT ?`)
      .bind(
        nodeId,
        ...(after ? [after.created_at, after.created_at, after.id] : []),
        pageSize,
      )
      .all<EdgeRow>();
    if (rows.results.length === 0) break;

    for (const edge of rows.results) {
      after = { created_at: edge.created_at, id: edge.id };
      const publicEdge = await publicEdgeForViewer(
        db,
        edge,
        viewerId,
        direction,
        knownNodeId,
      );
      if (!publicEdge) continue;
      visible.push(publicEdge);
      if (visible.length > limit) {
        hasMoreVisible = true;
        break;
      }
    }
    if (hasMoreVisible || rows.results.length < pageSize) break;
  }

  const page = visible.slice(0, limit);
  const last = page.at(-1);
  return {
    edges: page,
    next_cursor:
      hasMoreVisible && last
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
