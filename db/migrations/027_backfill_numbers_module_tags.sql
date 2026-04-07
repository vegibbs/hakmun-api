-- 027_backfill_numbers_module_tags.sql
-- Backfill module_tags on library_registry_items for numbers drill content.
-- The seed migration (003) predated the module_tags column (024), so these
-- items have tags on content_items but empty module_tags on their LRI entries.
--
-- Derives module_tags from content_items.tags:
--   section:time        → "numbers:time"
--   section:counters    → "numbers:counters"
--   section:real_estate → "numbers:real_estate"
--   section:numbers     → "numbers:numbers"

UPDATE library_registry_items lri
SET module_tags = (
  SELECT jsonb_agg('numbers:' || substring(tag FROM 'section:(.+)'))
  FROM content_items ci,
       unnest(ci.tags) AS tag
  WHERE ci.content_item_id = lri.content_id
    AND ci.content_type = lri.content_type
    AND 'module:numbers' = ANY(ci.tags)
    AND tag LIKE 'section:%'
)
WHERE lri.content_id IN (
  SELECT ci.content_item_id
  FROM content_items ci
  WHERE 'module:numbers' = ANY(ci.tags)
)
AND (lri.module_tags IS NULL OR lri.module_tags = '[]'::jsonb);
