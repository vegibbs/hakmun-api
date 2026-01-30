// FILE: hakmun-api/routes/dictionary_pins.js
// PURPOSE: DV2 – My Dictionary pins (READ)
// ENDPOINT: GET /v1/me/dictionary/pins

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

router.get("/v1/me/dictionary/pins", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const sql = `
      SELECT
        p.created_at,
        p.headword,
        p.vocab_id AS vocab_id,
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

    const { rows } = await dbQuery(sql, [userId]);
    return res.json({ ok: true, pins: rows });
  } catch (err) {
    console.error("dictionary pins GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;