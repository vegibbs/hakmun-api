// FILE: hakmun-api/routes/daily_sentence.js
// PURPOSE: Server-driven Sentence of the Day — same sentence for all users on a given day.
//
// ENDPOINTS:
//   GET /v1/daily-sentence
//
// LOGIC:
//   1. Check daily_sentences table for a teacher-assigned override for today.
//   2. Fall back to deterministic pick from global approved sentences (B1–B2 CEFR).
//      Uses (daysSinceEpoch % poolSize) so every user gets the same sentence.

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// GET /v1/daily-sentence
router.get("/v1/daily-sentence", requireSession, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC

    // 1. Check for teacher override
    const overrideR = await dbQuery(
      `SELECT
         ci.content_item_id,
         ci.text,
         ci.notes,
         ci.cefr_level,
         ci.topic,
         ds.assigned_by,
         'override' AS source
       FROM daily_sentences ds
       JOIN content_items ci ON ci.content_item_id = ds.content_item_id
       WHERE ds.sentence_date = $1::date
       LIMIT 1`,
      [today]
    );

    if (overrideR.rows?.length > 0) {
      const row = overrideR.rows[0];
      return res.json({
        ok: true,
        sentence: {
          content_item_id: row.content_item_id,
          ko: row.text,
          en: row.notes || null,
          cefr_level: row.cefr_level || null,
          topic: row.topic || null,
          source: "override",
          date: today
        }
      });
    }

    // 2. Deterministic pick from global approved B1–B2 sentences
    const poolR = await dbQuery(
      `SELECT
         ci.content_item_id,
         ci.text,
         ci.notes,
         ci.cefr_level,
         ci.topic
       FROM content_items ci
       JOIN library_registry_items lri
         ON lri.content_type = ci.content_type
        AND lri.content_id   = ci.content_item_id
       WHERE ci.content_type = 'sentence'
         AND lri.audience = 'global'
         AND lri.global_state = 'approved'
         AND lri.operational_status = 'active'
         AND ci.cefr_level IN ('B1', 'B2')
       ORDER BY ci.content_item_id`,
      []
    );

    const pool = poolR.rows || [];
    if (pool.length === 0) {
      return res.json({ ok: true, sentence: null });
    }

    // Deterministic index: days since Unix epoch
    const daysSinceEpoch = Math.floor(Date.now() / 86400000);
    const index = daysSinceEpoch % pool.length;
    const row = pool[index];

    return res.json({
      ok: true,
      sentence: {
        content_item_id: row.content_item_id,
        ko: row.text,
        en: row.notes || null,
        cefr_level: row.cefr_level || null,
        topic: row.topic || null,
        source: "global",
        date: today
      }
    });
  } catch (err) {
    console.error("daily-sentence failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
