-- Migration: Add session_date to document link tables
-- Purpose: Track which tutoring session each imported content item came from
-- Run this against the HakMun PostgreSQL database

-- 1. Add session_date to document_content_item_links
ALTER TABLE document_content_item_links
  ADD COLUMN IF NOT EXISTS session_date DATE;

CREATE INDEX IF NOT EXISTS idx_dcil_session_date
  ON document_content_item_links (session_date)
  WHERE session_date IS NOT NULL;

-- 2. Add session_date to document_vocab_links
ALTER TABLE document_vocab_links
  ADD COLUMN IF NOT EXISTS session_date DATE;

CREATE INDEX IF NOT EXISTS idx_dvl_session_date
  ON document_vocab_links (session_date)
  WHERE session_date IS NOT NULL;
