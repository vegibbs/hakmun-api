-- 239_create_class_tables.sql
-- Classes module: containers that group documents, lists, and students.

-- classes: owned by a teacher
CREATE TABLE IF NOT EXISTS classes (
    class_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);

-- class_members: enrolled students (or other roles)
CREATE TABLE IF NOT EXISTS class_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id        UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'student',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_class_members_class ON class_members(class_id);
CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);

-- class_lists: lists attached to a class
CREATE TABLE IF NOT EXISTS class_lists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id        UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
    list_id         UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    attached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (class_id, list_id)
);
CREATE INDEX IF NOT EXISTS idx_class_lists_class ON class_lists(class_id);

-- class_documents: documents attached to a class (hakdoc or google_doc)
CREATE TABLE IF NOT EXISTS class_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id        UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
    document_type   TEXT NOT NULL CHECK (document_type IN ('hakdoc', 'google_doc')),
    document_id     TEXT NOT NULL,
    attached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (class_id, document_type, document_id)
);
CREATE INDEX IF NOT EXISTS idx_class_documents_class ON class_documents(class_id);

-- Auto-update updated_at on classes
CREATE OR REPLACE FUNCTION update_classes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_classes_updated_at ON classes;
CREATE TRIGGER trg_classes_updated_at
    BEFORE UPDATE ON classes
    FOR EACH ROW
    EXECUTE FUNCTION update_classes_updated_at();
