-- 244_add_hanja_to_list_items_check.sql
-- Allow 'hanja' as an item_type in list_items.

ALTER TABLE list_items DROP CONSTRAINT IF EXISTS list_items_item_type_check;
ALTER TABLE list_items ADD CONSTRAINT list_items_item_type_check
    CHECK (item_type IN ('sentence', 'pattern', 'vocabulary', 'hanja'));
