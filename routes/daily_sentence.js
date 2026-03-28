// FILE: hakmun-api/routes/daily_sentence.js
// PURPOSE: Server-driven Sentence of the Day — same sentence for all users on a given day.
//
// ENDPOINTS:
//   GET    /v1/daily-sentence              — today's sentence (all users)
//   GET    /v1/daily-sentence/assignments  — list all assigned overrides (approver-only)
//   POST   /v1/daily-sentence/assign       — assign a sentence to a date (approver-only)
//   DELETE /v1/daily-sentence/assign/:date — remove an assignment (approver-only)
//
// LOGIC (GET):
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

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function isApprover(req) {
  if (req.user?.capabilities?.canApproveContent) return true;
  const ents = req.user?.entitlements;
  if (Array.isArray(ents)) return ents.includes("approver:content");
  return false;
}

// GET /v1/daily-sentence
router.get("/v1/daily-sentence", requireSession, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC

    // 1. Check for teacher override (gracefully skip if table doesn't exist yet)
    try {
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
    } catch (overrideErr) {
      // Table may not exist yet — fall through to global pool
      console.warn("daily-sentence override check skipped:", overrideErr.message);
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

// GET /v1/daily-sentence/assignments — list all overrides (approver-only)
router.get("/v1/daily-sentence/assignments", requireSession, async (req, res) => {
  try {
    if (!isApprover(req)) {
      return res.status(403).json({ ok: false, error: "APPROVER_REQUIRED" });
    }

    const r = await dbQuery(
      `SELECT
         ds.id,
         ds.sentence_date,
         ds.content_item_id,
         ci.text AS ko,
         ci.notes AS en,
         ci.cefr_level,
         ci.topic,
         ds.assigned_by,
         u.display_name AS assigned_by_name,
         ds.created_at
       FROM daily_sentences ds
       JOIN content_items ci ON ci.content_item_id = ds.content_item_id
       LEFT JOIN users u ON u.user_id = ds.assigned_by
       ORDER BY ds.sentence_date DESC
       LIMIT 200`,
      []
    );

    return res.json({ ok: true, assignments: r.rows || [] });
  } catch (err) {
    if (err.message?.includes('relation "daily_sentences" does not exist')) {
      return res.json({ ok: true, assignments: [] });
    }
    console.error("daily-sentence assignments list failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/daily-sentence/assign — assign a sentence to a date (approver-only)
// Body: { date: "YYYY-MM-DD", content_item_id: "uuid" }
router.post("/v1/daily-sentence/assign", requireSession, async (req, res) => {
  try {
    if (!isApprover(req)) {
      return res.status(403).json({ ok: false, error: "APPROVER_REQUIRED" });
    }

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const date = typeof req.body?.date === "string" ? req.body.date.trim() : "";
    const contentItemId = typeof req.body?.content_item_id === "string" ? req.body.content_item_id.trim() : "";

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "INVALID_DATE" });
    }
    if (!contentItemId) {
      return res.status(400).json({ ok: false, error: "CONTENT_ITEM_ID_REQUIRED" });
    }

    const r = await dbQuery(
      `INSERT INTO daily_sentences (sentence_date, content_item_id, assigned_by)
       VALUES ($1::date, $2::uuid, $3::uuid)
       ON CONFLICT (sentence_date)
       DO UPDATE SET
         content_item_id = EXCLUDED.content_item_id,
         assigned_by = EXCLUDED.assigned_by,
         created_at = now()
       RETURNING id, sentence_date, content_item_id, assigned_by, created_at`,
      [date, contentItemId, userId]
    );

    return res.json({ ok: true, assignment: r.rows?.[0] || null });
  } catch (err) {
    console.error("daily-sentence assign failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/daily-sentence/assign/:date — remove an assignment (approver-only)
router.delete("/v1/daily-sentence/assign/:date", requireSession, async (req, res) => {
  try {
    if (!isApprover(req)) {
      return res.status(403).json({ ok: false, error: "APPROVER_REQUIRED" });
    }

    const date = req.params.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "INVALID_DATE" });
    }

    const r = await dbQuery(
      `DELETE FROM daily_sentences WHERE sentence_date = $1::date`,
      [date]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("daily-sentence delete failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
