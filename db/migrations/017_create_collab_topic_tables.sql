-- Migration 017: Collaboration topics (class-scoped translated notebooks)

CREATE TABLE IF NOT EXISTS collab_topics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id uuid NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
    title text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(user_id),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collab_topic_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id uuid NOT NULL REFERENCES collab_topics(id) ON DELETE CASCADE,
    author_user_id uuid NOT NULL REFERENCES users(user_id),
    content_type text NOT NULL DEFAULT 'text',
    content_text text,
    media_id uuid REFERENCES media(id),
    content_hash text,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collab_block_translations (
    block_id uuid REFERENCES collab_topic_blocks(id) ON DELETE CASCADE,
    language text NOT NULL,
    translated_text text NOT NULL,
    source_hash text NOT NULL,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (block_id, language)
);

CREATE TABLE IF NOT EXISTS collab_topic_reads (
    topic_id uuid REFERENCES collab_topics(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(user_id) ON DELETE CASCADE,
    last_read_at timestamptz DEFAULT now(),
    PRIMARY KEY (topic_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_collab_topics_class ON collab_topics(class_id);
CREATE INDEX IF NOT EXISTS idx_collab_blocks_topic ON collab_topic_blocks(topic_id, sort_order);

-- Grant DML to app user
GRANT SELECT, INSERT, UPDATE, DELETE ON collab_topics TO hakmun_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON collab_topic_blocks TO hakmun_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON collab_block_translations TO hakmun_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON collab_topic_reads TO hakmun_app;
