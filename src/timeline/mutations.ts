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
      asset_id: string;
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
) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const scope = [id, owner, expectedVersion + 1, token];
  const gate =
    "EXISTS (SELECT 1 FROM timelines WHERE id = ? AND owner_id = ? AND version = ? AND last_mutation_token = ?)";
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
    condition =
      "EXISTS (SELECT 1 FROM assets WHERE id = ? AND owner_id = ? AND status = 'ready' AND deleted_at IS NULL)";
    conditionValues = [change.asset_id, owner];
    writes.push(
      db
        .prepare(`INSERT INTO timeline_items (id, timeline_id, owner_id, asset_id, position, caption, event_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, COALESCE((SELECT MAX(position)+1 FROM timeline_items WHERE timeline_id = ?), 0), ?, ?, ?, ? WHERE ${gate}`)
        .bind(
          `ti_${crypto.randomUUID()}`,
          id,
          owner,
          change.asset_id,
          id,
          change.caption,
          change.event_at === null ? null : JSON.stringify(change.event_at),
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
    else
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
  // Zero-row CAS is successful SQL. Every later write and result is independently token-gated.
  const result = await db.batch([
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
      .prepare(`SELECT * FROM timelines WHERE id = ? AND ${gate}`)
      .bind(id, ...scope),
    db
      .prepare(
        `SELECT * FROM timeline_items WHERE timeline_id = ? AND ${gate} ORDER BY position, id`,
      )
      .bind(id, ...scope),
    db
      .prepare("SELECT version FROM timelines WHERE id = ? AND owner_id = ?")
      .bind(id, owner),
  ]);
  if (result[0]?.meta.changes !== 1) {
    const current = result.at(-1)?.results[0] as
      | { version: number }
      | undefined;
    if (!current) throw new ApiError("NOT_FOUND");
    if (change.kind === "order" && current.version === expectedVersion)
      throw new ApiError("INVALID_REQUEST");
    throw new ApiError("CONFLICT");
  }
  return timelinePayload(
    result.at(-3)?.results[0] as Timeline,
    result.at(-2)?.results as TimelineItem[],
  );
}
