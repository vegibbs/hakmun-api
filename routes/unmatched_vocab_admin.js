// FILE: hakmun-api/routes/unmatched_vocab_admin.js
// PURPOSE: Admin endpoints for managing unmatched vocabulary.
// ENDPOINTS:
//   GET  /v1/admin/vocab/unmatched  — list unmatched vocab for current user
//   GET  /v1/admin/vocab/suggest    — suggest teaching_vocab matches
//   POST /v1/admin/vocab/resolve    — link or dismiss an unmatched item

const express = require("express");
const { requireSession, requireRole } = require("../auth/session");
const { pool } = require("../db/pool");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// GET /v1/admin/vocab/unmatched
// Returns unmatched lemmas ranked by frequency.
router.get("/v1/admin/vocab/unmatched", requireSession, requireRole("teacher", "approver"), async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(`
        SELECT unmatched_id, lemma, pos, context_span, count,
               first_seen_at, last_seen_at
        FROM unmatched_vocab
        WHERE owner_user_id = $1::uuid
        ORDER BY count DESC, last_seen_at DESC
      `, [userId]),
      8000,
      "db-list-unmatched-vocab"
    );

    return res.json({ ok: true, unmatched: r.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /v1/admin/vocab/suggest?lemma=...&q=...
// Suggests teaching_vocab entries that match a lemma or keyword.
router.get("/v1/admin/vocab/suggest", requireSession, requireRole("teacher", "approver"), async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const lemma = (req.query?.lemma || "").trim();
    const q = (req.query?.q || "").trim();
    if (!lemma && !q) {
      return res.status(400).json({ ok: false, error: "LEMMA_OR_Q_REQUIRED" });
    }

    const searchTerm = lemma || q;

    const r = await withTimeout(
      pool.query(`
        SELECT tv.id, tv.lemma, tv.part_of_speech, tv.pos_code, tv.status,
               ap.gloss_en,
               ov.word_override AS override_en,
               ov.definition_override AS definition_en
        FROM teaching_vocab tv
        LEFT JOIN teaching_vocab_split_apply_plan ap
          ON ap.vocab_id = tv.id AND ap.sense_index = 1
        LEFT JOIN teaching_vocab_localized_overrides ov
          ON ov.vocab_id = tv.id AND ov.sense_index = 1 AND ov.lang = 'en'
        WHERE tv.lemma ILIKE $1
           OR tv.lemma ILIKE $2
        ORDER BY
          CASE WHEN tv.lemma = $3 THEN 0
               WHEN tv.lemma ILIKE $4 THEN 1
               ELSE 2
          END,
          tv.lemma
        LIMIT 30
      `, [searchTerm, `%${searchTerm}%`, searchTerm, `${searchTerm}%`]),
      8000,
      "db-suggest-vocab"
    );

    const suggestions = r.rows.map(row => {
      const rowLemma = (row.lemma || "").toLowerCase();
      const needle = searchTerm.toLowerCase();

      let score = 0;
      if (rowLemma === needle) score = 100;
      else if (rowLemma.startsWith(needle)) score = 80;
      else if (rowLemma.includes(needle)) score = 60;
      else if (needle.includes(rowLemma)) score = 50;

      return {
        vocab_id: row.id,
        lemma: row.lemma,
        part_of_speech: row.part_of_speech,
        pos_code: row.pos_code,
        status: row.status,
        gloss_en: row.override_en || row.gloss_en || null,
        definition_en: row.definition_en || null,
        score,
      };
    });

    return res.json({ ok: true, lemma: lemma || null, q: q || null, suggestions });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/admin/vocab/resolve
// Body: { lemma, action: "link"|"dismiss", vocab_id? }
// Resolves an unmatched vocab item by linking or dismissing.
router.post("/v1/admin/vocab/resolve", requireSession, requireRole("teacher", "approver"), async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const lemma = (req.body?.lemma || "").trim();
    const action = req.body?.action;
    const vocabId = req.body?.vocab_id || null;

    if (!lemma) return res.status(400).json({ ok: false, error: "LEMMA_REQUIRED" });
    if (!["link", "dismiss"].includes(action)) {
      return res.status(400).json({ ok: false, error: "INVALID_ACTION", valid: ["link", "dismiss"] });
    }
    if (action === "link" && !vocabId) {
      return res.status(400).json({ ok: false, error: "VOCAB_ID_REQUIRED_FOR_LINK" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Delete the unmatched row
      const deleted = await withTimeout(
        client.query(`
          DELETE FROM unmatched_vocab
          WHERE owner_user_id = $1::uuid
            AND lemma = $2
          RETURNING unmatched_id
        `, [userId, lemma]),
        8000,
        "db-delete-unmatched-vocab"
      );

      if (deleted.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      let backfilled = 0;

      // If linking, backfill user_vocab_items rows that have vocab_id=NULL
      if (action === "link" && vocabId) {
        const bf = await withTimeout(
          client.query(`
            UPDATE user_vocab_items
            SET vocab_id = $3::uuid
            WHERE user_id = $1::uuid
              AND lemma = $2
              AND vocab_id IS NULL
          `, [userId, lemma, vocabId]),
          8000,
          "db-backfill-vocab-link"
        );
        backfilled = bf.rowCount;
      }

      await client.query("COMMIT");

      return res.json({
        ok: true,
        action: action === "link" ? "linked" : "dismissed",
        items_backfilled: backfilled,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
