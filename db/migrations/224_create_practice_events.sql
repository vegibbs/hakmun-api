-- 224_create_practice_events.sql
-- Persist practice events (presented, submitted, advanced, etc.) for teacher access and cross-device sync.

CREATE TABLE practice_events (
    event_id       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES users(user_id),
    ts             TIMESTAMPTZ NOT NULL,
    domain         TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    item_ids       TEXT[] NOT NULL DEFAULT '{}',
    source         TEXT,
    meta           JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_practice_events_dedup
    ON practice_events (user_id, ts, domain, event_type, item_ids);

CREATE INDEX idx_practice_events_user_ts ON practice_events (user_id, ts DESC);
CREATE INDEX idx_practice_events_user_domain ON practice_events (user_id, domain, ts DESC);
