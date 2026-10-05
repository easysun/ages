CREATE UNIQUE INDEX idx_distribution_links_identity
ON distribution_links(id, owner_id);

CREATE TABLE link_tracking_settings (
    link_id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    custom_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(custom_json) AND json_type(custom_json) = 'array'),
    FOREIGN KEY (link_id, owner_id)
        REFERENCES distribution_links(id, owner_id) ON DELETE CASCADE
);

CREATE TABLE link_tags (
    link_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    tag TEXT NOT NULL COLLATE BINARY,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
    PRIMARY KEY (link_id, owner_id, tag),
    UNIQUE (link_id, owner_id, position),
    FOREIGN KEY (link_id, owner_id)
        REFERENCES distribution_links(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX idx_link_tags_owner_tag_link
ON link_tags(owner_id, tag, link_id);

CREATE TABLE link_channels (
    link_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    channel TEXT NOT NULL COLLATE BINARY,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
    PRIMARY KEY (link_id, owner_id, channel),
    UNIQUE (link_id, owner_id, position),
    FOREIGN KEY (link_id, owner_id)
        REFERENCES distribution_links(id, owner_id) ON DELETE CASCADE
);
