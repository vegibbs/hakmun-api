// Classify teaching_vocab words for image generation
// Reads /tmp/image_candidates.csv, sends to GPT in batches,
// outputs /tmp/vocab_image_manifest.json with illustratable words + subject descriptions
//
// Usage: RAILWAY_ENVIRONMENT=sandbox railway run --service hakmun-api -- node scripts/classify_vocab_images.js

const fs = require("fs");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Parse CSV
const csv = fs.readFileSync("/tmp/image_candidates.csv", "utf8");
const lines = csv.trim().split("\n").slice(1);
const words = lines.map(l => {
  // Handle quoted CSV fields
  const parts = [];
  let current = "";
  let inQuotes = false;
  for (const ch of l) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return { id: parts[0], lemma: parts[1], gloss: parts[2], cefr: parts[3], pos: parts[4] };
});

console.log(`Loaded ${words.length} candidates`);

const BATCH_SIZE = 100;

async function classifyBatch(batch, batchNum) {
  const wordList = batch.map((w, i) => `${i + 1}. ${w.lemma} (${w.gloss}) [${w.pos}]`).join("\n");

  const prompt = `You are classifying Korean vocabulary words for a language learning flashcard app.
For each word, decide if it can be illustrated with a SINGLE clear image that a student would instantly recognize.
If yes, write a specific subject description (10-20 words) for generating a flat illustration.

ILLUSTRATABLE — write a subject description:
- Concrete nouns: objects, animals, food, places, body parts, clothing, furniture, vehicles, tools, weather phenomena
- Action verbs: show a person or character doing the action (eating, running, sleeping, reading, cooking, swimming, writing, dancing)
- Physical adjectives that have a clear visual: hot (steaming), cold (shivering), big vs small, heavy, bright, dark, fast, slow
- Nature/weather: rain, snow, sun, wind, mountain, ocean, river, forest

NOT ILLUSTRATABLE — mark as N:
- Abstract nouns: reason, situation, relationship, opinion, method, experience, culture, economy, difference, meaning, case
- Pronouns and determiners: I, you, he, this, that, each, every
- Numbers and counters: 1, 2, 3, ~ pieces, ~ times
- Abstract verbs: to be, to become, to seem, to think, to know, to need, to want, to decide, to believe, to exist
- Communication verbs that are just "speaking": to say, to tell, to ask, to answer, to explain (unless very specific like "to whisper")
- Adverb-like adjectives: important, different, possible, necessary, similar, various, special
- Dependent nouns: thing, way, fact, side, part
- Time/frequency words: always, sometimes, often, already, still, recently

SUBJECT DESCRIPTION RULES:
- For nouns: describe the object itself. "a single red apple with a small green leaf" not just "apple"
- For verbs: show a person doing the action. "a person running on a path, mid-stride, arms swinging" not just "running"
- For adjectives: show the concept. "a large elephant next to a tiny mouse" for big/small, "a thermometer with red mercury and wavy heat lines" for hot
- Keep it simple — one main subject, no complex scenes
- Describe colors, poses, and key visual details
- Do NOT include text, labels, or Korean characters in the description

RESPONSE FORMAT — one line per word, exactly:
1. Y | a single red apple with a small green leaf on top
2. N
3. Y | a person running on a path, mid-stride with arms swinging
...

Words:
${wordList}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 8192
    })
  });

  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content || "";

  const results = [];
  const responseLines = content.trim().split("\n");

  for (let i = 0; i < batch.length; i++) {
    const line = responseLines[i] || "";
    // Parse "1. Y | description" or "1. N"
    const match = line.match(/^\d+\.\s*(Y|N)\s*(?:\|\s*(.+))?$/i);
    if (match) {
      const illustratable = match[1].toUpperCase() === "Y";
      const description = match[2]?.trim() || null;
      results.push({ ...batch[i], illustratable, subject: illustratable ? description : null });
    } else {
      // Fallback: try to detect Y/N
      const hasY = line.toUpperCase().includes(" Y");
      results.push({ ...batch[i], illustratable: false, subject: null, parseError: line });
    }
  }

  const yCount = results.filter(r => r.illustratable).length;
  console.log(`  Batch ${batchNum}: ${yCount}/${batch.length} illustratable`);
  return results;
}

async function main() {
  const totalBatches = Math.ceil(words.length / BATCH_SIZE);
  console.log(`Processing ${words.length} words in ${totalBatches} batches of ${BATCH_SIZE}\n`);

  const allResults = [];

  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const results = await classifyBatch(batch, batchNum);
    allResults.push(...results);

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < words.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const illustratable = allResults.filter(r => r.illustratable);
  const notIllustratable = allResults.filter(r => !r.illustratable);

  // Count by POS and CEFR
  const byPos = {};
  const byCefr = {};
  for (const r of illustratable) {
    byPos[r.pos] = (byPos[r.pos] || 0) + 1;
    byCefr[r.cefr] = (byCefr[r.cefr] || 0) + 1;
  }

  console.log(`\n--- Results ---`);
  console.log(`Illustratable: ${illustratable.length} / ${allResults.length}`);
  console.log(`By POS:`, JSON.stringify(byPos));
  console.log(`By CEFR:`, JSON.stringify(byCefr));

  // Check for missing descriptions
  const missingDesc = illustratable.filter(r => !r.subject);
  if (missingDesc.length > 0) {
    console.log(`\nWARNING: ${missingDesc.length} words marked Y but missing subject description`);
  }

  // Write manifest
  const manifest = {
    generated_at: new Date().toISOString(),
    total_candidates: allResults.length,
    illustratable_count: illustratable.length,
    by_pos: byPos,
    by_cefr: byCefr,
    words: illustratable.map(r => ({
      id: r.id,
      lemma: r.lemma,
      gloss_en: r.gloss,
      cefr_level: r.cefr,
      pos_ko: r.pos,
      subject: r.subject
    }))
  };

  fs.writeFileSync("/tmp/vocab_image_manifest.json", JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to /tmp/vocab_image_manifest.json`);

  // Also write the "not illustratable" list for reference
  fs.writeFileSync("/tmp/vocab_not_illustratable.json", JSON.stringify(
    notIllustratable.map(r => ({ lemma: r.lemma, gloss: r.gloss, pos: r.pos, cefr: r.cefr })),
    null, 2
  ));
  console.log(`Not-illustratable list written to /tmp/vocab_not_illustratable.json`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
