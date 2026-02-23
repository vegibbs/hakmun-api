-- 241_add_source_label_to_media_assets.sql
-- Adds source_label to media_assets so audio recordings can be attributed
-- (e.g., "Zuri" recorded this audio for a sentence from a document).

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS source_label TEXT;
