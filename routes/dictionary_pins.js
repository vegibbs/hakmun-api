// routes/dictionary_pins.js
//
// DV2: My Dictionary (Pins) — READ PATH
// - GET /v1/me/dictionary/pins
//
// Notes:
// - Uses the same session model as existing endpoints (req.user.userID).
// - Enriches pins with teaching_vocab + primary EN gloss when vocab_id is present.

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const pool = require("../db/pool");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// GET /v1/me/dictionary/pins
router.get("/v1/me/dictionary/pins", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: "NO_SESSION" });
    }

    const sql = `
      SELECT
        p.created_at,
        p.headword,
        p.vocab_id,
        tv.lemma,
        tv.part_of_speech,
        tv.pos_code,
        tv.pos_label,
        vg.text AS gloss_en
      FROM user_dictionary_pins p
      LEFT JOIN teaching_vocab tv
        ON tv.id = p.vocab_id
      LEFT JOIN vocab_glosses vg
        ON vg.vocab_id = tv.id
       AND vg.language = 'en'
       AND vg.is_primary = true
      WHERE p.user_id = $1::uuid
      ORDER BY p.created_at DESC
    `;

    const { rows } = await pool.query(sql, [userId]);
    return res.json({ ok: true, pins: rows });
  } catch (err) {
    console.error("dictionary pins GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;