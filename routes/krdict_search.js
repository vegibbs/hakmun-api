// FILE: hakmun-api/routes/krdict_search.js
// PURPOSE: Read-only search over the legacy krdict_term_bank (~137k entries).
// ENDPOINT:
//   GET /v1/krdict/search?term=...   (exact match)
//   GET /v1/krdict/search?q=...      (ILIKE partial match)

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// GET /v1/krdict/search?term=커피    — exact headword match
// GET /v1/krdict/search?q=커피      — partial/ILIKE match
router.get("/v1/krdict/search", requireSession, async (req, res) => {
  try {
    const term = (req.query.term || "").trim();
    const q = (req.query.q || "").trim();

    if (!term && !q) {
      return res.status(400).json({ ok: false, error: "TERM_OR_Q_REQUIRED" });
    }

    let sql;
    let params;

    if (term) {
      sql = `
        SELECT term, reading, pos, level, glosses_en
        FROM krdict_term_bank
        WHERE term = $1
        ORDER BY source_code DESC
        LIMIT 30
      `;
      params = [term];
    } else {
      sql = `
        SELECT term, reading, pos, level, glosses_en
        FROM krdict_term_bank
        WHERE term ILIKE $1
        ORDER BY
          CASE WHEN term = $2 THEN 0
               WHEN term ILIKE $3 THEN 1
               ELSE 2
          END,
          source_code DESC
        LIMIT 30
      `;
      params = [`%${q}%`, q, `${q}%`];
    }

    const { rows } = await dbQuery(sql, params);

    const entries = rows.map(r => ({
      term: r.term,
      reading: r.reading || null,
      pos: r.pos || null,
      level: r.level || null,
      glosses_en: r.glosses_en || [],
    }));

    return res.json({ ok: true, entries });
  } catch (err) {
    console.error("krdict search GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
