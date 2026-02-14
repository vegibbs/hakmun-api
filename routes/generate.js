// routes/generate.js — HakMun API
// Sentence generation via OpenAI → global content pool

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");
const { callOpenAIOnce } = require("../util/openai");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function")
    return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

const NATURALNESS_THRESHOLD = 0.7;

const TOPIC_ENUM = [
  "daily_life", "food", "weather", "travel", "work", "school",
  "shopping", "health", "hobbies", "relationships", "directions",
  "time", "emotions", "family", "transportation", "housing",
  "clothing", "nature", "culture", "technology",
];

const TIER_CEFR = {
  beginner: { label: "A1-A2 (beginner)", cefrRange: "A1 or A2" },
  intermediate: { label: "B1-B2 (intermediate)", cefrRange: "B1 or B2" },
  advanced: { label: "C1-C2 (advanced)", cefrRange: "C1 or C2" },
};

function buildGenerationPrompt(tier, count) {
  const info = TIER_CEFR[tier] || TIER_CEFR.beginner;
  const topicsCsv = TOPIC_ENUM.join(", ");

  return `You are a Korean language teaching assistant creating practice sentences for students.

Generate exactly ${count} natural Korean sentences at ${info.label} CEFR level.

Rules:
- Use 요-form (해요체) politeness level.
- Each sentence must be a complete, natural, standalone Korean sentence.
- Use everyday vocabulary appropriate for the level.
- Vary the grammar patterns: mix past, present, and future tenses.
- Do NOT repeat the same sentence structure. Each sentence should feel different.
- Do NOT include English words mixed into Korean.
- Each sentence should be 5-20 syllables long.

For each sentence, also provide:
- cefr_level: your best estimate of the CEFR level (${info.cefrRange}).
- topic: pick ONE from this list: ${topicsCsv}
- naturalness_score: how confident are you (0.0 to 1.0) that a native Korean speaker would actually say this sentence in everyday life? Be honest — penalize textbook-sounding or unnatural phrasing.

Return ONLY valid JSON. No markdown. No explanations.

Output schema:
{
  "sentences": [
    {
      "ko": "Korean sentence here",
      "en": "English translation here",
      "cefr_level": "A2",
      "topic": "daily_life",
      "naturalness_score": 0.95
    }
  ]
}`;
}

// POST /v1/generate/sentences
// Generates sentences via OpenAI and stores them in the global content pool.
router.post("/v1/generate/sentences", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  const tier = req.body?.tier || "beginner";
  if (!TIER_CEFR[tier]) {
    return res
      .status(400)
      .json({ ok: false, error: "INVALID_TIER", valid: Object.keys(TIER_CEFR) });
  }

  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 5, 1), 50);

  try {
    // 1. Generate sentences via OpenAI
    const prompt = buildGenerationPrompt(tier, count);
    const raw = await callOpenAIOnce(prompt);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ ok: false, error: "OPENAI_INVALID_JSON" });
    }

    if (!Array.isArray(parsed.sentences) || parsed.sentences.length === 0) {
      return res.status(502).json({ ok: false, error: "OPENAI_EMPTY_RESPONSE" });
    }

    // 2. Filter, normalize, and apply naturalness threshold
    const validSentences = parsed.sentences
      .filter((s) => s && typeof s.ko === "string" && s.ko.trim().length >= 5)
      .map((s) => {
        const score = typeof s.naturalness_score === "number" && Number.isFinite(s.naturalness_score)
          ? s.naturalness_score : null;
        const cefr = typeof s.cefr_level === "string" ? s.cefr_level.trim() : null;
        let topic = typeof s.topic === "string" ? s.topic.trim() : null;
        if (topic && !TOPIC_ENUM.includes(topic)) topic = null;
        return {
          ko: s.ko.trim(),
          en: typeof s.en === "string" ? s.en.trim() : null,
          cefr_level: cefr || null,
          topic,
          naturalness_score: score,
        };
      })
      .filter((s) => s.naturalness_score === null || s.naturalness_score >= NATURALNESS_THRESHOLD);

    if (validSentences.length === 0) {
      return res.status(502).json({ ok: false, error: "OPENAI_NO_VALID_SENTENCES" });
    }

    // 3. Insert into content_items + library_registry_items as global/approved
    const client = db && typeof db.connect === "function" ? await db.connect() : null;
    const q = client ? client.query.bind(client) : dbQuery;

    const created = [];

    try {
      if (client) await q("BEGIN", []);

      for (const s of validSentences) {
        const ins = await q(
          `
          INSERT INTO content_items
            (owner_user_id, content_type, text, language, notes,
             cefr_level, topic, naturalness_score)
          VALUES ($1::uuid, 'sentence', $2::text, 'ko', $3::text, $4, $5, $6)
          RETURNING content_item_id, content_type, text, language, notes,
                    cefr_level, topic, naturalness_score, created_at, updated_at
          `,
          [userId, s.ko, s.en, s.cefr_level, s.topic, s.naturalness_score]
        );
        const item = ins.rows[0];

        const reg = await q(
          `
          INSERT INTO library_registry_items
            (content_type, content_id, owner_user_id, audience, global_state, operational_status)
          VALUES
            ('sentence', $1::uuid, $2::uuid, 'global', 'approved', 'active')
          RETURNING id, audience, global_state, operational_status
          `,
          [item.content_item_id, userId]
        );
        const registry = reg.rows[0];

        created.push({
          content_item_id: item.content_item_id,
          content_type: item.content_type,
          text: item.text,
          language: item.language,
          notes: item.notes,
          cefr_level: item.cefr_level,
          topic: item.topic,
          naturalness_score: item.naturalness_score,
          created_at: item.created_at,
          updated_at: item.updated_at,
          registry_item_id: registry.id,
          audience: registry.audience,
          global_state: registry.global_state,
          operational_status: registry.operational_status,
        });
      }

      if (client) await q("COMMIT", []);
    } catch (err) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }
      throw err;
    } finally {
      if (client) client.release();
    }

    return res.status(201).json({
      ok: true,
      tier,
      requested: count,
      generated: created.length,
      items: created,
    });
  } catch (err) {
    console.error("sentence generation failed:", err);
    const msg =
      err.message === "openai_timeout"
        ? "OpenAI request timed out"
        : "Generation failed";
    return res.status(502).json({ ok: false, error: msg });
  }
});

module.exports = router;
