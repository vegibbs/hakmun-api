-- 246_add_tos_acceptance.sql
-- Track Terms of Service acceptance per user.

ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_tos_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accepted_tos_at TIMESTAMPTZ;
