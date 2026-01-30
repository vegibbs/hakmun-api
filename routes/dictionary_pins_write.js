// routes/dictionary_pins_write.js
//
// DV2: My Dictionary (Pins) — WRITE PATH
// - POST /v1/me/dictionary/pins
//
// Fix: db/pool export is not a pg.Pool instance (pool.query was undefined).
// We use a dbQuery() wrapper that supports either:
// - module exports a Pool directly with .query
// - module exports { pool } where pool.query exists

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function isUuidLike(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
}

function dbQuery(sql, params) {
  // Support db being a Pool or { pool: Pool }
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide a query() function");
}

// POST /v1/me/dictionary/pins
// Body: { headword: string, vocab_id?: uuid|null }
router.post("/v1/me/dictionary/pins", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: "NO_SESSION" });
    }

    const headword = typeof req.body?.headword === "string" ? req.body.headword.trim() : "";
    const vocabIdRaw = req.body?.vocab_id ?? null;

    if (!headword) {
      return res.status(400).json({ ok: false, error: "HEADWORD_REQUIRED" });
    }

    let vocabId = null;
    if (vocabIdRaw !== null && vocabIdRaw !== undefined && String(vocabIdRaw).trim() !== "") {
      if (!isUuidLike(vocabIdRaw)) {
        return res.status(400).json({ ok: false, error: "INVALID_VOCAB_ID" });
      }
      vocabId = String(vocabIdRaw);
    }

    const sql = `
      INSERT INTO user_dictionary_pins (user_id, headword, vocab_id)
      VALUES ($1::uuid, $2::text, $3::uuid)
      ON CONFLICT (user_id, headword) DO NOTHING
    `;

    await dbQuery(sql, [userId, headword, vocabId]);

    return res.json({ ok: true });
  } catch (err) {
    console.error("dictionary pins POST failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;