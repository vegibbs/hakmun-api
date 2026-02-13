// FILE: hakmun-api/routes/nikl_search.js
// PURPOSE: NIKL sense lookup (read-only)
// ENDPOINT:
//   GET /v1/nikl/search?headword=...&pos_ko=...

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// GET /v1/nikl/search?headword=사과&pos_ko=명사
router.get("/v1/nikl/search", requireSession, async (req, res) => {
  try {
    const headword = (req.query.headword || "").trim();
    if (!headword) {
      return res.status(400).json({ ok: false, error: "MISSING_HEADWORD" });
    }

    const posKo = (req.query.pos_ko || "").trim() || null;

    // Find all NIKL entries matching this headword (and optionally POS)
    const entrySql = `
      SELECT
        ne.provider_target_code,
        ne.headword,
        ne.pos_ko
      FROM nikl_entries ne
      WHERE ne.provider = 'krdict'
        AND ne.headword = $1
        ${posKo ? "AND ne.pos_ko = $2" : ""}
      ORDER BY ne.provider_target_code
    `;
    const entryParams = posKo ? [headword, posKo] : [headword];
    const { rows: entryRows } = await dbQuery(entrySql, entryParams);

    if (entryRows.length === 0) {
      return res.json({ ok: true, entries: [] });
    }

    const targetCodes = entryRows.map((r) => Number(r.provider_target_code));

    // Fetch all senses for these entries
    const sensesSql = `
      SELECT
        ns.provider_target_code,
        ns.sense_no,
        ns.definition_ko,
        st.trans_word AS trans_word_en,
        st.trans_definition AS trans_definition_en
      FROM nikl_senses ns
      LEFT JOIN nikl_sense_translations st
        ON st.provider = ns.provider
       AND st.provider_target_code = ns.provider_target_code
       AND st.sense_no = ns.sense_no
       AND st.lang = 'en'
       AND st.idx = 1
      WHERE ns.provider = 'krdict'
        AND ns.provider_target_code = ANY($1)
      ORDER BY ns.provider_target_code, ns.sense_no
    `;
    const { rows: senseRows } = await dbQuery(sensesSql, [targetCodes]);

    // Group senses by entry
    const sensesByCode = {};
    for (const s of senseRows) {
      const key = s.provider_target_code;
      if (!sensesByCode[key]) sensesByCode[key] = [];
      sensesByCode[key].push({
        sense_no: s.sense_no,
        definition_ko: s.definition_ko || "",
        trans_word_en: s.trans_word_en || null,
        trans_definition_en: s.trans_definition_en || null,
        provider_target_code: s.provider_target_code,
      });
    }

    const entries = entryRows.map((e) => ({
      provider_target_code: e.provider_target_code,
      headword: e.headword,
      pos_ko: e.pos_ko || null,
      senses: sensesByCode[e.provider_target_code] || [],
    }));

    return res.json({ ok: true, entries });
  } catch (err) {
    console.error("nikl search GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
