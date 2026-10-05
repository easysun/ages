CREATE TABLE link_daily_totals (
    link_id TEXT NOT NULL,
    day TEXT NOT NULL CHECK (
        length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    clicks INTEGER NOT NULL CHECK (clicks > 0),
    PRIMARY KEY (link_id, day),
    FOREIGN KEY (link_id) REFERENCES distribution_links(id) ON DELETE CASCADE
);

CREATE TABLE link_daily_channels (
    link_id TEXT NOT NULL,
    day TEXT NOT NULL CHECK (
        length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('configured', 'other')),
    channel_label TEXT COLLATE BINARY,
    bucket_key TEXT COLLATE BINARY NOT NULL,
    clicks INTEGER NOT NULL CHECK (clicks > 0),
    CHECK (
        (bucket_kind = 'configured' AND channel_label IS NOT NULL AND bucket_key = 'c:' || channel_label)
        OR (bucket_kind = 'other' AND channel_label IS NULL AND bucket_key = 'o:')
    ),
    PRIMARY KEY (link_id, day, bucket_key),
    FOREIGN KEY (link_id) REFERENCES distribution_links(id) ON DELETE CASCADE
);

CREATE TABLE link_daily_referrers (
    link_id TEXT NOT NULL,
    day TEXT NOT NULL CHECK (
        length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('host', 'other', 'direct')),
    hostname TEXT COLLATE BINARY,
    bucket_key TEXT COLLATE BINARY NOT NULL,
    clicks INTEGER NOT NULL CHECK (clicks > 0),
    CHECK (
        (bucket_kind = 'host' AND hostname IS NOT NULL AND bucket_key = 'h:' || hostname)
        OR (bucket_kind = 'other' AND hostname IS NULL AND bucket_key = 'o:')
        OR (bucket_kind = 'direct' AND hostname IS NULL AND bucket_key = 'd:')
    ),
    PRIMARY KEY (link_id, day, bucket_key),
    FOREIGN KEY (link_id) REFERENCES distribution_links(id) ON DELETE CASCADE
);
