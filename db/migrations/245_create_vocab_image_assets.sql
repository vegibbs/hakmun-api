-- 245: Create vocab_image_assets table for DALL-E generated vocabulary illustrations
CREATE TABLE IF NOT EXISTS vocab_image_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vocab_id UUID NOT NULL REFERENCES teaching_vocab(id),
  batch_number INTEGER NOT NULL,
  s3_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lemma TEXT NOT NULL,
  gloss_en TEXT,
  pos_ko TEXT,
  cefr_level TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_via_batch ON vocab_image_assets(batch_number);
CREATE INDEX IF NOT EXISTS idx_via_vocab ON vocab_image_assets(vocab_id);
CREATE INDEX IF NOT EXISTS idx_via_status ON vocab_image_assets(status);
