-- Migration 016: Add last_read_at to channel_members for unread tracking

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS last_read_at timestamptz DEFAULT now();
