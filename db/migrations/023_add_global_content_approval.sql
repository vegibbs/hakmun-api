-- 023_add_global_content_approval.sql
-- Add audit columns to library_registry_items for the approval workflow.
-- global_state already exists on library_registry_items — just add review/edit tracking.

-- Audit columns for approval workflow
ALTER TABLE library_registry_items
  ADD COLUMN IF NOT EXISTS last_reviewed_by uuid REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_edited_by uuid REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS last_edited_at timestamptz;

-- Backfill: ensure all global items that lack a global_state are set to preliminary.
-- (Existing constraint requires global_state IS NOT NULL for audience='global',
--  so this is a safety net for any rows that slipped through.)
UPDATE library_registry_items
SET global_state = 'preliminary'
WHERE audience = 'global'
  AND global_state IS NULL;

-- Grant DML on new columns to the app user
GRANT SELECT, INSERT, UPDATE, DELETE ON library_registry_items TO hakmun_app;
