-- 008_documents_nullable_asset_and_source_kinds.sql
-- Allow NULL asset_id for non-file-backed documents (HakDoc, paste imports).
-- Expand source_kind CHECK to include 'hakdoc' and 'paste'.

-- 1. Drop NOT NULL on asset_id
ALTER TABLE documents ALTER COLUMN asset_id DROP NOT NULL;

-- 2. Replace source_kind CHECK constraint to include new kinds
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_kind_check
  CHECK (source_kind = ANY (ARRAY['upload', 'google_doc', 'hakdoc', 'paste', 'other']));
