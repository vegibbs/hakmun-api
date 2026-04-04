-- Migration 015: Create collaboration tables
-- Channels, members, messages with AI translations for team communication.

CREATE TABLE IF NOT EXISTS channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    description text,
    created_by uuid NOT NULL REFERENCES users(user_id),
    is_archived boolean DEFAULT false,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(user_id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member',            -- 'admin', 'member'
    joined_at timestamptz DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_user_id uuid NOT NULL REFERENCES users(user_id),
    original_text text NOT NULL,
    original_language text,
    translation_status text NOT NULL DEFAULT 'pending',  -- pending, complete, failed
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_translations (
    message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
    language text NOT NULL,
    translated_text text NOT NULL,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (message_id, language)
);

CREATE TABLE IF NOT EXISTS message_media (
    message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
    media_id uuid REFERENCES media(id) ON DELETE CASCADE,
    sort_order integer DEFAULT 0,
    PRIMARY KEY (message_id, media_id)
);

CREATE TABLE IF NOT EXISTS channel_translations (
    channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
    language text NOT NULL,
    name text NOT NULL,
    description text,
    PRIMARY KEY (channel_id, language)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);
