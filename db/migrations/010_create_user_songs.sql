-- Migration 010: Create user_songs table
--
-- Stores per-user song metadata and lyrics/timings. Migrates data previously
-- stored as local JSON files on device (UserLyricsStore). Each row represents
-- one song a user has added, with lyrics lines stored as JSONB.

CREATE TABLE IF NOT EXISTS user_songs (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id   UUID            NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    title           TEXT            NOT NULL,
    artist_name     TEXT            NOT NULL,
    album_title     TEXT,
    apple_music_id  TEXT,
    is_manual       BOOLEAN         NOT NULL DEFAULT false,
    lines           JSONB,          -- [{ko, literal, natural, startMs, endMs}]
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Each user can have at most one entry per Apple Music ID
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_songs_owner_apple
    ON user_songs (owner_user_id, apple_music_id)
    WHERE apple_music_id IS NOT NULL;

-- Fast lookup of all songs for a user
CREATE INDEX IF NOT EXISTS idx_user_songs_owner
    ON user_songs (owner_user_id, updated_at DESC);
