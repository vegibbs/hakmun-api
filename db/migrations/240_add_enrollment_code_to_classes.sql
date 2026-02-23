-- 240_add_enrollment_code_to_classes.sql
-- Add enrollment code columns to classes for student self-enrollment.

ALTER TABLE classes ADD COLUMN IF NOT EXISTS enrollment_code VARCHAR(8);
ALTER TABLE classes ADD COLUMN IF NOT EXISTS enrollment_code_expires_at TIMESTAMPTZ;

-- Unique index on non-null enrollment codes for fast lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_enrollment_code
    ON classes(enrollment_code) WHERE enrollment_code IS NOT NULL;
