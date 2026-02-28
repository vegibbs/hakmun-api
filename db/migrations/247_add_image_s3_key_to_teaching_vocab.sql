-- 247: Add image_s3_key to teaching_vocab for canonical approved image

ALTER TABLE teaching_vocab
  ADD COLUMN IF NOT EXISTS image_s3_key TEXT;

-- Backfill from existing approved images (most recently reviewed per vocab_id)
UPDATE teaching_vocab tv
SET image_s3_key = via.s3_key
FROM (
  SELECT DISTINCT ON (vocab_id) vocab_id, s3_key
  FROM vocab_image_assets
  WHERE status = 'approved'
  ORDER BY vocab_id, reviewed_at DESC NULLS LAST
) via
WHERE tv.id = via.vocab_id
  AND tv.image_s3_key IS NULL;
