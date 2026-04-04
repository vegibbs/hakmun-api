-- Migration 013: Create media table for shared file uploads
-- Used by bug reports and collaboration messages.

CREATE TABLE IF NOT EXISTS media (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(user_id),
    context text NOT NULL,                    -- 'bug_report', 'message'
    object_key text NOT NULL,                 -- S3 key
    content_type text NOT NULL,
    size_bytes integer,
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_user_id);
