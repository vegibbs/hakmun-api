-- 233_add_display_name_to_users.sql
-- Add optional display name to users table for profile settings.
-- Nullable — users without a display name show their handle.

ALTER TABLE users ADD COLUMN display_name text;
