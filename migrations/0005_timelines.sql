CREATE UNIQUE INDEX idx_assets_id_owner ON assets(id, owner_id);

CREATE TABLE timelines (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    cover_asset_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version > 0),
    last_mutation_token TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, owner_id),
    FOREIGN KEY (cover_asset_id, owner_id) REFERENCES assets(id, owner_id) ON DELETE RESTRICT
);
CREATE INDEX idx_timelines_owner_created ON timelines(owner_id, created_at DESC, id DESC);
CREATE INDEX idx_timelines_cover ON timelines(cover_asset_id);

CREATE TABLE timeline_items (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
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
    UNIQUE (timeline_id, position),
    FOREIGN KEY (timeline_id, owner_id) REFERENCES timelines(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id, owner_id) REFERENCES assets(id, owner_id) ON DELETE RESTRICT
);
CREATE INDEX idx_timeline_items_asset ON timeline_items(asset_id);

CREATE TRIGGER timelines_quota BEFORE INSERT ON timelines
WHEN NOT EXISTS (SELECT 1 FROM usage_quotas q WHERE q.user_id = NEW.owner_id
    AND (SELECT count(*) FROM timelines WHERE owner_id = NEW.owner_id) < q.timeline_limit)
BEGIN SELECT RAISE(ABORT, 'timeline_quota_exceeded'); END;

CREATE TRIGGER timelines_immutable_identity BEFORE UPDATE ON timelines
WHEN OLD.id != NEW.id OR OLD.owner_id != NEW.owner_id
BEGIN SELECT RAISE(ABORT, 'immutable_timeline_identity'); END;

CREATE TRIGGER timelines_ready_cover_insert BEFORE INSERT ON timelines
WHEN NEW.cover_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets
    WHERE id = NEW.cover_asset_id AND owner_id = NEW.owner_id AND status = 'ready' AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_timeline_cover'); END;
CREATE TRIGGER timelines_ready_cover_update BEFORE UPDATE OF cover_asset_id ON timelines
WHEN NEW.cover_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets
    WHERE id = NEW.cover_asset_id AND owner_id = NEW.owner_id AND status = 'ready' AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_timeline_cover'); END;

CREATE TRIGGER timeline_items_ready_insert BEFORE INSERT ON timeline_items
WHEN NOT EXISTS (SELECT 1 FROM assets WHERE id = NEW.asset_id AND owner_id = NEW.owner_id
    AND status = 'ready' AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_timeline_asset'); END;
CREATE TRIGGER timeline_items_immutable_identity BEFORE UPDATE ON timeline_items
WHEN OLD.id != NEW.id OR OLD.timeline_id != NEW.timeline_id OR OLD.owner_id != NEW.owner_id OR OLD.asset_id != NEW.asset_id
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
