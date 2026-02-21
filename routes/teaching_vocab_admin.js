// FILE: hakmun-api/routes/teaching_vocab_admin.js
// PURPOSE: Teaching vocabulary admin editor (Approver-gated)
// ENDPOINTS:
//   PATCH /v1/admin/teaching_vocab/:vocab_id/:sense_index
//   POST  /v1/admin/teaching_vocab

const express = require("express");
const router = express.Router();

const { requireSession, requireEntitlement } = require("../auth/session");
const db = require("../db/pool");

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

function looksLikeUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

const VALID_POS_CODES = [
  "noun", "pronoun", "numeral", "verb", "adjective", "adverb",
  "determiner", "particle", "interjection", "dependent_noun", "auxiliary", "loanword", "unknown",
];

// Shared query: return a teaching vocab item with NIKL + override joins
const returnItemSql = `
  SELECT
    (tv.id::text || ':' || ap.sense_index::text) AS id,
    tv.id AS vocab_id,
    ap.sense_index,

    tv.lemma,
    ne.pos_ko AS nikl_pos_ko,
    ns.definition_ko AS nikl_definition_ko,
    st.trans_word AS nikl_trans_word_en,
    st.trans_definition AS nikl_trans_definition_en,

    ov_en.word_override AS tv_override_nikl_trans_word_en,
    ov_en.definition_override AS tv_override_nikl_trans_definition_en,
    ov_en.pos_override AS tv_override_en_lookup_from_nikl_pos_ko,

    ap.gloss_en AS legacy_gloss_en,
    ap.nikl_target_code,
    ap.nikl_sense_no

  FROM teaching_vocab_split_apply_plan ap
  JOIN teaching_vocab tv
    ON tv.id = ap.vocab_id

  LEFT JOIN nikl_entries ne
    ON ne.provider = 'krdict'
   AND ne.provider_target_code = ap.nikl_target_code

  LEFT JOIN nikl_senses ns
    ON ns.provider = 'krdict'
   AND ns.provider_target_code = ap.nikl_target_code
   AND ns.sense_no = ap.nikl_sense_no

  LEFT JOIN nikl_sense_translations st
    ON st.provider = 'krdict'
   AND st.provider_target_code = ap.nikl_target_code
   AND st.sense_no = ap.nikl_sense_no
   AND st.lang = 'en'
   AND st.idx = 1

  LEFT JOIN teaching_vocab_localized_overrides ov_en
    ON ov_en.vocab_id = ap.vocab_id
   AND ov_en.sense_index = ap.sense_index
   AND ov_en.lang = 'en'

  WHERE ap.vocab_id = $1::uuid AND ap.sense_index = $2
`;

// PATCH /v1/admin/teaching_vocab/:vocab_id/:sense_index
router.patch(
  "/v1/admin/teaching_vocab/:vocab_id/:sense_index",
  requireSession,
  requireEntitlement("approver:content"),
  async (req, res) => {
    try {
      const vocabId = req.params.vocab_id;
      const senseIndex = parseInt(req.params.sense_index, 10);

      if (!looksLikeUUID(vocabId)) {
        return res.status(400).json({ ok: false, error: "INVALID_VOCAB_ID" });
      }
      if (isNaN(senseIndex) || senseIndex < 1) {
        return res.status(400).json({ ok: false, error: "INVALID_SENSE_INDEX" });
      }

      const {
        nikl_target_code,
        nikl_sense_no,
        tv_override_nikl_trans_word_en,
        tv_override_nikl_trans_definition_en,
        tv_override_en_lookup_from_nikl_pos_ko,
      } = req.body || {};

      // Validate NIKL pair exists if provided
      if (nikl_target_code != null && nikl_sense_no != null) {
        const checkSql = `
          SELECT 1 FROM nikl_senses
          WHERE provider = 'krdict'
            AND provider_target_code = $1
            AND sense_no = $2
        `;
        const { rows: checkRows } = await dbQuery(checkSql, [nikl_target_code, nikl_sense_no]);
        if (checkRows.length === 0) {
          return res.status(400).json({ ok: false, error: "INVALID_NIKL_SENSE" });
        }
      }

      // Verify the row exists
      const existsSql = `
        SELECT 1 FROM teaching_vocab_split_apply_plan
        WHERE vocab_id = $1::uuid AND sense_index = $2
      `;
      const { rows: existsRows } = await dbQuery(existsSql, [vocabId, senseIndex]);
      if (existsRows.length === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // Update the apply plan row
      const updateSql = `
        UPDATE teaching_vocab_split_apply_plan
        SET
          nikl_target_code = COALESCE($3, nikl_target_code),
          nikl_sense_no = COALESCE($4, nikl_sense_no)
        WHERE vocab_id = $1::uuid AND sense_index = $2
      `;
      await dbQuery(updateSql, [vocabId, senseIndex, nikl_target_code, nikl_sense_no]);

      // Upsert the localized overrides (English)
      const overrideSql = `
        INSERT INTO teaching_vocab_localized_overrides
          (vocab_id, sense_index, lang, word_override, definition_override, pos_override)
        VALUES ($1::uuid, $2, 'en', $3, $4, $5)
        ON CONFLICT (vocab_id, sense_index, lang)
        DO UPDATE SET
          word_override = EXCLUDED.word_override,
          definition_override = EXCLUDED.definition_override,
          pos_override = EXCLUDED.pos_override,
          updated_at = NOW()
      `;
      await dbQuery(overrideSql, [
        vocabId,
        senseIndex,
        tv_override_nikl_trans_word_en || null,
        tv_override_nikl_trans_definition_en || null,
        tv_override_en_lookup_from_nikl_pos_ko || null,
      ]);

      const { rows } = await dbQuery(returnItemSql, [vocabId, senseIndex]);

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND_AFTER_UPDATE" });
      }

      return res.json(rows[0]);
    } catch (err) {
      console.error("teaching vocab PATCH failed:", err);
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// POST /v1/admin/teaching_vocab — create a new teaching vocab entry
router.post(
  "/v1/admin/teaching_vocab",
  requireSession,
  requireEntitlement("approver:content"),
  async (req, res) => {
    try {
      const {
        lemma,
        part_of_speech,
        pos_code,
        nikl_target_code,
        nikl_sense_no,
        tv_override_nikl_trans_word_en,
        tv_override_nikl_trans_definition_en,
        tv_override_en_lookup_from_nikl_pos_ko,
      } = req.body || {};

      // Validate required fields
      const trimmedLemma = (lemma || "").trim();
      if (!trimmedLemma) {
        return res.status(400).json({ ok: false, error: "MISSING_LEMMA" });
      }

      const trimmedPos = (part_of_speech || "").trim();
      if (!trimmedPos) {
        return res.status(400).json({ ok: false, error: "MISSING_PART_OF_SPEECH" });
      }

      const trimmedPosCode = (pos_code || "unknown").trim();
      if (!VALID_POS_CODES.includes(trimmedPosCode)) {
        return res.status(400).json({ ok: false, error: "INVALID_POS_CODE", valid: VALID_POS_CODES });
      }

      // Validate NIKL pair exists if provided
      if (nikl_target_code != null && nikl_sense_no != null) {
        const checkSql = `
          SELECT 1 FROM nikl_senses
          WHERE provider = 'krdict'
            AND provider_target_code = $1
            AND sense_no = $2
        `;
        const { rows: checkRows } = await dbQuery(checkSql, [nikl_target_code, nikl_sense_no]);
        if (checkRows.length === 0) {
          return res.status(400).json({ ok: false, error: "INVALID_NIKL_SENSE" });
        }
      }

      // Insert teaching_vocab — ON CONFLICT returns 409 with existing id
      const insertTvSql = `
        INSERT INTO teaching_vocab (lemma, part_of_speech, pos_code, pos_label, status, created_by)
        VALUES ($1, $2, $3, $4, 'provisional', $5)
        ON CONFLICT (lemma, part_of_speech) DO NOTHING
        RETURNING id
      `;
      const { rows: tvRows } = await dbQuery(insertTvSql, [
        trimmedLemma,
        trimmedPos,
        trimmedPosCode,
        trimmedPos, // pos_label = part_of_speech (Korean label)
        req.user.userID,
      ]);

      if (tvRows.length === 0) {
        // Conflict — word already exists
        const existingSql = `
          SELECT id FROM teaching_vocab
          WHERE lemma = $1 AND part_of_speech = $2
          LIMIT 1
        `;
        const { rows: existingRows } = await dbQuery(existingSql, [trimmedLemma, trimmedPos]);
        return res.status(409).json({
          ok: false,
          error: "DUPLICATE",
          existing_vocab_id: existingRows[0]?.id || null,
        });
      }

      const vocabId = tvRows[0].id;

      // Insert split_apply_plan row (sense_index = 1)
      const glossEn = tv_override_nikl_trans_word_en || "";
      const insertApSql = `
        INSERT INTO teaching_vocab_split_apply_plan
          (vocab_id, sense_index, gloss_en, vocab_type, part_of_speech, pos_code, nikl_target_code, nikl_sense_no)
        VALUES ($1::uuid, 1, $2, 'word', $3, $4, $5, $6)
      `;
      await dbQuery(insertApSql, [
        vocabId,
        glossEn,
        trimmedPos,
        trimmedPosCode,
        nikl_target_code != null ? String(nikl_target_code) : null,
        nikl_sense_no != null ? nikl_sense_no : null,
      ]);

      // Upsert localized overrides if any provided
      const hasOverride = tv_override_nikl_trans_word_en || tv_override_nikl_trans_definition_en || tv_override_en_lookup_from_nikl_pos_ko;
      if (hasOverride) {
        const overrideSql = `
          INSERT INTO teaching_vocab_localized_overrides
            (vocab_id, sense_index, lang, word_override, definition_override, pos_override)
          VALUES ($1::uuid, 1, 'en', $2, $3, $4)
          ON CONFLICT (vocab_id, sense_index, lang)
          DO UPDATE SET
            word_override = EXCLUDED.word_override,
            definition_override = EXCLUDED.definition_override,
            pos_override = EXCLUDED.pos_override,
            updated_at = NOW()
        `;
        await dbQuery(overrideSql, [
          vocabId,
          tv_override_nikl_trans_word_en || null,
          tv_override_nikl_trans_definition_en || null,
          tv_override_en_lookup_from_nikl_pos_ko || null,
        ]);
      }

      // Return the created item
      const { rows } = await dbQuery(returnItemSql, [vocabId, 1]);
      if (rows.length === 0) {
        return res.status(500).json({ ok: false, error: "CREATED_BUT_NOT_FOUND" });
      }

      return res.status(201).json(rows[0]);
    } catch (err) {
      console.error("teaching vocab POST failed:", err);
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

module.exports = router;
