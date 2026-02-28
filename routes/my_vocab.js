// FILE: hakmun-api/routes/my_vocab.js
// PURPOSE: DV3 – My Vocabulary (READ)
// ENDPOINT: GET /v1/me/vocab
//
// Default sort: last_seen_at DESC (most recent first)
// Frontend may re-sort locally by column headers.

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");
const { signImageUrls } = require("../util/s3");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// GET /v1/me/vocab
router.get("/v1/me/vocab", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const sql = `
      SELECT
        uvi.lemma,
        uvi.vocab_id,
        uvi.first_seen_at,
        uvi.last_seen_at,
        uvi.seen_count,
        uvi.rotation_level_computed,
        uvi.rotation_level_override,
        uvi.status,
        uvi.is_archived,

        tv.lemma AS teaching_lemma,
        tv.part_of_speech,
        tv.pos_code,
        tv.pos_label,
        tv.image_s3_key,
        vg.text AS gloss_en

      FROM user_vocab_items uvi
      LEFT JOIN teaching_vocab tv
        ON tv.id = uvi.vocab_id
      LEFT JOIN vocab_glosses vg
        ON vg.vocab_id = tv.id
       AND vg.language = 'en'
       AND vg.is_primary = true
      WHERE uvi.user_id = $1::uuid
        AND uvi.is_archived = false
      ORDER BY uvi.last_seen_at DESC
      LIMIT 1000
    `;

    const { rows } = await dbQuery(sql, [userId]);
    await signImageUrls(rows);
    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("my vocab GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;