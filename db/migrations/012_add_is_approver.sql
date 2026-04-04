-- Migration 012: Add is_approver column to users table
-- Decouples approver status from role column. A user can be a student or teacher
-- AND an approver simultaneously. Previously approver was a role value.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approver boolean DEFAULT false NOT NULL;

-- Migrate existing role='approver' users: set is_approver=true, role='teacher'
-- (approvers were always teachers with elevated review powers)
UPDATE users
SET is_approver = true,
    role = 'teacher'
WHERE role = 'approver';

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_users_is_approver ON users (is_approver) WHERE is_approver = true;
