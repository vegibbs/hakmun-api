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
//   - hanja:ALL
//   - my_pins
//   - my_vocab

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");
const { generatePracticeSentences, validatePracticeSentences } = require("../util/openai");
const { logger } = require("../util/log");

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
  if (setId === "hanja:ALL") return { kind: "hanja_all" };
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
        set_id: "hanja:ALL",
        kind: "hanja",
        title: "Hanja",
        subtitle: "By frequency",
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
        (tv.id::text || ':' || ap.sense_index::text) AS id,
        tv.id AS vocab_id,
        ap.sense_index,

        -- Canonical (NIKL)
        tv.lemma,
        ne.pos_ko AS nikl_pos_ko,
        ns.definition_ko AS nikl_definition_ko,
        st.trans_word AS nikl_trans_word_en,
        st.trans_definition AS nikl_trans_definition_en,

        -- TV override columns (editable)
        ov_en.word_override AS tv_override_nikl_trans_word_en,
        ov_en.definition_override AS tv_override_nikl_trans_definition_en,
        ov_en.pos_override AS tv_override_en_lookup_from_nikl_pos_ko,

        -- Legacy reference (temporary)
        ap.gloss_en AS legacy_gloss_en,

        -- Linkage (useful for matching / editor)
        ap.nikl_target_code,
        ap.nikl_sense_no,

        -- CEFR classification
        tv.cefr_level,
        tv.cefr_confidence::float AS cefr_confidence,
        tv.cefr_authority

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

      WHERE tv.status IS DISTINCT FROM 'archived'
      ORDER BY tv.lemma, ap.sense_index
      LIMIT 50000
    `;
      const { rows } = await dbQuery(sql, []);
      return res.json({ ok: true, set_id: setId, kind: "teaching", items: rows || [] });
    }

    if (parsed.kind === "hanja_all") {
      const sql = `
        SELECT
          hc.id,
          hc.hanja,
          hr.reading_hangul,
          ht_ko.text_value AS gloss_ko,
          ht_en.text_value AS meaning_en,
          hl.level_code,
          r.freq_words,
          r.rank_global
        FROM hanja_character_ranking_mv r
        JOIN hanja_characters hc ON hc.id = r.hanja_character_id
        LEFT JOIN hanja_texts ht_ko
          ON ht_ko.hanja_character_id = hc.id
         AND ht_ko.lang = 'ko'
         AND ht_ko.text_type = 'gloss'
        LEFT JOIN hanja_texts ht_en
          ON ht_en.hanja_character_id = hc.id
         AND ht_en.lang = 'en'
         AND ht_en.text_type = 'meaning'
        LEFT JOIN hanja_readings hr
          ON hr.hanja_character_id = hc.id
        LEFT JOIN hanja_character_levels hl
          ON hl.hanja_character_id = hc.id
        ORDER BY r.rank_global
      `;
      const { rows } = await dbQuery(sql, []);
      return res.json({ ok: true, set_id: setId, kind: "hanja", items: rows || [] });
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

// GET /v1/hanja/:id/words
// Returns 5-10 Korean words that contain the given hanja character.
router.get("/v1/hanja/:id/words", requireSession, async (req, res) => {
  try {
    const hanjaCharacterId = req.params.id;
    const sql = `
      SELECT
        ne.headword,
        ne.pos_ko,
        ns.definition_ko,
        nst.trans_word AS meaning_en
      FROM nikl_entry_hanja_link l
      JOIN nikl_entries ne
        ON ne.provider = l.provider
       AND ne.provider_target_code = l.provider_target_code
      LEFT JOIN nikl_senses ns
        ON ns.provider = ne.provider
       AND ns.provider_target_code = ne.provider_target_code
       AND ns.sense_no = 1
      LEFT JOIN nikl_sense_translations nst
        ON nst.provider = ns.provider
       AND nst.provider_target_code = ns.provider_target_code
       AND nst.sense_no = ns.sense_no
       AND nst.lang = 'en'
      WHERE l.hanja_character_id = $1
      ORDER BY ne.headword
      LIMIT 10
    `;
    const { rows } = await dbQuery(sql, [hanjaCharacterId]);
    return res.json({ ok: true, hanja_character_id: hanjaCharacterId, words: rows || [] });
  } catch (err) {
    console.error("hanja words GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/hanja/:id/practice-session
// Generates practice sentences for hanja-derived words using the shared
// generate + validate pipeline. Returns sentences for client-side review
// (not committed yet — commit happens via POST /v1/practice-lists/commit).
router.post("/v1/hanja/:id/practice-session", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  try {
    const hanjaCharacterId = req.params.id;
    const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 20);
    const perspective = ["first_person", "third_person"].includes(req.body?.perspective)
      ? req.body.perspective : "first_person";
    const politeness = ["해요체", "합니다체", "반말"].includes(req.body?.politeness)
      ? req.body.politeness : "해요체";

    // 1. Get the words for this hanja character
    const wordsSql = `
      SELECT DISTINCT ne.headword
      FROM nikl_entry_hanja_link l
      JOIN nikl_entries ne
        ON ne.provider = l.provider
       AND ne.provider_target_code = l.provider_target_code
      WHERE l.hanja_character_id = $1
      ORDER BY ne.headword
      LIMIT 10
    `;
    const { rows: wordRows } = await dbQuery(wordsSql, [hanjaCharacterId]);
    const headwords = wordRows.map(r => r.headword);

    if (headwords.length === 0) {
      return res.json({ ok: true, practice_sentences: [] });
    }

    // 2. Get hanja character context for the generation prompt
    const hanjaSql = `
      SELECT hc.hanja, hr.reading_hangul, ht_ko.text_value AS gloss_ko
      FROM hanja_characters hc
      LEFT JOIN hanja_readings hr ON hr.hanja_character_id = hc.id
      LEFT JOIN hanja_texts ht_ko
        ON ht_ko.hanja_character_id = hc.id AND ht_ko.lang = 'ko' AND ht_ko.text_type = 'gloss'
      WHERE hc.id = $1
    `;
    const { rows: hanjaRows } = await dbQuery(hanjaSql, [hanjaCharacterId]);
    const hanjaChar = hanjaRows[0]?.hanja || "";
    const hanjaReading = hanjaRows[0]?.reading_hangul || "";
    const hanjaGloss = hanjaRows[0]?.gloss_ko || "";

    // 3. Search for existing approved sentences containing each word
    const sentenceSql = `
      SELECT DISTINCT ON (ci.content_item_id)
        ci.content_item_id,
        ci.text,
        ci.notes,
        ci.cefr_level,
        ci.topic
      FROM content_items ci
      JOIN library_registry_items lri
        ON lri.content_type = 'sentence'
       AND lri.content_id = ci.content_item_id
       AND lri.global_state = 'approved'
       AND lri.operational_status = 'active'
      WHERE ci.content_type = 'sentence'
        AND ci.text ILIKE $1
      LIMIT $2
    `;

    const foundSentences = [];
    const coveredWords = new Set();
    const uncoveredWords = [];

    for (const word of headwords) {
      const { rows } = await dbQuery(sentenceSql, [`%${word}%`, count]);
      if (rows.length > 0) {
        coveredWords.add(word);
        for (const row of rows) {
          if (!foundSentences.find(s => s.ko === row.text)) {
            foundSentences.push({
              ko: row.text,
              en: row.notes || "",
              group_label: word,
              cefr_level: row.cefr_level,
              topic: row.topic,
              naturalness_score: 1.0,
              validation_score: 1.0,
              validation_natural: true,
              source_words: [word],
              issues: [],
              suggested_fix: null,
              explanation: "",
              politeness: null,
              tense: null
            });
          }
        }
      } else {
        uncoveredWords.push(word);
      }
    }

    // 4. Generate via AI only for words without existing sentences
    let generated = [];
    if (uncoveredWords.length > 0) {
      // Fetch user CEFR level
      let cefrLevel = "A1";
      try {
        const { pool: p } = db;
        const uR = await p.query(`SELECT cefr_current FROM users WHERE user_id = $1::uuid`, [userId]);
        cefrLevel = uR.rows?.[0]?.cefr_current || "A1";
      } catch (e) {
        logger.warn("[hanja-practice] cefr fetch failed, defaulting to A1", { err: e?.message });
      }

      // Build context text — each uncovered word is a type
      const wordLines = uncoveredWords.map(w => `- ${w}`).join("\n");
      const contextText = `Hanja vocabulary practice — character ${hanjaChar} (${hanjaReading} — ${hanjaGloss})

The following vocabulary words all share the hanja character ${hanjaChar}.
Each word is a separate practice type — use the word itself as the group_label.

Words (one type per word):
${wordLines}

For each word, generate sentences that naturally use it in everyday context.
Include the practiced word in the source_words array for each sentence.`;

      const LLM_TIMEOUT = 90_000;
      const genResult = await generatePracticeSentences({
        text: contextText,
        cefrLevel,
        glossLang: "en",
        count,
        perspective,
        politeness,
        timeoutMs: LLM_TIMEOUT
      });

      generated = genResult.sentences || [];

      // Validate for naturalness (second LLM pass)
      if (generated.length > 0) {
        try {
          const valResult = await validatePracticeSentences(generated, "en", LLM_TIMEOUT);
          const validations = valResult.validations || [];
          for (const v of validations) {
            const idx = v.index - 1;
            if (idx >= 0 && idx < generated.length) {
              generated[idx].validation_score = v.naturalness_score;
              generated[idx].validation_natural = v.natural;
              generated[idx].issues = v.issues;
              generated[idx].suggested_fix = v.suggested_fix;
              generated[idx].explanation = v.explanation;
            }
          }
        } catch (valErr) {
          logger.warn("[hanja-practice] validation failed, returning unvalidated", { err: valErr?.message });
        }
      }
    }

    // 5. Combine: existing sentences first, then generated (cap at 20)
    const MAX_SENTENCES = 20;
    const allSentences = [...foundSentences, ...generated].slice(0, MAX_SENTENCES);

    return res.json({
      ok: true,
      practice_sentences: allSentences,
    });
  } catch (err) {
    logger.error("[hanja-practice] practice-session POST failed", { err: err?.message, stack: err?.stack });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;