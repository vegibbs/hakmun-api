// FILE: hakmun-api/routes/dictionary_pins.js
// PURPOSE: DV2 – My Dictionary pins (READ) — build marker + debug keys
// ENDPOINT: GET /v1/me/dictionary/pins
//
// TEMP DEBUG:
// - Adds build_sha to prove which deploy is serving.
// - Adds first_row_keys to show what the DB driver is returning.
// Remove these debug fields once confirmed.

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

function normalizePinRow(r) {
  const vocabId = r.vocab_id ?? r.void ?? null;
  const posCode = r.pos_code ?? r.pos_codenknown ?? null;

  return {
    created_at: r.created_at ?? null,
    headword: r.headword ?? null,
    vocab_id: vocabId,
    lemma: r.lemma ?? null,
    part_of_speech: r.part_of_speech ?? null,
    pos_code: posCode,
    pos_label: r.pos_label ?? null,
    gloss_en: r.gloss_en ?? null,
  };
}

router.get("/v1/me/dictionary/pins", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

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

    const { rows } = await dbQuery(sql, [userId]);

    const firstRowKeys = rows && rows.length ? Object.keys(rows[0]) : [];
    const pins = (rows || []).map(normalizePinRow);

    // Railway commonly exposes commit info in one of these env vars.
    const buildSha =
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.GITHUB_SHA ||
      process.env.COMMIT_SHA ||
      null;

    return res.json({
      ok: true,
      build_sha: buildSha,
      first_row_keys: firstRowKeys,
      pins,
    });
  } catch (err) {
    console.error("dictionary pins GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;