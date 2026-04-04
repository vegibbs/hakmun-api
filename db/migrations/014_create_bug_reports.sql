-- Migration 014: Create bug_reports and bug_report_media tables
-- In-app bug reporting with GitHub Issue integration.

CREATE TABLE IF NOT EXISTS bug_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(user_id),
    tracking_number serial,
    status text NOT NULL DEFAULT 'draft',          -- draft, submitted, closed
    what_happened text,
    what_expected text,
    original_language text,                        -- auto-detected or user-specified
    translated_what_happened text,                 -- English translation (if original wasn't English)
    translated_what_expected text,
    app_context jsonb,                             -- {module, platform, app_version, os_version}
    github_issue_number integer,                   -- set after GitHub Issue is created
    github_issue_url text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bug_tracking ON bug_reports(tracking_number);

-- Junction table for attachments
CREATE TABLE IF NOT EXISTS bug_report_media (
    bug_report_id uuid REFERENCES bug_reports(id) ON DELETE CASCADE,
    media_id uuid REFERENCES media(id) ON DELETE CASCADE,
    sort_order integer DEFAULT 0,
    PRIMARY KEY (bug_report_id, media_id)
);
