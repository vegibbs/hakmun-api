#!/usr/bin/env node
// ops/backfill_sentence_vocab.js
//
// One-time backfill: Analyze existing global sentences that have no vocabulary
// links, extract vocab + grammar patterns via OpenAI, and populate
// sentence_vocab_links and content_item_grammar_links.
//
// Usage:
//   node ops/backfill_sentence_vocab.js              # dry-run (log only)
//   node ops/backfill_sentence_vocab.js --commit      # actually write to DB
//   railway run -- node ops/backfill_sentence_vocab.js --commit  # production
//
// Idempotent: uses ON CONFLICT DO NOTHING in all link inserts.

const { Pool } = require("pg");
const { linkSentenceVocab, linkSentenceGrammarPatterns } = require("../util/link_vocab_patterns");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const COMMIT = process.argv.includes("--commit");
const BATCH_SIZE = 20;
const DELAY_BETWEEN_BATCHES_MS = 1500;
const OPENAI_MODEL = "gpt-4.1";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenAI(prompt) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You output strict JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("No content in OpenAI response");
  return content;
}

function buildBatchPrompt(sentences) {
  const items = sentences
    .map(
      (s, i) =>
        `${i + 1}. [${s.content_item_id}] "${s.text}"`
    )
    .join("\n");

  return `You are a Korean language teaching assistant.

For each Korean sentence below, extract:
1. vocabulary: content words (nouns, verbs, adjectives, adverbs) as dictionary-form headwords.
   Exclude particles and function words (이/가, 을/를, 에, 은/는, 의, 도, 와/과, 에서, 으로, etc.).
   For conjugated forms, return the dictionary form (e.g., "먹었어요" → "먹다").
2. grammar_patterns: grammar patterns used, as attachable ending surface forms.
   Return atomic patterns only — decompose compound endings into separate entries.
   Example: "-았/었어요", "-(으)ㄹ 거예요", "-고 싶다"

Sentences:
${items}

Return ONLY valid JSON. No markdown. No explanations.

Output schema:
{
  "results": [
    {
      "id": "uuid-from-above",
      "vocabulary": [
        { "lemma_ko": "dictionary form", "pos_ko": "명사|동사|형용사|부사|기타" }
      ],
      "grammar_patterns": [
        { "surface_form": "-아/어요" }
      ]
    }
  ]
}`;
}

async function main() {
  console.log(`\n=== Backfill Sentence Vocab/Patterns ===`);
  console.log(`Mode: ${COMMIT ? "COMMIT (writing to DB)" : "DRY RUN (log only)"}\n`);

  // Find sentences with no vocab links
  const { rows: unlinked } = await pool.query(`
    SELECT ci.content_item_id, ci.text
    FROM content_items ci
    JOIN library_registry_items lri
      ON lri.content_type = 'sentence'
     AND lri.content_id = ci.content_item_id
    WHERE ci.content_type = 'sentence'
      AND lri.audience = 'global'
      AND lri.operational_status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM sentence_vocab_links svl
        WHERE svl.sentence_content_item_id = ci.content_item_id
      )
    ORDER BY ci.created_at
  `);

  console.log(`Found ${unlinked.length} unlinked sentences\n`);

  if (unlinked.length === 0) {
    console.log("Nothing to backfill.");
    await pool.end();
    return;
  }

  // Process in batches
  const totalBatches = Math.ceil(unlinked.length / BATCH_SIZE);
  let totalVocab = 0;
  let totalPatterns = 0;
  let totalProcessed = 0;
  let totalFailed = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const batch = unlinked.slice(start, start + BATCH_SIZE);

    console.log(`Batch ${batchIdx + 1}/${totalBatches} (${batch.length} sentences)...`);

    let results;
    try {
      const prompt = buildBatchPrompt(batch);
      const raw = await callOpenAI(prompt);
      const parsed = JSON.parse(raw);
      results = Array.isArray(parsed.results) ? parsed.results : [];
    } catch (err) {
      console.error(`  ERROR in batch ${batchIdx + 1}: ${err.message}`);
      totalFailed += batch.length;
      if (batchIdx < totalBatches - 1) await sleep(DELAY_BETWEEN_BATCHES_MS);
      continue;
    }

    // Build lookup by id
    const byId = new Map(results.map((r) => [r.id, r]));

    for (const sentence of batch) {
      const result = byId.get(sentence.content_item_id);
      if (!result) {
        console.log(`  SKIP ${sentence.content_item_id} — not in OpenAI response`);
        totalFailed += 1;
        continue;
      }

      const vocabArray = Array.isArray(result.vocabulary) ? result.vocabulary : [];
      const patternsArray = Array.isArray(result.grammar_patterns) ? result.grammar_patterns : [];

      if (!COMMIT) {
        console.log(`  DRY: ${sentence.content_item_id} → ${vocabArray.length} vocab, ${patternsArray.length} patterns`);
        totalVocab += vocabArray.length;
        totalPatterns += patternsArray.length;
        totalProcessed += 1;
        continue;
      }

      // Write to DB in a transaction per sentence
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const q = client.query.bind(client);

        const vLinked = await linkSentenceVocab(q, sentence.content_item_id, vocabArray);
        const pLinked = await linkSentenceGrammarPatterns(q, sentence.content_item_id, patternsArray);

        await client.query("COMMIT");

        totalVocab += vLinked;
        totalPatterns += pLinked;
        totalProcessed += 1;

        console.log(`  OK: ${sentence.content_item_id} → ${vLinked} vocab, ${pLinked} patterns`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`  FAIL: ${sentence.content_item_id} — ${err.message}`);
        totalFailed += 1;
      } finally {
        client.release();
      }
    }

    // Rate limit between batches
    if (batchIdx < totalBatches - 1) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${totalProcessed}`);
  console.log(`Failed: ${totalFailed}`);
  console.log(`Vocab links: ${totalVocab}`);
  console.log(`Pattern links: ${totalPatterns}`);
  console.log(`Mode: ${COMMIT ? "COMMITTED" : "DRY RUN (use --commit to write)"}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
