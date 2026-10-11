CREATE TABLE content_edges (
    id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL REFERENCES content_nodes(id) ON DELETE RESTRICT,
    target_id TEXT NOT NULL REFERENCES content_nodes(id) ON DELETE RESTRICT,
    type TEXT NOT NULL CHECK (type IN ('related_to', 'references', 'continuation')),
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    accepted_at TEXT,
    suppressed_at TEXT,
    target_owner_blocked_at TEXT,
    admin_blocked INTEGER NOT NULL DEFAULT 0 CHECK (admin_blocked IN (0, 1)),
    removed_at TEXT,
    created_at TEXT NOT NULL,
    CHECK (source_id != target_id)
);
CREATE UNIQUE INDEX idx_content_edges_live_triple
    ON content_edges(source_id, target_id, type)
    WHERE removed_at IS NULL;
CREATE INDEX idx_content_edges_source_created
    ON content_edges(source_id, created_at DESC, id DESC)
    WHERE removed_at IS NULL;
CREATE INDEX idx_content_edges_target_created
    ON content_edges(target_id, created_at DESC, id DESC)
    WHERE removed_at IS NULL;

CREATE TRIGGER content_edges_source_owner_insert
    BEFORE INSERT ON content_edges
    WHEN NOT EXISTS (
        SELECT 1 FROM content_nodes
        WHERE id = NEW.source_id AND owner_id = NEW.creator_id
    )
    BEGIN SELECT RAISE(ABORT, 'content_edge_creator_must_own_source'); END;

CREATE TABLE content_edge_moderation_events (
    id TEXT PRIMARY KEY NOT NULL,
    moderator_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    edge_id TEXT NOT NULL REFERENCES content_edges(id) ON DELETE RESTRICT,
    previous_blocked INTEGER NOT NULL CHECK (previous_blocked IN (0, 1)),
    blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL,
    CHECK (previous_blocked != blocked)
);
CREATE INDEX idx_content_edge_moderation_events_edge
    ON content_edge_moderation_events(edge_id, created_at, id);
CREATE TRIGGER content_edge_moderation_events_no_update
    BEFORE UPDATE ON content_edge_moderation_events
    BEGIN SELECT RAISE(ABORT, 'immutable_content_edge_moderation_event'); END;
CREATE TRIGGER content_edge_moderation_events_no_delete
    BEFORE DELETE ON content_edge_moderation_events
    BEGIN SELECT RAISE(ABORT, 'immutable_content_edge_moderation_event'); END;

CREATE TABLE content_edge_reports (
    id TEXT PRIMARY KEY NOT NULL,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    edge_id TEXT NOT NULL REFERENCES content_edges(id) ON DELETE RESTRICT,
    category TEXT NOT NULL CHECK (category IN ('spam', 'abuse', 'copyright', 'illegal', 'other')),
    detail TEXT NOT NULL CHECK (length(detail) <= 1000),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_content_edge_reports_reporter_created
    ON content_edge_reports(reporter_id, created_at);
CREATE INDEX idx_content_edge_reports_reporter_edge_created
    ON content_edge_reports(reporter_id, edge_id, created_at);
CREATE INDEX idx_content_edge_reports_created
    ON content_edge_reports(created_at DESC, id DESC);
CREATE TRIGGER content_edge_reports_no_update
    BEFORE UPDATE ON content_edge_reports
    BEGIN SELECT RAISE(ABORT, 'immutable_content_edge_report'); END;
CREATE TRIGGER content_edge_reports_no_delete
    BEFORE DELETE ON content_edge_reports
    BEGIN SELECT RAISE(ABORT, 'immutable_content_edge_report'); END;
