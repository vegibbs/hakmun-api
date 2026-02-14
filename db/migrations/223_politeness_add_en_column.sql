-- 223_politeness_add_en_column.sql
-- Add politeness_en column derived from the Korean politeness value.
-- The politeness column stores canonical Korean (해요체, 합니다체, 반말).
-- politeness_en stores the English label for display in the user's language.

ALTER TABLE content_items ADD COLUMN IF NOT EXISTS politeness_en VARCHAR(30);
