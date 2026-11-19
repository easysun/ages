CREATE TABLE timeline_items_new (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    asset_id TEXT,
    position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position >= 0),
    caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 10000),
    event_at TEXT CHECK (event_at IS NULL OR CASE WHEN json_valid(event_at) THEN
        COALESCE(json_type(event_at) = 'object' AND json_type(event_at, '$.time_zone') = 'text' AND (
            (json_extract(event_at, '$.kind') = 'date' AND json_type(event_at, '$.date') = 'text'
                AND json_extract(event_at, '$.calendar') = 'iso8601') OR
            (json_extract(event_at, '$.kind') = 'instant' AND json_type(event_at, '$.instant') = 'text')
        ), 0) ELSE 0 END),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Match JavaScript trim() whitespace while preserving the author's original text.
    CONSTRAINT timeline_text_requires_caption CHECK (asset_id IS NOT NULL OR
        (typeof(caption) = 'text' AND trim(caption, char(9, 10, 11, 12, 13, 32, 160, 5760,
            8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
            8232, 8233, 8239, 8287, 12288, 65279)) != '')),
    UNIQUE (timeline_id, position),
    FOREIGN KEY (timeline_id, owner_id) REFERENCES timelines(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id, owner_id) REFERENCES assets(id, owner_id) ON DELETE RESTRICT
);

INSERT INTO timeline_items_new (id, timeline_id, owner_id, asset_id, position, caption, event_at, created_at, updated_at)
SELECT id, timeline_id, owner_id, asset_id, position, caption, event_at, created_at, updated_at FROM timeline_items;

-- SQLite validates triggers on other tables when renaming the replacement.
DROP TRIGGER assets_protect_timeline_update;
DROP TRIGGER assets_protect_timeline_delete;
DROP TABLE timeline_items;
ALTER TABLE timeline_items_new RENAME TO timeline_items;
CREATE INDEX idx_timeline_items_asset ON timeline_items(asset_id);

CREATE TRIGGER timeline_items_ready_insert BEFORE INSERT ON timeline_items
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets WHERE id = NEW.asset_id AND owner_id = NEW.owner_id
    AND status = 'ready' AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_timeline_asset'); END;
CREATE TRIGGER timeline_items_immutable_identity BEFORE UPDATE ON timeline_items
WHEN OLD.id != NEW.id OR OLD.timeline_id != NEW.timeline_id OR OLD.owner_id != NEW.owner_id OR OLD.asset_id IS NOT NEW.asset_id
BEGIN SELECT RAISE(ABORT, 'immutable_timeline_item_identity'); END;

CREATE TRIGGER assets_protect_timeline_update BEFORE UPDATE OF status, deleted_at ON assets
WHEN (NEW.status != 'ready' OR NEW.deleted_at IS NOT NULL) AND (
    EXISTS (SELECT 1 FROM timeline_items WHERE asset_id = OLD.id) OR
    EXISTS (SELECT 1 FROM timelines WHERE cover_asset_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'asset_referenced_by_timeline'); END;
CREATE TRIGGER assets_protect_timeline_delete BEFORE DELETE ON assets
WHEN EXISTS (SELECT 1 FROM timeline_items WHERE asset_id = OLD.id) OR
    EXISTS (SELECT 1 FROM timelines WHERE cover_asset_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'asset_referenced_by_timeline'); END;

-- Keep the request fingerprint after item removal so retries cannot recreate it.
CREATE TABLE timeline_append_receipts (
    item_id TEXT PRIMARY KEY NOT NULL,
    timeline_id TEXT NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    valid INTEGER NOT NULL DEFAULT 1 CHECK (valid IN (0, 1))
);
CREATE INDEX idx_timeline_append_receipts_timeline ON timeline_append_receipts(timeline_id);
