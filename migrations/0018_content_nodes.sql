CREATE UNIQUE INDEX idx_timelines_id_owner_unique ON timelines(id, owner_id);

CREATE TABLE content_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('timeline', 'external')),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    timeline_id TEXT,
    url TEXT,
    title TEXT CHECK (title IS NULL OR length(title) <= 200),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT,
    moderation_blocked INTEGER NOT NULL DEFAULT 0 CHECK (moderation_blocked IN (0, 1)),
    CHECK (
      (kind = 'timeline' AND timeline_id IS NOT NULL AND url IS NULL AND title IS NULL)
      OR (kind = 'external' AND timeline_id IS NULL AND url IS NOT NULL)
    ),
    FOREIGN KEY (timeline_id, owner_id) REFERENCES timelines(id, owner_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_content_nodes_live_timeline
    ON content_nodes(owner_id, timeline_id)
    WHERE kind = 'timeline' AND removed_at IS NULL;
CREATE INDEX idx_content_nodes_owner_live_created
    ON content_nodes(owner_id, created_at DESC, id DESC)
    WHERE removed_at IS NULL;
CREATE INDEX idx_content_nodes_owner_removed_created
    ON content_nodes(owner_id, created_at DESC, id DESC)
    WHERE removed_at IS NOT NULL;

CREATE TABLE content_node_moderation_events (
    id TEXT PRIMARY KEY NOT NULL,
    moderator_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    node_id TEXT NOT NULL,
    previous_blocked INTEGER NOT NULL CHECK (previous_blocked IN (0, 1)),
    blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL,
    CHECK (previous_blocked != blocked)
);
CREATE INDEX idx_content_node_moderation_events_node
    ON content_node_moderation_events(node_id, created_at, id);
CREATE TRIGGER content_node_moderation_events_no_update
    BEFORE UPDATE ON content_node_moderation_events
    BEGIN SELECT RAISE(ABORT, 'immutable_content_node_moderation_event'); END;
CREATE TRIGGER content_node_moderation_events_no_delete
    BEFORE DELETE ON content_node_moderation_events
    BEGIN SELECT RAISE(ABORT, 'immutable_content_node_moderation_event'); END;
