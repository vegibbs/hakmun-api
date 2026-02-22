-- 237_create_hakdoc_tables.sql
-- HakDoc: native document editor for language teaching.
-- Three tables: hakdocs → hakdoc_sessions → hakdoc_blocks.

-- hakdocs: top-level document owned by a teacher
CREATE TABLE IF NOT EXISTS hakdocs (
    hakdoc_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    title           TEXT NOT NULL DEFAULT 'Untitled',
    student_id      UUID REFERENCES users(user_id) ON DELETE SET NULL,
    class_code      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hakdocs_teacher ON hakdocs(teacher_id);

-- hakdoc_sessions: one per teaching session date
CREATE TABLE IF NOT EXISTS hakdoc_sessions (
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hakdoc_id       UUID NOT NULL REFERENCES hakdocs(hakdoc_id) ON DELETE CASCADE,
    session_date    DATE NOT NULL,
    session_number  INTEGER NOT NULL DEFAULT 1,
    topic           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hakdoc_sessions_doc ON hakdoc_sessions(hakdoc_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hakdoc_sessions_doc_date ON hakdoc_sessions(hakdoc_id, session_date);

-- hakdoc_blocks: ordered content within a session
CREATE TABLE IF NOT EXISTS hakdoc_blocks (
    block_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES hakdoc_sessions(session_id) ON DELETE CASCADE,
    block_type      TEXT NOT NULL DEFAULT 'teacher_note',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    content         JSONB NOT NULL DEFAULT '{}',
    importance      INTEGER NOT NULL DEFAULT 0,
    audio_url       TEXT,
    audio_status    TEXT NOT NULL DEFAULT 'none',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hakdoc_blocks_session ON hakdoc_blocks(session_id);
