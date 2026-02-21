-- 230_linked_profiles.sql
-- Allows a root admin to link multiple user profiles to a single Apple identity.
-- Enables persistent profile switching (replaces ephemeral impersonation).

CREATE TABLE IF NOT EXISTS linked_profiles (
    apple_sub       TEXT NOT NULL,
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    label           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (apple_sub, user_id)
);

CREATE INDEX IF NOT EXISTS idx_linked_profiles_user ON linked_profiles(user_id);
