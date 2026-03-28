-- 006: Add source_texts column to documents table
-- Stores the original highlighted text lines from Google Doc imports.
-- These are used for highlight matching when the AI-generated sentences
-- differ from the original teacher notes.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_texts text[] DEFAULT '{}';
