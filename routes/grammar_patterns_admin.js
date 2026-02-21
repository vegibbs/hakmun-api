// FILE: hakmun-api/routes/grammar_patterns_admin.js
// PURPOSE: Admin endpoints for managing grammar pattern aliases.
// ENDPOINTS:
//   GET  /v1/admin/patterns/unmatched  — review unmatched surface forms
//   GET  /v1/admin/patterns/suggest    — suggest canonical patterns for a surface form
//   POST /v1/admin/patterns/aliases    — add new aliases

const express = require("express");
const { requireSession, requireRole } = require("../auth/session");
const { pool } = require("../db/pool");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// GET /v1/admin/patterns/unmatched
// Returns unmatched surface forms ranked by frequency, with closest alias suggestions.
router.get("/v1/admin/patterns/unmatched", requireSession, requireRole("teacher", "approver"), async (req, res) => {
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

// GET /v1/admin/patterns/suggest?surface=-해요
// GET /v1/admin/patterns/suggest?q=reason    (keyword search across display_name, code, aliases)
// Returns canonical grammar patterns ranked by similarity or keyword match.
// Each result includes the pattern's code, display_name, pattern_group, and existing aliases.
router.get("/v1/admin/patterns/suggest", requireSession, requireRole("teacher", "approver"), async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const surface = typeof req.query?.surface === "string" ? req.query.surface.trim() : "";
    const q = typeof req.query?.q === "string" ? req.query.q.trim().toLowerCase() : "";
    if (!surface && !q) return res.status(400).json({ ok: false, error: "SURFACE_OR_Q_REQUIRED" });

    // Normalize: strip dashes, whitespace
    const norm = surface.replace(/[-\s\t\n\r]/g, "");

    // Fetch all active patterns with their aliases in one query
    const r = await withTimeout(
      pool.query(`
        SELECT gp.id, gp.code, gp.display_name, gp.pattern_group,
               gp.meaning_en_short,
               json_agg(json_build_object(
                 'alias_raw', gpa.alias_raw,
                 'alias_norm', gpa.alias_norm
               ) ORDER BY gpa.alias_raw) FILTER (WHERE gpa.alias_id IS NOT NULL) AS aliases
        FROM grammar_patterns gp
        LEFT JOIN grammar_pattern_aliases gpa ON gpa.grammar_pattern_id = gp.id
        WHERE gp.active = true
        GROUP BY gp.id, gp.code, gp.display_name, gp.pattern_group, gp.meaning_en_short
        ORDER BY gp.display_name
      `),
      8000,
      "db-suggest-patterns"
    );

    // Score each pattern
    const scored = r.rows.map(row => {
      const aliases = row.aliases || [];
      let bestScore = 0;
      let bestAlias = null;

      if (surface) {
        // Surface-form similarity scoring
        for (const a of aliases) {
          const aNorm = (a.alias_norm || "").replace(/-/g, "");
          if (!aNorm) continue;

          let score = 0;

          // Exact match (ignoring dashes)
          if (aNorm === norm) {
            score = 100;
          }
          // Surface contains alias or alias contains surface
          else if (norm.includes(aNorm)) {
            score = 60 + Math.min(30, Math.round(30 * aNorm.length / norm.length));
          } else if (aNorm.includes(norm)) {
            score = 50 + Math.min(30, Math.round(30 * norm.length / aNorm.length));
          }
          // Shared suffix (common for Korean endings)
          else {
            let shared = 0;
            const minLen = Math.min(norm.length, aNorm.length);
            for (let i = 1; i <= minLen; i++) {
              if (norm[norm.length - i] === aNorm[aNorm.length - i]) shared++;
              else break;
            }
            if (shared >= 2) {
              score = 10 + Math.min(30, Math.round(30 * shared / minLen));
            }
          }

          if (score > bestScore) {
            bestScore = score;
            bestAlias = a.alias_raw;
          }
        }

        // Also check display_name
        const dnNorm = (row.display_name || "").replace(/[-\s]/g, "");
        if (dnNorm === norm) {
          bestScore = Math.max(bestScore, 95);
        } else if (norm.includes(dnNorm) || dnNorm.includes(norm)) {
          bestScore = Math.max(bestScore, 55);
        }
      }

      if (q) {
        // Keyword search: match against code, display_name, aliases, meaning_en_short
        const dn = (row.display_name || "").toLowerCase();
        const code = (row.code || "").toLowerCase();
        const meaning = (row.meaning_en_short || "").toLowerCase();
        const aliasText = aliases.map(a => (a.alias_raw || "").toLowerCase()).join(" ");

        if (dn.includes(q) || code.includes(q) || meaning.includes(q) || aliasText.includes(q)) {
          // Exact name match scores highest
          if (dn === q) bestScore = Math.max(bestScore, 100);
          else if (dn.includes(q)) bestScore = Math.max(bestScore, 80);
          else if (code.includes(q)) bestScore = Math.max(bestScore, 70);
          else if (meaning.includes(q)) bestScore = Math.max(bestScore, 60);
          else bestScore = Math.max(bestScore, 50);
        }
      }

      return {
        pattern_id: row.id,
        code: row.code,
        display_name: row.display_name,
        pattern_group: row.pattern_group,
        meaning_en_short: row.meaning_en_short || null,
        aliases: aliases.map(a => a.alias_raw).filter(Boolean),
        score: bestScore,
        best_alias: bestAlias
      };
    });

    // Return patterns with score > 0, sorted by score descending, capped at 30
    const suggestions = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);

    return res.json({ ok: true, surface: surface || null, q: q || null, suggestions });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/admin/patterns/aliases
// Body: { aliases: [{ pattern_code: "GP_...", alias_raw: "-해요" }] }
// Adds new aliases and optionally backfills orphaned content_items.
router.post("/v1/admin/patterns/aliases", requireSession, requireRole("teacher", "approver"), async (req, res) => {
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

      // Resolve the pattern_id: either from the just-inserted alias, or by looking up the existing one
      let patternId = null;
      if (ins.rows.length > 0) {
        added++;
        patternId = ins.rows[0].grammar_pattern_id;
      } else {
        // Alias already exists — look up the pattern_id it points to
        const existing = await withTimeout(
          pool.query(`
            SELECT gpa.grammar_pattern_id
            FROM grammar_pattern_aliases gpa
            JOIN grammar_patterns gp ON gp.id = gpa.grammar_pattern_id
            WHERE gp.code = $1 AND gpa.alias_norm = $2
            LIMIT 1
          `, [code, norm]),
          8000,
          "db-lookup-existing-alias"
        );
        if (existing.rows.length > 0) {
          patternId = existing.rows[0].grammar_pattern_id;
        }
      }

      if (patternId) {
        // Backfill orphaned content_items that match this alias
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
