// FILE: hakmun-api/routes/grammar_patterns_admin.js
// PURPOSE: Admin endpoints for managing grammar pattern aliases.
// ENDPOINTS:
//   GET  /v1/admin/patterns/unmatched  — review unmatched surface forms
//   POST /v1/admin/patterns/aliases    — add new aliases

const express = require("express");
const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// GET /v1/admin/patterns/unmatched
// Returns unmatched surface forms ranked by frequency, with closest alias suggestions.
router.get("/v1/admin/patterns/unmatched", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(`
        SELECT u.surface_form, u.alias_norm, u.context_span, u.count,
               u.first_seen_at, u.last_seen_at
        FROM unmatched_grammar_patterns u
        WHERE u.owner_user_id = $1::uuid
        ORDER BY u.count DESC, u.last_seen_at DESC
      `, [userId]),
      8000,
      "db-list-unmatched"
    );

    return res.json({ ok: true, unmatched: r.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/admin/patterns/aliases
// Body: { aliases: [{ pattern_code: "GP_...", alias_raw: "-해요" }] }
// Adds new aliases and optionally backfills orphaned content_items.
router.post("/v1/admin/patterns/aliases", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases : [];
    if (aliases.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_ALIASES" });
    }
    if (aliases.length > 50) {
      return res.status(413).json({ ok: false, error: "TOO_MANY_ALIASES" });
    }

    let added = 0;
    let backfilled = 0;

    for (const a of aliases) {
      const code = typeof a?.pattern_code === "string" ? a.pattern_code.trim() : "";
      const raw = typeof a?.alias_raw === "string" ? a.alias_raw.trim() : "";
      if (!code || !raw) continue;

      const norm = raw.replace(/[\s\t\n\r]/g, "");

      const ins = await withTimeout(
        pool.query(`
          INSERT INTO grammar_pattern_aliases (grammar_pattern_id, alias_raw, alias_norm)
          SELECT gp.id, $2, $3
          FROM grammar_patterns gp
          WHERE gp.code = $1
          ON CONFLICT DO NOTHING
          RETURNING grammar_pattern_id
        `, [code, raw, norm]),
        8000,
        "db-insert-alias"
      );

      if (ins.rows.length > 0) {
        added++;
        const patternId = ins.rows[0].grammar_pattern_id;

        // Backfill orphaned content_items that match this new alias
        const bf = await withTimeout(
          pool.query(`
            UPDATE content_items
            SET grammar_pattern_id = $1
            WHERE content_type = 'pattern'
              AND grammar_pattern_id IS NULL
              AND replace(replace(replace(replace(split_part(text, E'\n', 1), ' ', ''), E'\t', ''), E'\n', ''), E'\r', '') = $2
            RETURNING content_item_id
          `, [patternId, norm]),
          8000,
          "db-backfill-alias"
        );
        backfilled += bf.rowCount;

        // Remove from unmatched table if it was there
        await withTimeout(
          pool.query(`
            DELETE FROM unmatched_grammar_patterns
            WHERE alias_norm = $1
          `, [norm]),
          8000,
          "db-clean-unmatched"
        ).catch(() => {});
      }
    }

    return res.json({ ok: true, aliases_added: added, items_backfilled: backfilled });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
