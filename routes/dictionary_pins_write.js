// routes/dictionary_pins_write.js
//
// DV2: My Dictionary (Pins) — WRITE PATH
// - POST /v1/me/dictionary/pins
//
// Notes:
// - Uses the same session model as existing endpoints (req.user.userID).
// - Returns JSON on errors (no HTML 500 pages).
// - Does not yet implement "pin => personal vocab exposure" (DV3).

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const pool = require("../db/pool");

function getUserId(req) {
  // HakMun session payload uses userID (camelCase) as seen in /v1/session/whoami.
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function isUuidLike(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
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

    await pool.query(sql, [userId, headword, vocabId]);

    return res.json({ ok: true });
  } catch (err) {
    console.error("dictionary pins POST failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;