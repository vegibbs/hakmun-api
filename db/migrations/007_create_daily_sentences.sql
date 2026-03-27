-- 007: Create daily_sentences table for teacher-assigned sentence of the day overrides.
-- When a row exists for a given date, it takes priority over the deterministic global pick.

CREATE TABLE IF NOT EXISTS daily_sentences (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    sentence_date date NOT NULL,
    content_item_id uuid NOT NULL REFERENCES content_items(content_item_id),
    assigned_by uuid NOT NULL REFERENCES users(user_id),
    created_at timestamptz DEFAULT now(),
    CONSTRAINT daily_sentences_date_unique UNIQUE (sentence_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_sentences_date ON daily_sentences (sentence_date);
