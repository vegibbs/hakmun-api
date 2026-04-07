// routes/numbers_drills.js — HakMun API
// Numbers drill content: returns tagged items from teaching_vocab and content_items.
// ENDPOINT: GET /v1/numbers/drills

const express = require("express");
const router = express.Router();
const { requireSession } = require("../auth/session");
const db = require("../db/pool");
const { logger } = require("../util/log");

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// ---------------------------------------------------------------------------
// GET /v1/numbers/drills
// ---------------------------------------------------------------------------
router.get("/v1/numbers/drills", requireSession, async (req, res) => {
  try {
    const sql = `
      SELECT id, ko, hint, tags, source FROM (
        -- Vocab items (bare number words)
        SELECT
          tv.id::text AS id,
          tv.lemma AS ko,
          vg.text AS hint,
          tv.tags,
          'vocab' AS source
        FROM teaching_vocab tv
        LEFT JOIN vocab_glosses vg
          ON vg.vocab_id = tv.id AND vg.language = 'en' AND vg.is_primary = true
        WHERE 'module:numbers' = ANY(tv.tags)
          AND tv.status IS DISTINCT FROM 'deprecated'

        UNION ALL

        -- Sentence items
        SELECT
          ci.content_item_id::text AS id,
          ci.text AS ko,
          ci.notes AS hint,
          ci.tags,
          'sentence' AS source
        FROM content_items ci
        JOIN library_registry_items lri
          ON lri.content_type = ci.content_type
         AND lri.content_id = ci.content_item_id
        WHERE 'module:numbers' = ANY(ci.tags)
          AND lri.audience = 'global'
          AND lri.global_state = 'approved'
          AND lri.operational_status = 'active'
      ) combined
      ORDER BY ko
    `;

    const { rows } = await dbQuery(sql);

    // Diagnostic: count by source and section to identify missing data
    const bySource = {};
    const bySection = {};
    for (const row of rows) {
      bySource[row.source] = (bySource[row.source] || 0) + 1;
      const sec = (row.tags || []).find(t => t.startsWith("section:")) || "unknown";
      bySection[sec] = (bySection[sec] || 0) + 1;
    }

    // Diagnostic: check content_items that exist but may lack valid LRI entries
    const diagSql = `
      SELECT
        (SELECT count(*) FROM content_items WHERE 'module:numbers' = ANY(tags)) AS total_content_items,
        (SELECT count(*) FROM content_items ci
         JOIN library_registry_items lri
           ON lri.content_type = ci.content_type AND lri.content_id = ci.content_item_id
         WHERE 'module:numbers' = ANY(ci.tags)
           AND lri.audience = 'global'
           AND lri.global_state = 'approved'
           AND lri.operational_status = 'active') AS with_valid_lri,
        (SELECT count(*) FROM content_items ci
         LEFT JOIN library_registry_items lri
           ON lri.content_type = ci.content_type AND lri.content_id = ci.content_item_id
         WHERE 'module:numbers' = ANY(ci.tags)
           AND lri.content_id IS NULL) AS no_lri_at_all,
        (SELECT count(*) FROM content_items ci
         JOIN library_registry_items lri
           ON lri.content_type = ci.content_type AND lri.content_id = ci.content_item_id
         WHERE 'module:numbers' = ANY(ci.tags)
           AND (lri.global_state != 'approved' OR lri.operational_status != 'active' OR lri.audience != 'global')) AS lri_wrong_state,
        (SELECT count(*) FROM teaching_vocab WHERE 'module:numbers' = ANY(tags)
           AND status IS DISTINCT FROM 'deprecated') AS total_vocab
    `;
    const { rows: diagRows } = await dbQuery(diagSql);

    logger.info("[numbers] drills fetched", {
      rid: req._rid,
      count: rows.length,
      bySource,
      bySection,
      diagnostic: diagRows[0],
    });

    return res.json({ ok: true, items: rows });
  } catch (err) {
    logger.error("GET /v1/numbers/drills failed", {
      rid: req._rid,
      err: err?.message || String(err)
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
