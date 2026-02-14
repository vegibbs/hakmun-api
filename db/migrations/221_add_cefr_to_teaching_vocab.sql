-- 221_add_cefr_to_teaching_vocab.sql
-- Add CEFR level classification columns to teaching_vocab.

ALTER TABLE teaching_vocab
  ADD COLUMN IF NOT EXISTS cefr_level VARCHAR(2),
  ADD COLUMN IF NOT EXISTS cefr_confidence NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS cefr_authority VARCHAR(20) DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS cefr_assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cefr_assigned_by UUID REFERENCES users(user_id);

-- cefr_level: A1, A2, B1, B2, C1, C2
-- cefr_confidence: 0.00–1.00, strength of the assignment
-- cefr_authority: who assigned it
--   'unassigned'         — no CEFR level yet
--   'ai_assigned'        — mapped by AI (lowest trust)
--   'teacher_assigned'   — assigned by a teacher
--   'approver_confirmed' — confirmed by an approver (highest trust)
-- cefr_assigned_at: when the level was assigned
-- cefr_assigned_by: NULL for AI, user_id for human assigners

CREATE INDEX IF NOT EXISTS idx_teaching_vocab_cefr_level
  ON teaching_vocab (cefr_level);
