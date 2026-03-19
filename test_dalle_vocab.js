// Test DALL-E image generation for HakMun vocabulary illustrations
// Usage: railway run -- node /tmp/test_dalle_vocab.js

const OpenAI = require("openai");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

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

// Our 10 test vocabulary words — subject descriptions are specific to avoid ambiguity
const words = [
  { id: "1e6da5ed-59b2-4bcb-8069-3b467f6f1d43", lemma: "사과", gloss: "apple", subject: "a single red apple with a small green leaf on top" },
  { id: "e45f5251-9ec1-4c4d-957e-161b0ffa1bf3", lemma: "고양이", gloss: "cat", subject: "a sitting cat with orange tabby fur, facing forward" },
  { id: "4c8ed509-ddb7-48ba-a1a9-b295100b76ab", lemma: "책", gloss: "book", subject: "a closed hardcover book with a colorful cover, slightly angled" },
  { id: "fde065c4-1733-45c1-a5d8-0b03e220e18f", lemma: "꽃", gloss: "flower", subject: "a single flower with pink petals and a green stem" },
  { id: "97f06769-80e6-482f-b4a2-4a2cb318c913", lemma: "커피", gloss: "coffee", subject: "a ceramic coffee cup on a small saucer with steam rising" },
  { id: "da742c7d-bbf8-4540-ad1b-36a1e3ad4f45", lemma: "우산", gloss: "umbrella", subject: "an open umbrella with colorful panels, seen from a slight angle" },
  { id: "6d195d8c-3460-42a7-a5b1-e17ac2e064a1", lemma: "기차", gloss: "train", subject: "a modern passenger train with a rounded front, seen from a three-quarter angle" },
  { id: "4ad31c3d-3577-438d-b248-6d16c1e3f8cf", lemma: "나무", gloss: "tree", subject: "a single deciduous tree with a brown trunk and a full green leafy canopy" },
  { id: "78e87b82-ffde-451f-a4ab-ec71b86f7a72", lemma: "의자", gloss: "chair", subject: "a simple wooden chair with four legs, seen from a slight angle" },
  { id: "fa282ef7-fb9b-4e18-97d7-497dcc179f99", lemma: "비", gloss: "rain", subject: "a single gray rain cloud with blue raindrops falling from it" },
];

// Style prompt prefix — clean, friendly illustration style for language learning
const STYLE_PREFIX = `A single object illustration on a plain solid light beige background (#F5F0EB).
STRICT RULES:
- Show ONLY the object itself — nothing else in the scene. No decorations, no extra elements, no context.
- Absolutely NO text, NO letters, NO labels, NO words, NO characters of any language anywhere in the image.
- NO speech bubbles, NO icons, NO symbols, NO UI elements.
- The object should fill roughly 60-70% of the frame, centered.
- Style: clean vector-like flat illustration with soft pastel colors and thin outlines.
- Simple, minimal, iconic — like a vocabulary flashcard illustration.`;

async function generateAndUpload(word) {
  const prompt = `${STYLE_PREFIX}\n\nSubject: ${word.subject}`;

  console.log(`[${word.lemma}] Generating image for "${word.gloss}"...`);

  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
    response_format: "b64_json",
  });

  const b64 = response.data[0].b64_json;
  const revisedPrompt = response.data[0].revised_prompt;
  const buffer = Buffer.from(b64, "base64");

  console.log(`[${word.lemma}] Generated (${buffer.length} bytes). Revised prompt: ${revisedPrompt?.slice(0, 80)}...`);

  // Upload to S3
  const key = `vocab-images/${word.id}.png`;
  const s3 = makeS3Client();

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "image/png",
  }));

  console.log(`[${word.lemma}] Uploaded to s3://${BUCKET}/${key}`);

  return { word, key, revisedPrompt, size: buffer.length };
}

async function main() {
  console.log(`\nDALL-E Vocabulary Image Test — ${words.length} words`);
  console.log(`Bucket: ${BUCKET}`);
  console.log(`Style: modern educational illustration\n`);

  const results = [];

  // Generate sequentially to avoid rate limits
  for (const word of words) {
    try {
      const result = await generateAndUpload(word);
      results.push(result);
    } catch (err) {
      console.error(`[${word.lemma}] FAILED: ${err.message}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Generated: ${results.length}/${words.length}`);
  for (const r of results) {
    console.log(`  ${r.word.lemma} (${r.word.gloss}) → ${r.key} (${(r.size / 1024).toFixed(0)} KB)`);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
