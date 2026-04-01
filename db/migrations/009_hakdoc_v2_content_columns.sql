-- 009_hakdoc_v2_content_columns.sql
-- Add content storage columns for HakDoc v2 (S3-backed document content).
-- raw_text stays for v1 backward compatibility.

ALTER TABLE hakdocs ADD COLUMN IF NOT EXISTS content_key TEXT;
ALTER TABLE hakdocs ADD COLUMN IF NOT EXISTS content_version INTEGER DEFAULT 0;
ALTER TABLE hakdocs ADD COLUMN IF NOT EXISTS content_format TEXT DEFAULT 'v1';
