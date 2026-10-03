-- Preserve the original Link rows as an immutable archive; all live Link state moves here.
CREATE TABLE distribution_links (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 64 AND slug NOT GLOB '*[^a-z0-9-]*'),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('url', 'timeline', 'asset')),
    target_url TEXT,
    timeline_id TEXT,
    asset_id TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((target_kind = 'url' AND target_url IS NOT NULL AND timeline_id IS NULL AND asset_id IS NULL) OR
        (target_kind = 'timeline' AND timeline_id IS NOT NULL AND target_url IS NULL AND asset_id IS NULL) OR
        (target_kind = 'asset' AND asset_id IS NOT NULL AND target_url IS NULL AND timeline_id IS NULL)),
    FOREIGN KEY (timeline_id, owner_id) REFERENCES timelines(id, owner_id) ON DELETE RESTRICT,
    FOREIGN KEY (asset_id, owner_id) REFERENCES assets(id, owner_id) ON DELETE RESTRICT
);
CREATE INDEX idx_distribution_links_owner_created ON distribution_links(owner_id, created_at DESC, id DESC);
CREATE INDEX idx_distribution_links_timeline ON distribution_links(timeline_id);
CREATE INDEX idx_distribution_links_asset ON distribution_links(asset_id, active);

-- Copy before installing quota/readiness guards: existing Links may exceed a newly lowered quota
-- or point to a Timeline whose visibility has changed since creation.
INSERT INTO distribution_links(id, owner_id, slug, target_kind, target_url, timeline_id, active, expires_at, created_at, updated_at)
SELECT id, owner_id, slug, target_kind, target_url, timeline_id, active, expires_at, created_at, updated_at FROM links;

CREATE TABLE reserved_link_slugs (
    slug TEXT PRIMARY KEY NOT NULL CHECK (length(slug) BETWEEN 3 AND 64 AND slug NOT GLOB '*[^a-z0-9-]*')
);
INSERT INTO reserved_link_slugs(slug) SELECT slug FROM distribution_links;
CREATE TRIGGER reserved_link_slugs_no_update BEFORE UPDATE ON reserved_link_slugs
BEGIN SELECT RAISE(ABORT, 'immutable_slug_reservation'); END;
CREATE TRIGGER reserved_link_slugs_no_delete BEFORE DELETE ON reserved_link_slugs
BEGIN SELECT RAISE(ABORT, 'immutable_slug_reservation'); END;
CREATE TRIGGER distribution_links_reserve_slug BEFORE INSERT ON distribution_links
BEGIN INSERT INTO reserved_link_slugs(slug) VALUES(NEW.slug); END;

CREATE TRIGGER legacy_links_no_insert BEFORE INSERT ON links
BEGIN SELECT RAISE(ABORT, 'legacy_links_read_only'); END;
CREATE TRIGGER legacy_links_no_update BEFORE UPDATE ON links
BEGIN SELECT RAISE(ABORT, 'legacy_links_read_only'); END;
CREATE TRIGGER legacy_links_no_delete BEFORE DELETE ON links
BEGIN SELECT RAISE(ABORT, 'legacy_links_read_only'); END;

CREATE TRIGGER distribution_links_quota BEFORE INSERT ON distribution_links
WHEN NOT EXISTS (SELECT 1 FROM usage_quotas q WHERE q.user_id = NEW.owner_id
    AND (SELECT count(*) FROM distribution_links WHERE owner_id = NEW.owner_id) < q.link_limit)
BEGIN SELECT RAISE(ABORT, 'link_quota_exceeded'); END;
CREATE TRIGGER distribution_links_immutable_identity BEFORE UPDATE ON distribution_links
WHEN OLD.id != NEW.id OR OLD.owner_id != NEW.owner_id OR OLD.slug != NEW.slug
    OR OLD.target_kind != NEW.target_kind OR OLD.target_url IS NOT NEW.target_url
    OR OLD.timeline_id IS NOT NEW.timeline_id OR OLD.asset_id IS NOT NEW.asset_id
BEGIN SELECT RAISE(ABORT, 'immutable_link_identity'); END;
CREATE TRIGGER distribution_links_visible_timeline BEFORE INSERT ON distribution_links
WHEN NEW.target_kind = 'timeline' AND NOT EXISTS (SELECT 1 FROM timelines
    WHERE id = NEW.timeline_id AND owner_id = NEW.owner_id AND visibility IN ('unlisted', 'public'))
BEGIN SELECT RAISE(ABORT, 'invalid_link_timeline'); END;
CREATE TRIGGER distribution_links_ready_asset BEFORE INSERT ON distribution_links
WHEN NEW.target_kind = 'asset' AND NOT EXISTS (SELECT 1 FROM assets
    WHERE id = NEW.asset_id AND owner_id = NEW.owner_id AND status = 'ready' AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_link_asset'); END;
CREATE TRIGGER distribution_links_reactivate_asset BEFORE UPDATE OF active ON distribution_links
WHEN NEW.active = 1 AND OLD.active = 0 AND NEW.target_kind = 'asset' AND NOT EXISTS (SELECT 1 FROM assets
    WHERE id = NEW.asset_id AND owner_id = NEW.owner_id AND status = 'ready' AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid_link_asset'); END;
CREATE TRIGGER assets_active_link_guard BEFORE UPDATE OF status, deleted_at ON assets
WHEN (NEW.status != 'ready' OR NEW.deleted_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM distribution_links WHERE asset_id = OLD.id AND active = 1)
BEGIN SELECT RAISE(ABORT, 'asset_referenced_by_link'); END;
