// FILE: hakmun-api/routes/practice_completions.js
// PURPOSE: Practice journal completions — batch ingest and paginated fetch.
//
// ENDPOINTS:
//   POST /v1/practice/completions   — batch ingest completions
//   GET  /v1/practice/completions   — list completions (module, since, limit)

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// ------------------------------------------------------------------
// POST /v1/practice/completions
// Body: { completions: [{ item_id, module, completed_at, cefr_level?, topic?, source_lesson?, meta? }, ...] }
// Idempotent: skips rows that match (user_id, item_id, module, completed_at).
// ------------------------------------------------------------------
router.post("/v1/practice/completions", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const completions = req.body?.completions;
    if (!Array.isArray(completions) || completions.length === 0) {
      return res.status(400).json({ ok: false, error: "COMPLETIONS_REQUIRED" });
    }

    if (completions.length > 500) {
      return res.status(400).json({ ok: false, error: "TOO_MANY_COMPLETIONS", max: 500 });
    }

    const valid = completions.filter(c => c.item_id && c.module && c.completed_at);
    if (valid.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_VALID_COMPLETIONS" });
    }

    const valueClauses = [];
    const params = [userId];
    let idx = 2;

    for (const c of valid) {
      const meta = c.meta ? JSON.stringify(c.meta) : null;
      valueClauses.push(
        `($1::uuid, $${idx}::text, $${idx+1}::text, $${idx+2}::timestamptz, $${idx+3}::text, $${idx+4}::text, $${idx+5}::text, $${idx+6}::jsonb)`
      );
      params.push(
        String(c.item_id),
        String(c.module),
        c.completed_at,
        c.cefr_level || null,
        c.topic || null,
        c.source_lesson || null,
        meta
      );
      idx += 7;
    }

    const result = await withTimeout(
      pool.query(
        `INSERT INTO practice_completions (user_id, item_id, module, completed_at, cefr_level, topic, source_lesson, meta)
         VALUES ${valueClauses.join(",\n                ")}
         ON CONFLICT DO NOTHING`,
        params
      ),
      15000,
      "db-insert-practice-completions"
    );

    return res.json({ ok: true, inserted: result.rowCount || 0 });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[practice-completions] insert failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ------------------------------------------------------------------
// GET /v1/practice/completions?module=&since=&limit=
// ------------------------------------------------------------------
router.get("/v1/practice/completions", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    let sql = `SELECT completion_id, item_id, module, completed_at, cefr_level, topic, source_lesson, meta
                 FROM practice_completions
                WHERE user_id = $1::uuid`;
    const params = [userId];
    let idx = 2;

    if (req.query.module) {
      sql += ` AND module = $${idx}::text`;
      params.push(String(req.query.module));
      idx++;
    }

    if (req.query.since) {
      sql += ` AND completed_at >= $${idx}::timestamptz`;
      params.push(req.query.since);
      idx++;
    }

    sql += ` ORDER BY completed_at DESC`;

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 5000);
    sql += ` LIMIT $${idx}::int`;
    params.push(limit);

    const r = await withTimeout(
      pool.query(sql, params),
      10000,
      "db-list-practice-completions"
    );

    return res.json({ ok: true, completions: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[practice-completions] list failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
