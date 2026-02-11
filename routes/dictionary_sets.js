// FILE: hakmun-api/routes/dictionary_sets.js
// PURPOSE: Generic dictionary sets endpoints (v0)
// ENDPOINTS:
//   GET /v1/dictionary/sets
//   GET /v1/dictionary/sets/:set_id/items
//
// Current policy (per Vernon):
// - Teaching Vocabulary is a single seed list (no TOPIK_I teaching set).
// - TOPIK_I will later be uploaded as a user list via the upload workflow.
// - No ordinals are used for Teaching Vocabulary.
//
// Set IDs (v0):
//   - teaching:ALL
//   - my_pins
//   - my_vocab

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

function parseSetId(setId) {
  if (setId === "teaching:ALL") return { kind: "teaching_all" };
  if (setId === "my_pins") return { kind: "my_pins" };
  if (setId === "my_vocab") return { kind: "my_vocab" };
  return null;
}

// GET /v1/dictionary/sets
router.get("/v1/dictionary/sets", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const sets = [
      {
        set_id: "teaching:ALL",
        kind: "teaching",
        title: "Teaching Vocabulary",
        subtitle: "Seed list",
      },
      {
        set_id: "my_pins",
        kind: "my_pins",
        title: "My Dictionary",
        subtitle: "Pinned terms",
      },
      {
        set_id: "my_vocab",
        kind: "my_vocab",
        title: "My Vocabulary",
        subtitle: "Exposure list",
      },
    ];

    return res.json({ ok: true, sets });
  } catch (err) {
    console.error("dictionary sets GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /v1/dictionary/sets/:set_id/items
router.get("/v1/dictionary/sets/:set_id/items", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const setId = req.params.set_id;
    const parsed = parseSetId(setId);
    if (!parsed) return res.status(400).json({ ok: false, error: "INVALID_SET_ID" });

    if (parsed.kind === "teaching_all") {
    const sql = `
      SELECT
        tvn.vocab_sense_key AS id,
        tvn.vocab_id,
        tvn.sense_index,
        tvn.lemma,
        tvn.part_of_speech,
        tvn.pos_code,
        tvn.pos_label,
        tvn.gloss_en,
    
        tvn.nikl_target_code,
        tvn.nikl_sense_no,
        tvn.nikl_definition_ko,
        tvn.nikl_trans_word_en,
        tvn.nikl_trans_definition_en
      FROM teaching_vocab_split_nikl tvn
      WHERE tvn.status IS DISTINCT FROM 'archived'
      ORDER BY tvn.lemma, tvn.sense_index
      LIMIT 50000
    `;
      const { rows } = await dbQuery(sql, []);
      return res.json({ ok: true, set_id: setId, kind: "teaching", items: rows || [] });
    }

    if (parsed.kind === "my_pins") {
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
      return res.json({ ok: true, set_id: setId, kind: "my_pins", items: rows || [] });
    }

    if (parsed.kind === "my_vocab") {
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

          tv.part_of_speech,
          tv.pos_code,
          tv.pos_label,
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
      return res.json({ ok: true, set_id: setId, kind: "my_vocab", items: rows || [] });
    }

    return res.status(400).json({ ok: false, error: "UNSUPPORTED_SET_KIND" });
  } catch (err) {
    console.error("dictionary set items GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;