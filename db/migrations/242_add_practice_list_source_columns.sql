-- 242_add_practice_list_source_columns.sql
-- Add source tracking columns to lists for practice list generation.

ALTER TABLE lists ADD COLUMN IF NOT EXISTS source_kind VARCHAR(40);
ALTER TABLE lists ADD COLUMN IF NOT EXISTS source_document_id UUID
  REFERENCES documents(document_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lists_source_document
  ON lists(user_id, source_document_id)
  WHERE source_document_id IS NOT NULL;
