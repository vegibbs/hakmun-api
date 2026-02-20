-- 227_pattern_matching_support.sql
-- Wire up pattern matching: add grammar_pattern_id to content_items so imported
-- patterns can link to the canonical grammar_patterns table, and create the
-- unmatched_grammar_patterns table for logging surface forms that don't match
-- any known alias.

-- 1) Nullable FK on content_items → grammar_patterns
ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS grammar_pattern_id UUID
  REFERENCES grammar_patterns(id) ON DELETE SET NULL;

-- Partial index: only rows that have a match (most content_items are sentences)
CREATE INDEX IF NOT EXISTS idx_content_items_grammar_pattern
  ON content_items(grammar_pattern_id)
  WHERE grammar_pattern_id IS NOT NULL;

-- 2) Staging table for patterns the alias lookup couldn't resolve.
-- The commit endpoint already has SAVEPOINT code that writes here;
-- until now the table didn't exist so the insert silently failed.
CREATE TABLE IF NOT EXISTS unmatched_grammar_patterns (
    unmatched_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    document_id     UUID REFERENCES documents(document_id) ON DELETE SET NULL,
    surface_form    TEXT NOT NULL,
    alias_norm      TEXT NOT NULL,
    context_span    TEXT,
    count           INTEGER NOT NULL DEFAULT 1,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint that the existing ON CONFLICT clause depends on
ALTER TABLE unmatched_grammar_patterns
  ADD CONSTRAINT uq_unmatched_user_alias UNIQUE (owner_user_id, alias_norm);

CREATE INDEX idx_unmatched_grammar_user
  ON unmatched_grammar_patterns(owner_user_id);

CREATE INDEX idx_unmatched_grammar_norm
  ON unmatched_grammar_patterns(alias_norm);
