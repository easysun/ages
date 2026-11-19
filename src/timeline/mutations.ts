import { ApiError } from "../http/errors";
import { type Timeline, type TimelineItem, timelinePayload } from "./model";
import type { EventAt } from "./validation";

type Change =
  | {
      kind: "metadata";
      title?: string | undefined;
      visibility?: Timeline["visibility"] | undefined;
      cover_asset_id?: string | null | undefined;
    }
  | {
      kind: "append";
      item_id?: string | undefined;
      asset_id: string | null;
      caption: string;
      event_at: EventAt | null;
    }
  | {
      kind: "edit";
      item_id: string;
      caption?: string | undefined;
      event_at?: EventAt | null | undefined;
    }
  | { kind: "remove"; item_id: string }
  | { kind: "order"; item_ids: string[] };

export async function mutateTimeline(
  db: D1Database,
  owner: string,
  id: string,
  expectedVersion: number,
  change: Change,
  options: { includeItems?: boolean } = {},
) {
  const includeItems = options.includeItems ?? true;
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const scope = [id, owner, expectedVersion + 1, token];
  const gate =
    "EXISTS (SELECT 1 FROM timelines WHERE id = ? AND owner_id = ? AND version = ? AND last_mutation_token = ?)";
  let readGate = gate;
  let readScope: (string | number | null | ArrayBuffer)[] = scope;
  let condition = "1";
  let conditionValues: (string | number | null)[] = [];
  let assignments = "";
  let assignmentValues: (string | number | null)[] = [];
  const writes: D1PreparedStatement[] = [];
  if (change.kind === "metadata") {
    assignments =
      ", title = CASE WHEN ? THEN ? ELSE title END, visibility = CASE WHEN ? THEN ? ELSE visibility END, cover_asset_id = CASE WHEN ? THEN ? ELSE cover_asset_id END";
    assignmentValues = [
      Number(change.title !== undefined),
      change.title ?? null,
      Number(change.visibility !== undefined),
      change.visibility ?? null,
      Number(change.cover_asset_id !== undefined),
      change.cover_asset_id ?? null,
    ];
    if (change.cover_asset_id != null) {
      condition =
        "EXISTS (SELECT 1 FROM assets WHERE id = ? AND owner_id = ? AND status = 'ready' AND deleted_at IS NULL)";
      conditionValues = [change.cover_asset_id, owner];
    }
  } else if (change.kind === "append") {
    if (change.asset_id !== null) {
      condition =
        "EXISTS (SELECT 1 FROM assets WHERE id = ? AND owner_id = ? AND status = 'ready' AND deleted_at IS NULL)";
      conditionValues = [change.asset_id, owner];
    }
    const eventJson =
      change.event_at === null ? null : JSON.stringify(change.event_at);
    if (change.item_id !== undefined) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            expectedVersion,
            change.asset_id,
            change.caption,
            eventJson,
          ]),
        ),
      );
      condition += ` AND NOT EXISTS (SELECT 1 FROM timeline_append_receipts WHERE item_id = ?)
        AND NOT EXISTS (SELECT 1 FROM timeline_items WHERE id = ?)`;
      conditionValues.push(change.item_id, change.item_id);
      writes.push(
        db
          .prepare(`INSERT INTO timeline_append_receipts (item_id, timeline_id, request_digest)
        SELECT ?, ?, ? WHERE ${gate}`)
          .bind(change.item_id, id, digest, ...scope),
      );

      // An identical retry may read the current timeline only while its original item still matches.
      readGate = `EXISTS (SELECT 1 FROM timeline_append_receipts r
        JOIN timeline_items i ON i.id = r.item_id AND i.timeline_id = r.timeline_id
        WHERE r.item_id = ? AND r.timeline_id = ? AND i.owner_id = ? AND r.request_digest = ?
        AND r.valid = 1 AND i.asset_id IS ? AND i.caption = ? AND i.event_at IS ?)`;
      readScope = [
        change.item_id,
        id,
        owner,
        digest,
        change.asset_id,
        change.caption,
        eventJson,
      ];
    }
    writes.push(
      db
        .prepare(`INSERT INTO timeline_items (id, timeline_id, owner_id, asset_id, position, caption, event_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, COALESCE((SELECT MAX(position)+1 FROM timeline_items WHERE timeline_id = ?), 0), ?, ?, ?, ? WHERE ${gate}`)
        .bind(
          change.item_id ?? `ti_${crypto.randomUUID()}`,
          id,
          owner,
          change.asset_id,
          id,
          change.caption,
          eventJson,
          now,
          now,
          ...scope,
        ),
    );
  } else if (change.kind === "edit" || change.kind === "remove") {
    condition =
      "EXISTS (SELECT 1 FROM timeline_items WHERE id = ? AND timeline_id = ? AND owner_id = ?)";
    conditionValues = [change.item_id, id, owner];
    if (change.kind === "remove")
      writes.push(
        db
          .prepare(
            `DELETE FROM timeline_items WHERE id = ? AND timeline_id = ? AND ${gate}`,
          )
          .bind(change.item_id, id, ...scope),
      );
    else {
      writes.push(
        db
          .prepare(`UPDATE timeline_items SET caption = CASE WHEN ? THEN ? ELSE caption END,
      event_at = CASE WHEN ? THEN ? ELSE event_at END, updated_at = ? WHERE id = ? AND timeline_id = ? AND ${gate}`)
          .bind(
            Number(change.caption !== undefined),
            change.caption ?? null,
            Number(change.event_at !== undefined),
            change.event_at == null ? null : JSON.stringify(change.event_at),
            now,
            change.item_id,
            id,
            ...scope,
          ),
      );
      writes.push(
        db
          .prepare(`UPDATE timeline_append_receipts SET valid = 0
      WHERE item_id = ? AND timeline_id = ? AND ${gate}`)
          .bind(change.item_id, id, ...scope),
      );
    }
  } else {
    const order = JSON.stringify(change.item_ids);
    condition = `(SELECT COUNT(*) FROM timeline_items WHERE timeline_id = ?) = json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM timeline_items i WHERE i.id = j.value AND i.timeline_id = ?))`;
    conditionValues = [id, order, order, id];
    // Move positions above the occupied range before assigning the final unique order.
    writes.push(
      db
        .prepare(`UPDATE timeline_items SET position = position + (SELECT COALESCE(MAX(position),0)+1 FROM timeline_items WHERE timeline_id = ?)
      WHERE timeline_id = ? AND ${gate}`)
        .bind(id, id, ...scope),
    );
    writes.push(
      db
        .prepare(`UPDATE timeline_items SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value = timeline_items.id), updated_at = ?
      WHERE timeline_id = ? AND ${gate}`)
        .bind(order, now, id, ...scope),
    );
  }
  // A failed version check suppresses all writes. Only an exact append retry can read its result.
  const timelineResultIndex = 1 + writes.length;
  const itemsResultIndex = timelineResultIndex + 1;
  const versionResultIndex = itemsResultIndex + (includeItems ? 1 : 0);
  const statements = [
    db
      .prepare(`UPDATE timelines SET version = version + 1, last_mutation_token = ?, updated_at = ?${assignments}
      WHERE id = ? AND owner_id = ? AND version = ? AND (${condition})`)
      .bind(
        token,
        now,
        ...assignmentValues,
        id,
        owner,
        expectedVersion,
        ...conditionValues,
      ),
    ...writes,
    db
      .prepare(`SELECT * FROM timelines WHERE id = ? AND ${readGate}`)
      .bind(id, ...readScope),
    ...(includeItems
      ? [
          db
            .prepare(
              `SELECT * FROM timeline_items WHERE timeline_id = ? AND ${readGate} ORDER BY position, id`,
            )
            .bind(id, ...readScope),
        ]
      : []),
    change.kind === "append" && change.item_id !== undefined
      ? db
          .prepare(`SELECT version, EXISTS (
          SELECT 1 FROM timeline_append_receipts WHERE item_id = ? AND timeline_id = timelines.id
        ) AS receipt_used FROM timelines WHERE id = ? AND owner_id = ?`)
          .bind(change.item_id, id, owner)
      : db
          .prepare(
            "SELECT version FROM timelines WHERE id = ? AND owner_id = ?",
          )
          .bind(id, owner),
  ];
  const result = await db.batch(statements).catch((error: unknown) => {
    if (
      error instanceof Error &&
      error.message.includes("timeline_text_requires_caption")
    )
      throw new ApiError("INVALID_REQUEST");
    throw error;
  });
  const timeline = result[timelineResultIndex]?.results[0] as
    | Timeline
    | undefined;
  if (!timeline) {
    const current = result[versionResultIndex]?.results[0] as
      | { version: number; receipt_used?: number }
      | undefined;
    if (!current) throw new ApiError("NOT_FOUND");
    if (current.receipt_used) throw new ApiError("APPEND_ALREADY_APPLIED");
    if (change.kind === "order" && current.version === expectedVersion)
      throw new ApiError("INVALID_REQUEST");
    throw new ApiError("CONFLICT");
  }
  if (!includeItems) return;
  return timelinePayload(
    timeline,
    result[itemsResultIndex]?.results as TimelineItem[],
  );
}
