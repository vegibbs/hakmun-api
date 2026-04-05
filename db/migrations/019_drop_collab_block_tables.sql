-- 019: Drop legacy collab block tables (replaced by single-document model in 018)
-- The collab_topic_blocks and collab_block_translations tables are no longer used.
-- Content is now stored directly on collab_topics.content with translations in collab_topic_translations.

DROP INDEX IF EXISTS idx_collab_blocks_topic;

DROP TABLE IF EXISTS collab_block_translations;
DROP TABLE IF EXISTS collab_topic_blocks;
