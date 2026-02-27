const fs = require("fs");
const https = require("https");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { pool } = require("../db/pool");

const BFL_KEY = process.env.BFL_API_KEY;
if (!BFL_KEY) { console.error("BFL_API_KEY not set"); process.exit(1); }

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

function fetchJSON(url, opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function generateOne(word) {
  const prompt = `${STYLE_PREFIX}\n\nSubject: ${word.subject}`;
  console.log(`  [${word.lemma}] Generating "${word.gloss_en}"...`);

  const submitRes = await fetchJSON("https://api.bfl.ai/v1/flux-2-pro", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Key": BFL_KEY },
    body: JSON.stringify({ prompt, width: 1024, height: 1024 }),
  });

  const pollUrl = submitRes.polling_url || submitRes.id;
  if (!pollUrl) throw new Error("No polling URL: " + JSON.stringify(submitRes));

  const pollingEndpoint = typeof pollUrl === "string" && pollUrl.startsWith("http")
    ? pollUrl
    : `https://api.bfl.ai/v1/get_result?id=${pollUrl}`;

  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const status = await fetchJSON(pollingEndpoint, { method: "GET", headers: { "X-Key": BFL_KEY } });
    if (status.status === "Ready") {
      const imgUrl = status.result.sample;
      const buf = await downloadBuffer(imgUrl);
      console.log(`  [${word.lemma}] Generated (${(buf.length / 1024).toFixed(0)} KB). Uploading...`);
      return buf;
    } else if (status.status === "Error") {
      throw new Error("Flux error: " + JSON.stringify(status));
    }
  }
}

async function main() {
  const batchNumber = parseInt(process.argv[2] || "6", 10);
  const wordsFile = process.argv[3] || "/tmp/flux_batch6.json";
  const words = JSON.parse(fs.readFileSync(wordsFile, "utf8"));

  console.log(`\n=== Batch ${batchNumber}: ${words.length} words (Flux 2 Pro) ===`);
  console.log(`Bucket: ${BUCKET}\n`);

  const s3 = makeS3Client();
  const results = [];
  const errors = [];

  for (const word of words) {
    try {
      const buf = await generateOne(word);
      const key = `vocab-images/flux-${word.id}.png`;

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buf,
        ContentType: "image/jpeg",
      }));
      console.log(`  [${word.lemma}] Uploaded to s3://${BUCKET}/${key}`);

      await pool.query(
        `INSERT INTO vocab_image_assets (vocab_id, batch_number, s3_key, subject, status, lemma, gloss_en, pos_ko, cefr_level)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [word.id, batchNumber, key, word.subject, word.lemma, word.gloss_en, word.pos_ko, word.cefr_level]
      );
      results.push({ word, key, size: buf.length });
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

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
