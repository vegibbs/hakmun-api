-- 220_add_ai_generation_metadata.sql
-- Add AI-assigned metadata columns to content_items for sentence generation.
-- These are populated by the pool replenisher and generate endpoint.

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS cefr_level TEXT,
  ADD COLUMN IF NOT EXISTS topic TEXT,
  ADD COLUMN IF NOT EXISTS naturalness_score REAL;
