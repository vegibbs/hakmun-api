-- 243_create_user_feature_flags.sql
-- Per-user feature visibility flags, admin-controlled.
-- No rows = all defaults (everything enabled per role).

CREATE TABLE IF NOT EXISTS user_feature_flags (
    user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    flag_key    TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, flag_key)
);

CREATE INDEX IF NOT EXISTS idx_user_feature_flags_user
    ON user_feature_flags(user_id);
