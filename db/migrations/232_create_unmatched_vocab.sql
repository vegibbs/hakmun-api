-- 232_create_unmatched_vocab.sql
-- Staging table for vocabulary lemmas encountered during document import
-- that don't match any teaching_vocab entry. Mirrors unmatched_grammar_patterns.
-- Reviewed and resolved through the vocab matcher admin UI.

CREATE TABLE IF NOT EXISTS unmatched_vocab (
    unmatched_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    document_id     UUID REFERENCES documents(document_id) ON DELETE SET NULL,
    lemma           TEXT NOT NULL,
    pos             TEXT,
    context_span    TEXT,
    count           INTEGER NOT NULL DEFAULT 1,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_unmatched_vocab_user_lemma UNIQUE (owner_user_id, lemma)
);

CREATE INDEX idx_unmatched_vocab_user ON unmatched_vocab(owner_user_id);
CREATE INDEX idx_unmatched_vocab_lemma ON unmatched_vocab(lemma);
