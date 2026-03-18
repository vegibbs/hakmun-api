-- 231: Add created_by to teaching_vocab for two-person-touch tracking.
-- When an approver creates a teaching_vocab entry, a different approver
-- must approve it (change status from provisional to active).

ALTER TABLE teaching_vocab
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(user_id);
