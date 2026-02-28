// FILE: hakmun-api/routes/vocab_builder.js
// PURPOSE: Vocabulary Builder endpoints — search, detail, practice-session
// ENDPOINTS:
//   GET  /v1/vocab/search          — typeahead search across teaching_vocab + glosses
//   GET  /v1/vocab/:id/detail      — full NIKL info for one word
//   POST /v1/vocab/practice-session — generate practice sentences for selected words

const express = require("express");
const router = express.Router();
const { requireSession } = require("../auth/session");
const db = require("../db/pool");
const { generatePracticeSentences, validatePracticeSentences } = require("../util/openai");
const { logger } = require("../util/log");
const { signImageUrl, signImageUrls } = require("../util/s3");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// ---------------------------------------------------------------------------
// GET /v1/vocab/search — typeahead search
// ---------------------------------------------------------------------------
router.get("/v1/vocab/search", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.json({ ok: true, results: [] });

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

    const sql = `
      SELECT DISTINCT ON (tv.id)
        tv.id AS vocab_id,
        tv.lemma,
        vg.text AS gloss_en,
        tv.part_of_speech AS pos_ko,
        tv.pos_code,
        tv.cefr_level,
        tv.image_s3_key,
        ne.word_type_ko,
        neh.hanja_text
      FROM teaching_vocab tv
      LEFT JOIN vocab_glosses vg
        ON vg.vocab_id = tv.id AND vg.language = 'en' AND vg.is_primary = true
      LEFT JOIN teaching_vocab_split_apply_plan ap
        ON ap.vocab_id = tv.id AND ap.sense_index = 1
      LEFT JOIN nikl_entries ne
        ON ne.provider = 'krdict' AND ne.provider_target_code = ap.nikl_target_code
      LEFT JOIN nikl_entry_hanja neh
        ON neh.provider = 'krdict' AND neh.provider_target_code = ap.nikl_target_code
      WHERE tv.status IS DISTINCT FROM 'deprecated'
        AND (tv.lemma ILIKE $1 OR vg.text ILIKE $1)
      ORDER BY tv.id,
        CASE
          WHEN tv.lemma = $2 THEN 0
          WHEN LOWER(vg.text) = LOWER($2) THEN 1
          WHEN tv.lemma ILIKE $3 THEN 2
          WHEN vg.text ILIKE $3 THEN 3
          ELSE 4
        END
      LIMIT $4
    `;

    const { rows } = await dbQuery(sql, [`%${q}%`, q, `${q}%`, limit]);

    await signImageUrls(rows);
    return res.json({ ok: true, results: rows });
  } catch (err) {
    logger.error("[vocab-builder] search failed", { err: err?.message });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/vocab/:id/detail — full NIKL info for one word
// ---------------------------------------------------------------------------
router.get("/v1/vocab/:id/detail", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const vocabId = req.params.id;

    // Core vocab info
    const coreSql = `
      SELECT
        tv.id AS vocab_id,
        tv.lemma,
        tv.part_of_speech AS pos_ko,
        tv.pos_code,
        tv.cefr_level,
        tv.level,
        tv.image_s3_key,
        vg.text AS gloss_en,
        ne.word_type_ko,
        ne.word_grade_ko,
        neh.hanja_text,
        ap.nikl_target_code,
        ap.sense_index
      FROM teaching_vocab tv
      LEFT JOIN vocab_glosses vg
        ON vg.vocab_id = tv.id AND vg.language = 'en' AND vg.is_primary = true
      LEFT JOIN teaching_vocab_split_apply_plan ap
        ON ap.vocab_id = tv.id AND ap.sense_index = 1
      LEFT JOIN nikl_entries ne
        ON ne.provider = 'krdict' AND ne.provider_target_code = ap.nikl_target_code
      LEFT JOIN nikl_entry_hanja neh
        ON neh.provider = 'krdict' AND neh.provider_target_code = ap.nikl_target_code
      WHERE tv.id = $1::uuid
    `;

    const { rows: coreRows } = await dbQuery(coreSql, [vocabId]);
    if (coreRows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const core = coreRows[0];

    // NIKL senses with translations and examples
    let senses = [];
    if (core.nikl_target_code) {
      const sensesSql = `
        SELECT
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
          AND ns.provider_target_code = $1
        ORDER BY ns.sense_no
      `;
      const { rows: senseRows } = await dbQuery(sensesSql, [core.nikl_target_code]);

      // Get examples for each sense
      for (const sense of senseRows) {
        const exSql = `
          SELECT example_text_ko AS text, example_type_ko AS type
          FROM nikl_sense_examples
          WHERE provider = 'krdict'
            AND provider_target_code = $1
            AND sense_no = $2
          ORDER BY idx
          LIMIT 5
        `;
        const { rows: exRows } = await dbQuery(exSql, [core.nikl_target_code, sense.sense_no]);
        sense.examples = exRows;
      }

      senses = senseRows;
    }

    // Hanja character breakdown (for 한자어 words)
    let hanja_breakdown = [];
    if (core.hanja_text) {
      const chars = [...core.hanja_text]; // split into individual characters
      if (chars.length > 0) {
        const hanjaSql = `
          SELECT
            hc.hanja AS character,
            hr.reading_hangul,
            ht_ko.text_value AS gloss_ko,
            ht_en.text_value AS meaning_en
          FROM hanja_characters hc
          LEFT JOIN hanja_readings hr ON hr.hanja_character_id = hc.id
          LEFT JOIN hanja_texts ht_ko
            ON ht_ko.hanja_character_id = hc.id
           AND ht_ko.lang = 'ko' AND ht_ko.text_type = 'gloss' AND ht_ko.is_primary = true
          LEFT JOIN hanja_texts ht_en
            ON ht_en.hanja_character_id = hc.id
           AND ht_en.lang = 'en' AND ht_en.text_type = 'meaning' AND ht_en.is_primary = true
          WHERE hc.hanja = ANY($1)
        `;
        const { rows: hanjaRows } = await dbQuery(hanjaSql, [chars]);
        // Reorder to match character order in original hanja_text
        for (const ch of chars) {
          const found = hanjaRows.find(r => r.character === ch);
          if (found) hanja_breakdown.push(found);
          else hanja_breakdown.push({ character: ch, reading_hangul: null, gloss_ko: null, meaning_en: null });
        }
      }
    }

    const image_url = await signImageUrl(core.image_s3_key);

    return res.json({
      ok: true,
      vocab_id: core.vocab_id,
      lemma: core.lemma,
      gloss_en: core.gloss_en,
      pos_ko: core.pos_ko,
      pos_code: core.pos_code,
      cefr_level: core.cefr_level,
      level: core.level,
      image_url,
      word_type_ko: core.word_type_ko,
      word_grade_ko: core.word_grade_ko,
      hanja_text: core.hanja_text,
      senses,
      hanja_breakdown
    });
  } catch (err) {
    logger.error("[vocab-builder] detail failed", { err: err?.message });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/vocab/practice-session — generate practice sentences for words
// ---------------------------------------------------------------------------
router.post("/v1/vocab/practice-session", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  try {
    const vocabIds = Array.isArray(req.body?.vocab_ids) ? req.body.vocab_ids.filter(id => typeof id === "string") : [];
    if (vocabIds.length === 0) return res.status(400).json({ ok: false, error: "NO_VOCAB_IDS" });
    if (vocabIds.length > 10) return res.status(400).json({ ok: false, error: "TOO_MANY_VOCAB_IDS" });

    const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 20);
    const perspective = ["first_person", "third_person"].includes(req.body?.perspective)
      ? req.body.perspective : "first_person";
    const politeness = ["해요체", "합니다체", "반말"].includes(req.body?.politeness)
      ? req.body.politeness : "해요체";

    // 1. Look up lemmas for the given vocab IDs
    const lemmaSql = `
      SELECT tv.id, tv.lemma, vg.text AS gloss_en
      FROM teaching_vocab tv
      LEFT JOIN vocab_glosses vg ON vg.vocab_id = tv.id AND vg.language = 'en' AND vg.is_primary = true
      WHERE tv.id = ANY($1::uuid[])
    `;
    const { rows: vocabRows } = await dbQuery(lemmaSql, [vocabIds]);
    const lemmaMap = new Map(vocabRows.map(r => [r.id, r]));

    if (vocabRows.length === 0) {
      return res.json({ ok: true, practice_sentences: [], audio_sentence_ids: [] });
    }

    // 2. Search for existing sentences containing each word
    //    a) Via sentence_vocab_links (precise linkage)
    //    b) Via text ILIKE fallback on content_items
    const sentenceSql = `
      SELECT DISTINCT ON (ci.content_item_id)
        ci.content_item_id,
        ci.text,
        ci.notes,
        ci.cefr_level,
        ci.topic,
        EXISTS (
          SELECT 1 FROM content_item_audio_variants cav
          WHERE cav.content_item_id = ci.content_item_id
        ) AS has_audio
      FROM content_items ci
      JOIN sentence_vocab_links svl
        ON svl.sentence_content_item_id = ci.content_item_id
      WHERE svl.teaching_vocab_id = $1::uuid
        AND ci.content_type = 'sentence'
      LIMIT $2
    `;

    const fallbackSql = `
      SELECT DISTINCT ON (ci.content_item_id)
        ci.content_item_id,
        ci.text,
        ci.notes,
        ci.cefr_level,
        ci.topic,
        EXISTS (
          SELECT 1 FROM content_item_audio_variants cav
          WHERE cav.content_item_id = ci.content_item_id
        ) AS has_audio
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
    const audioSentenceIds = [];
    const coveredWords = new Set();
    const uncoveredWords = [];
    const seenTexts = new Set();

    for (const vocabId of vocabIds) {
      const vocab = lemmaMap.get(vocabId);
      if (!vocab) continue;

      let found = false;

      // Try precise link first
      const { rows: linkedRows } = await dbQuery(sentenceSql, [vocabId, count]);
      for (const row of linkedRows) {
        if (seenTexts.has(row.text)) continue;
        seenTexts.add(row.text);
        found = true;
        foundSentences.push({
          ko: row.text,
          en: row.notes || "",
          group_label: vocab.lemma,
          cefr_level: row.cefr_level,
          topic: row.topic,
          naturalness_score: 1.0,
          validation_score: 1.0,
          validation_natural: true,
          source_words: [vocab.lemma],
          issues: [],
          suggested_fix: null,
          explanation: "",
          politeness: null,
          tense: null
        });
        if (row.has_audio) audioSentenceIds.push(row.content_item_id);
      }

      // Fallback: text search
      if (!found) {
        const { rows: fallbackRows } = await dbQuery(fallbackSql, [`%${vocab.lemma}%`, count]);
        for (const row of fallbackRows) {
          if (seenTexts.has(row.text)) continue;
          seenTexts.add(row.text);
          found = true;
          foundSentences.push({
            ko: row.text,
            en: row.notes || "",
            group_label: vocab.lemma,
            cefr_level: row.cefr_level,
            topic: row.topic,
            naturalness_score: 1.0,
            validation_score: 1.0,
            validation_natural: true,
            source_words: [vocab.lemma],
            issues: [],
            suggested_fix: null,
            explanation: "",
            politeness: null,
            tense: null
          });
          if (row.has_audio) audioSentenceIds.push(row.content_item_id);
        }
      }

      if (found) {
        coveredWords.add(vocab.lemma);
      } else {
        uncoveredWords.push(vocab);
      }
    }

    // 3. Generate via AI for uncovered words
    let generated = [];
    if (uncoveredWords.length > 0) {
      let cefrLevel = "A1";
      let cefrTarget = null;
      try {
        const uR = await dbQuery(`SELECT cefr_current, cefr_target FROM users WHERE user_id = $1::uuid`, [userId]);
        cefrLevel = uR.rows?.[0]?.cefr_current || "A1";
        cefrTarget = uR.rows?.[0]?.cefr_target || null;
      } catch (e) {
        logger.warn("[vocab-builder] cefr fetch failed, defaulting to A1", { err: e?.message });
      }

      const wordLines = uncoveredWords.map(w => `- ${w.lemma} (${w.gloss_en || ""})`).join("\n");
      const contextText = `Vocabulary practice — generating sentences for specific Korean words.

Each word is a separate practice type — use the word itself as the group_label.

Words (one type per word):
${wordLines}

For each word, generate sentences that naturally use it in everyday context.
Include the practiced word in the source_words array for each sentence.`;

      const LLM_TIMEOUT = 90_000;
      const genResult = await generatePracticeSentences({
        text: contextText,
        cefrLevel,
        cefrTarget,
        glossLang: "en",
        count,
        perspective,
        politeness,
        timeoutMs: LLM_TIMEOUT
      });

      generated = genResult.sentences || [];

      // Validate for naturalness
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
          logger.warn("[vocab-builder] validation failed, returning unvalidated", { err: valErr?.message });
        }
      }
    }

    // 4. Combine: existing first, then generated (cap at 20)
    const MAX_SENTENCES = 20;
    const allSentences = [...foundSentences, ...generated].slice(0, MAX_SENTENCES);

    return res.json({
      ok: true,
      practice_sentences: allSentences,
      audio_sentence_ids: audioSentenceIds
    });
  } catch (err) {
    logger.error("[vocab-builder] practice-session failed", { err: err?.message, stack: err?.stack });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
