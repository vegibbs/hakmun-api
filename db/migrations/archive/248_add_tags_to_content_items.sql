-- 248: Add tags column to content_items + GIN indexes for tag-based filtering.
-- Used by the Numbers drill module (and future modules) to tag content by module/section/subsection.

ALTER TABLE content_items ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_content_items_tags ON content_items USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_teaching_vocab_tags ON teaching_vocab USING GIN (tags);
