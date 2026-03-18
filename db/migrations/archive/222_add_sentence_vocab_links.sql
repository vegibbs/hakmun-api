-- Migration: Add sentence_vocab_links table and ensure pool columns exist
-- Purpose: Link AI-generated sentences to the teaching vocabulary they contain,
--          enabling the rotation engine to find sentences by vocabulary word.
--
-- When a teacher bumps a word's rotation weight for a student, the rotation
-- engine queries sentence_vocab_links to find sentences containing that word
-- and prioritizes them in practice sessions.

-- 1. Ensure content_items has politeness and tense columns
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS politeness VARCHAR(20);
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS tense VARCHAR(20);

-- 2. Index for pool combination queries (the sweep query)
CREATE INDEX IF NOT EXISTS idx_content_items_pool_combo
    ON content_items (cefr_level, politeness, tense)
    WHERE content_type = 'sentence';

-- 3. Sentence <> Vocabulary link table
--    Bridges content_items (sentences) to teaching_vocab (words).
--    This is intentionally a cross-table link because sentences live in
--    content_items but vocabulary lives in teaching_vocab.
CREATE TABLE IF NOT EXISTS sentence_vocab_links (
    sentence_vocab_link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The sentence (lives in content_items)
    sentence_content_item_id UUID NOT NULL
        REFERENCES content_items(content_item_id) ON DELETE CASCADE,

    -- The vocabulary word (lives in teaching_vocab)
    teaching_vocab_id UUID NOT NULL
        REFERENCES teaching_vocab(id) ON DELETE CASCADE,

    -- When this link was created
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Prevent duplicate links
    UNIQUE (sentence_content_item_id, teaching_vocab_id)
);

-- Index for "find all sentences containing this vocab word"
-- This is the primary query the rotation engine uses:
--   "Teacher bumped a word to weight 5 -> find sentences with that word"
CREATE INDEX IF NOT EXISTS idx_svl_by_vocab
    ON sentence_vocab_links (teaching_vocab_id);

-- Index for "find all vocab words in this sentence"
-- Used for sentence detail views and analytics
CREATE INDEX IF NOT EXISTS idx_svl_by_sentence
    ON sentence_vocab_links (sentence_content_item_id);