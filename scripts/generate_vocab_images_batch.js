// Generate a batch of vocab images from the manifest
// Usage: RAILWAY_ENVIRONMENT=sandbox railway run --service hakmun-api -- node scripts/generate_vocab_images_batch.js [batch_number] [start] [count]
// Example: ... node scripts/generate_vocab_images_batch.js 1 0 25

const fs = require("fs");
const OpenAI = require("openai");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const { pool } = require("../db/pool");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI.OpenAI({ apiKey: OPENAI_API_KEY });

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION || "auto",
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

const BUCKET = process.env.OBJECT_STORAGE_BUCKET;

const STYLE_PREFIX = `A single object illustration on a plain solid white background.
STRICT RULES:
- Show ONLY the object itself — nothing else in the scene. No decorations, no extra elements, no context.
- Absolutely NO text, NO letters, NO labels, NO words, NO characters of any language anywhere in the image.
- NO speech bubbles, NO icons, NO symbols, NO UI elements.
- The object should fill roughly 60-70% of the frame, centered.
- Style: clean vector-like flat illustration with soft pastel colors and thin outlines.
- Simple, minimal, iconic — like a vocabulary flashcard illustration.`;

async function removeBackground(inputBuffer) {
  // Write to temp file, run rembg via Python API, read result
  const tmpIn = `/tmp/rembg_in_${Date.now()}.png`;
  const tmpOut = `/tmp/rembg_out_${Date.now()}.png`;
  fs.writeFileSync(tmpIn, inputBuffer);
  try {
    execSync(`/Library/Frameworks/Python.framework/Versions/3.12/bin/python3 -c "
from rembg import remove
from PIL import Image
import io
inp = open('${tmpIn}', 'rb').read()
out = remove(inp)
with open('${tmpOut}', 'wb') as f:
    f.write(out)
"`, { timeout: 60000 });
    const result = fs.readFileSync(tmpOut);
    return result;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

async function generateAndUpload(word, batchNumber) {
  const prompt = `${STYLE_PREFIX}\n\nSubject: ${word.subject}`;

  console.log(`  [${word.lemma}] Generating "${word.gloss_en}"...`);

  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
    response_format: "b64_json",
  });

  const b64 = response.data[0].b64_json;
  const originalBuffer = Buffer.from(b64, "base64");
  console.log(`  [${word.lemma}] Generated (${(originalBuffer.length / 1024).toFixed(0)} KB). Removing background...`);

  // Remove background
  const transparentBuffer = await removeBackground(originalBuffer);
  console.log(`  [${word.lemma}] Background removed (${(transparentBuffer.length / 1024).toFixed(0)} KB). Uploading...`);

  // Upload to S3
  const key = `vocab-images/${word.id}.png`;
  const s3 = makeS3Client();

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: transparentBuffer,
    ContentType: "image/png",
  }));

  console.log(`  [${word.lemma}] Uploaded to s3://${BUCKET}/${key}`);

  // Insert into DB
  await pool.query(
    `INSERT INTO vocab_image_assets (vocab_id, batch_number, s3_key, subject, status, lemma, gloss_en, pos_ko, cefr_level)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [word.id, batchNumber, key, word.subject, word.lemma, word.gloss_en, word.pos_ko, word.cefr_level]
  );

  return { word, key, size: transparentBuffer.length };
}

async function main() {
  const batchNumber = parseInt(process.argv[2] || "1", 10);
  const start = parseInt(process.argv[3] || "0", 10);
  const count = parseInt(process.argv[4] || "25", 10);

  // Load manifest
  const manifest = JSON.parse(fs.readFileSync("/tmp/vocab_image_manifest.json", "utf8"));
  const words = manifest.words.slice(start, start + count);

  console.log(`\n=== Batch ${batchNumber}: ${words.length} words (offset ${start}) ===`);
  console.log(`Bucket: ${BUCKET}\n`);

  const results = [];
  const errors = [];

  for (const word of words) {
    try {
      const result = await generateAndUpload(word, batchNumber);
      results.push(result);
      // Small delay between generations
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  [${word.lemma}] FAILED: ${err.message}`);
      errors.push({ word, error: err.message });
    }
  }

  console.log(`\n--- Batch ${batchNumber} Summary ---`);
  console.log(`Generated: ${results.length}/${words.length}`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
    errors.forEach(e => console.log(`  ${e.word.lemma}: ${e.error}`));
  }
  for (const r of results) {
    console.log(`  ${r.word.lemma} (${r.word.gloss_en}) → ${r.key} (${(r.size / 1024).toFixed(0)} KB)`);
  }

  await pool.end();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
