-- 234_add_user_preferences.sql
-- Add user profile preference columns: language, privacy, location, CEFR level.

-- Language preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_language text NOT NULL DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gloss_language text NOT NULL DEFAULT 'en';

-- Privacy switches (global defaults; per-teacher overrides come with classes)
ALTER TABLE users ADD COLUMN IF NOT EXISTS customize_learning boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_progress_default boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_teacher_adjust_default boolean NOT NULL DEFAULT false;

-- Location
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_city text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_country text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_city boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_country boolean NOT NULL DEFAULT false;

-- CEFR levels
ALTER TABLE users ADD COLUMN IF NOT EXISTS cefr_current text NOT NULL DEFAULT 'A1';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cefr_target text;
