-- Migration 025: Reset AI-generated global content to preliminary
--
-- AI-generated sentences were inserted as 'approved', bypassing the
-- approval workflow. This resets all global items that were never
-- explicitly reviewed (last_reviewed_by IS NULL) back to 'preliminary'.

UPDATE library_registry_items
SET global_state = 'preliminary',
    updated_at = now()
WHERE audience = 'global'
  AND global_state = 'approved'
  AND last_reviewed_by IS NULL;
