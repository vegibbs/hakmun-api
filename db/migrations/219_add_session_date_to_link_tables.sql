-- 219: Add session_date to document link tables
-- Purpose: Track which tutoring session (HEADING_1 date) each imported
--          content item and vocab link came from. Enables recency-based
--          practice rotation weighting (recent items get higher weight).

ALTER TABLE document_content_item_links
  ADD COLUMN IF NOT EXISTS session_date DATE;

CREATE INDEX IF NOT EXISTS idx_dcil_session_date
  ON document_content_item_links (session_date)
  WHERE session_date IS NOT NULL;

ALTER TABLE document_vocab_links
  ADD COLUMN IF NOT EXISTS session_date DATE;

CREATE INDEX IF NOT EXISTS idx_dvl_session_date
  ON document_vocab_links (session_date)
  WHERE session_date IS NOT NULL;
