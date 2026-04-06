-- 024_add_module_tags_and_inactive_status.sql
-- Phase 2: Add module_tags to library_registry_items for teacher-assigned module routing.
-- Also update the operational_status constraint to allow 'inactive'.

-- Add module_tags column (JSONB array of strings, e.g. ["numbers:time", "numbers:counters"])
ALTER TABLE library_registry_items
  ADD COLUMN IF NOT EXISTS module_tags jsonb DEFAULT '[]'::jsonb;

-- Update operational_status constraint to allow 'inactive'
-- Drop old constraint and add new one
ALTER TABLE library_registry_items
  DROP CONSTRAINT IF EXISTS library_registry_items_operational_status_check;

ALTER TABLE library_registry_items
  ADD CONSTRAINT library_registry_items_operational_status_check
    CHECK (operational_status = ANY (ARRAY['active'::text, 'under_review'::text, 'inactive'::text]));

-- Grant DML (already granted in 023, but safety net)
GRANT SELECT, INSERT, UPDATE, DELETE ON library_registry_items TO hakmun_app;
