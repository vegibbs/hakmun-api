// routes/dictionary_pins_write.js
//
// DV2: My Dictionary (Pins) — WRITE PATH
// - POST /v1/me/dictionary/pins

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const pool = require("../db/pool");

// POST /v1/me/dictionary/pins
// Body: { headword: string, vocab_id?: uuid|null }
router.post("/v1/me/dictionary/pins", requireSession, async (req, res) => {
  const userId = req.user?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "NO_SESSION" });
  }

  const headword = typeof req.body?.headword === "string" ? req.body.headword.trim() : "";
  const vocabId = req.body?.vocab_id ?? null;

  if (!headword) {
    return res.status(400).json({ ok: false, error: "HEADWORD_REQUIRED" });
  }

  // vocab_id is optional; if provided, it must look like a UUID.
  if (vocabId !== null && vocabId !== undefined) {
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidLike.test(String(vocabId))) {
      return res.status(400).json({ ok: false, error: "INVALID_VOCAB_ID" });
    }
  }

  const sql = `
    INSERT INTO user_dictionary_pins (user_id, headword, vocab_id)
    VALUES ($1::uuid, $2::text, $3::uuid)
    ON CONFLICT (user_id, headword) DO NOTHING
  `;

  await pool.query(sql, [userId, headword, vocabId]);

  return res.json({ ok: true });
});

module.exports = router;