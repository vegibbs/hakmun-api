-- 018: Add content column to collab_topics for single-document model
-- Also adds collab_topic_translations table for per-paragraph translation

ALTER TABLE collab_topics ADD COLUMN IF NOT EXISTS content text DEFAULT '';
ALTER TABLE collab_topics ADD COLUMN IF NOT EXISTS content_hash text;

CREATE TABLE IF NOT EXISTS collab_topic_translations (
    topic_id uuid REFERENCES collab_topics(id) ON DELETE CASCADE,
    language text NOT NULL,
    translated_text text NOT NULL,
    source_hash text NOT NULL,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (topic_id, language)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON collab_topic_translations TO hakmun_app;
