-- 020: Per-paragraph translation cache for collab topics
-- Caches individual paragraph translations so only changed paragraphs hit the API

CREATE TABLE IF NOT EXISTS collab_paragraph_cache (
    source_hash text NOT NULL,
    source_lang text NOT NULL,
    target_lang text NOT NULL,
    translated_text text NOT NULL,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (source_hash, source_lang, target_lang)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON collab_paragraph_cache TO hakmun_app;
