-- 238_add_raw_text_to_hakdocs.sql
-- Store the teacher's raw editor text as source of truth for the freeform editor.
-- Structured sessions/blocks are still derived and saved alongside, but the
-- raw_text column ensures perfect round-trip fidelity (blank lines, day names,
-- formatting are preserved exactly as typed).

ALTER TABLE hakdocs ADD COLUMN IF NOT EXISTS raw_text TEXT;
