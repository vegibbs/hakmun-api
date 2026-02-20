-- 226_create_document_fragments.sql
-- Document fragments: blobs of highlighted teaching material tied to a document.
-- Fragments are raw classroom notes, grammar breakdowns, and example scaffolds
-- that aren't complete sentences or pluggable patterns. They serve as seeds
-- for AI-generated practice content but don't appear in the content items pool.

CREATE TABLE IF NOT EXISTS document_fragments (
    fragment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_date DATE,
    text TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query: fragments for a document (document viewer Fragments tab)
CREATE INDEX idx_doc_fragments_document ON document_fragments(document_id);

-- Filtered by session date within a document
CREATE INDEX idx_doc_fragments_doc_session ON document_fragments(document_id, session_date);

-- All fragments for a user (future: class-level views)
CREATE INDEX idx_doc_fragments_user ON document_fragments(owner_user_id);
