-- 229_content_item_grammar_links.sql
-- Many-to-many join table linking content_items to grammar_patterns.
-- Replaces the single FK content_items.grammar_pattern_id with a richer model
-- that supports one content item demonstrating multiple patterns.

CREATE TABLE IF NOT EXISTS content_item_grammar_links (
    content_item_id     UUID NOT NULL REFERENCES content_items(content_item_id) ON DELETE CASCADE,
    grammar_pattern_id  UUID NOT NULL REFERENCES grammar_patterns(id) ON DELETE CASCADE,
    role                TEXT NOT NULL DEFAULT 'primary',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (content_item_id, grammar_pattern_id)
);

CREATE INDEX IF NOT EXISTS idx_cigl_pattern ON content_item_grammar_links(grammar_pattern_id);

-- Backfill: copy existing content_items.grammar_pattern_id into the join table
INSERT INTO content_item_grammar_links (content_item_id, grammar_pattern_id, role)
SELECT content_item_id, grammar_pattern_id, 'primary'
FROM content_items
WHERE grammar_pattern_id IS NOT NULL
ON CONFLICT DO NOTHING;
