// FILE: hakmun-api/routes/practice_events.js
// PURPOSE: Persist practice events for teacher access and cross-device sync.
//
// ENDPOINTS:
//   POST /v1/practice/events   — batch ingest events
//   GET  /v1/practice/events   — list events (domain, since, limit)

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
// POST /v1/practice/events
// Body: { events: [{ ts, domain, event_type, item_ids, source, meta }, ...] }
// Idempotent: skips rows that match (user_id, ts, domain, event_type, item_ids).
// ------------------------------------------------------------------
router.post("/v1/practice/events", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const events = req.body?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ ok: false, error: "EVENTS_REQUIRED" });
    }

    if (events.length > 500) {
      return res.status(400).json({ ok: false, error: "TOO_MANY_EVENTS", max: 500 });
    }

    // Validate events and build insert list
    const valid = events.filter(e => e.ts && e.domain && e.event_type);
    if (valid.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_VALID_EVENTS" });
    }

    // Batch insert using a single query with VALUES rows
    const valueClauses = [];
    const params = [userId];
    let idx = 2;

    for (const e of valid) {
      const itemIds = Array.isArray(e.item_ids) ? e.item_ids : [];
      const source = e.source || null;
      const meta = e.meta ? JSON.stringify(e.meta) : null;

      valueClauses.push(
        `($1::uuid, $${idx}::timestamptz, $${idx+1}::text, $${idx+2}::text, $${idx+3}::text[], $${idx+4}::text, $${idx+5}::jsonb)`
      );
      params.push(e.ts, String(e.domain), String(e.event_type), itemIds, source, meta);
      idx += 6;
    }

    const result = await withTimeout(
      pool.query(
        `INSERT INTO practice_events (user_id, ts, domain, event_type, item_ids, source, meta)
         VALUES ${valueClauses.join(",\n                ")}
         ON CONFLICT DO NOTHING`,
        params
      ),
      15000,
      "db-insert-practice-events"
    );

    return res.json({ ok: true, inserted: result.rowCount || 0 });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[practice-events] insert failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ------------------------------------------------------------------
// GET /v1/practice/events?domain=&since=&limit=
// ------------------------------------------------------------------
router.get("/v1/practice/events", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    let sql = `SELECT event_id, ts, domain, event_type, item_ids, source, meta
                 FROM practice_events
                WHERE user_id = $1::uuid`;
    const params = [userId];
    let idx = 2;

    if (req.query.domain) {
      sql += ` AND domain = $${idx}::text`;
      params.push(String(req.query.domain));
      idx++;
    }

    if (req.query.since) {
      sql += ` AND ts >= $${idx}::timestamptz`;
      params.push(req.query.since);
      idx++;
    }

    sql += ` ORDER BY ts DESC`;

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 5000);
    sql += ` LIMIT $${idx}::int`;
    params.push(limit);

    const r = await withTimeout(
      pool.query(sql, params),
      10000,
      "db-list-practice-events"
    );

    return res.json({ ok: true, events: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[practice-events] list failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
