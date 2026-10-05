CREATE TABLE tracking_provider_settings (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    ga4_measurement_id TEXT CHECK (
        ga4_measurement_id IS NULL OR (
            substr(ga4_measurement_id, 1, 2) = 'G-' AND
            length(ga4_measurement_id) BETWEEN 3 AND 22 AND
            substr(ga4_measurement_id, 3) NOT GLOB '*[^A-Z0-9]*'
        )
    ),
    meta_pixel_id TEXT CHECK (
        meta_pixel_id IS NULL OR (
            length(meta_pixel_id) BETWEEN 1 AND 30 AND
            meta_pixel_id NOT GLOB '*[^0-9]*'
        )
    ),
    gtm_container_id TEXT CHECK (
        gtm_container_id IS NULL OR (
            substr(gtm_container_id, 1, 4) = 'GTM-' AND
            length(gtm_container_id) BETWEEN 5 AND 24 AND
            substr(gtm_container_id, 5) NOT GLOB '*[^A-Z0-9]*'
        )
    ),
    ga4_route TEXT NOT NULL DEFAULT 'direct' CHECK (ga4_route IN ('direct', 'gtm')),
    meta_route TEXT NOT NULL DEFAULT 'direct' CHECK (meta_route IN ('direct', 'gtm')),
    CHECK (ga4_route = 'direct' OR gtm_container_id IS NOT NULL),
    CHECK (meta_route = 'direct' OR gtm_container_id IS NOT NULL)
);

ALTER TABLE distribution_links ADD COLUMN allow_ga4 INTEGER NOT NULL DEFAULT 1
    CHECK (allow_ga4 IN (0, 1));
ALTER TABLE distribution_links ADD COLUMN allow_meta_pixel INTEGER NOT NULL DEFAULT 1
    CHECK (allow_meta_pixel IN (0, 1));
ALTER TABLE distribution_links ADD COLUMN allow_gtm INTEGER NOT NULL DEFAULT 1
    CHECK (allow_gtm IN (0, 1));

CREATE TABLE tracking_tickets (
    token_hash TEXT PRIMARY KEY NOT NULL,
    link_id TEXT NOT NULL REFERENCES distribution_links(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('url', 'timeline', 'asset')),
    event_json TEXT NOT NULL CHECK (
        length(event_json) <= 4096 AND
        json_valid(event_json) AND json_type(event_json) = 'object'
    ),
    providers_json TEXT NOT NULL CHECK (
        length(providers_json) <= 2048 AND
        json_valid(providers_json) AND json_type(providers_json) = 'object'
    ),
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX idx_tracking_tickets_expiry
ON tracking_tickets(expires_at, token_hash);
