-- 236_create_practice_completions.sql
-- Journal of completed practice items. One row per completion (same item can be completed multiple times).
-- User-facing: powers the Practice Journal view.

CREATE TABLE IF NOT EXISTS practice_completions (
    completion_id   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(user_id),
    item_id         TEXT NOT NULL,
    module          TEXT NOT NULL,               -- 'writing', 'reading', 'listening'
    completed_at    TIMESTAMPTZ NOT NULL,
    cefr_level      TEXT,
    topic           TEXT,
    source_lesson   TEXT,
    meta            JSONB,                       -- module-specific: score, mode, input, etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_practice_completions_dedup
    ON practice_completions (user_id, item_id, module, completed_at);

CREATE INDEX IF NOT EXISTS idx_practice_completions_user_time
    ON practice_completions (user_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_practice_completions_user_module
    ON practice_completions (user_id, module, completed_at DESC);
