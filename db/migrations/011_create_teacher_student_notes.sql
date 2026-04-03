-- Migration 011: Create teacher_student_notes table
--
-- Stores per-teacher private notes about a student. Notes are global (not scoped
-- to a class) — one set of notes per teacher-student pair regardless of how many
-- classes they share.

CREATE TABLE IF NOT EXISTS teacher_student_notes (
    id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    student_user_id   UUID            NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    teacher_user_id   UUID            NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    note_text         TEXT            NOT NULL DEFAULT '',
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    UNIQUE (student_user_id, teacher_user_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_student_notes_teacher
    ON teacher_student_notes (teacher_user_id);
