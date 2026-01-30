// FILE: hakmun-api/routes/dictionary_pins_write.js
// PURPOSE: DV2/DV3 – Pin a word AND record exposure
// ENDPOINT: POST /v1/me/dictionary/pins
//
// Behavior:
// - Idempotently insert pin
// - Record exposure (source_kind = 'pin')
// - Upsert user_vocab_items (monotonic membership)

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
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// POST /v1/me/dictionary/pins
router.post("/v1/me/dictionary/pins", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const headword = typeof req.body?.headword === "string" ? req.body.headword.trim() : "";
    const vocabIdRaw = req.body?.vocab_id ?? null;

    if (!headword) {
      return res.status(400).json({ ok: false, error: "HEADWORD_REQUIRED" });
    }

    let vocabId = null;
    if (vocabIdRaw !== null && String(vocabIdRaw).trim() !== "") {
      if (!isUuidLike(vocabIdRaw)) {
        return res.status(400).json({ ok: false, error: "INVALID_VOCAB_ID" });
      }
      vocabId = String(vocabIdRaw);
    }

    // 1) Pin (idempotent)
    await dbQuery(
      `
      INSERT INTO user_dictionary_pins (user_id, headword, vocab_id)
      VALUES ($1::uuid, $2::text, $3::uuid)
      ON CONFLICT (user_id, headword) DO NOTHING
      `,
      [userId, headword, vocabId]
    );

    // 2) Record exposure (append-only)
    await dbQuery(
      `
      INSERT INTO user_vocab_exposures (
        exposure_id,
        user_id,
        lemma,
        surface,
        vocab_id,
        source_kind,
        source_id
      )
      VALUES (
        gen_random_uuid(),
        $1::uuid,
        $2::text,
        $2::text,
        $3::uuid,
        'pin',
        NULL
      )
      `,
      [userId, headword, vocabId]
    );

    // 3) Upsert personal vocab item (monotonic membership)
    await dbQuery(
      `
      INSERT INTO user_vocab_items (
        user_id,
        lemma,
        vocab_id,
        first_seen_at,
        last_seen_at,
        seen_count
      )
      VALUES (
        $1::uuid,
        $2::text,
        $3::uuid,
        now(),
        now(),
        1
      )
      ON CONFLICT (user_id, lemma)
      DO UPDATE SET
        last_seen_at = EXCLUDED.last_seen_at,
        seen_count = user_vocab_items.seen_count + 1
      `,
      [userId, headword, vocabId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("dictionary pins POST failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;