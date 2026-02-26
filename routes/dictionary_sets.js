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
const { callOpenAIOnce } = require("../util/openai");
const { linkSentenceVocab, linkSentenceGrammarPatterns } = require("../util/link_vocab_patterns");

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
// Looks up existing sentences containing the hanja-derived words,
// generates via OpenAI for any words that lack coverage,
// and returns a practice-ready sentence list.
router.post("/v1/hanja/:id/practice-session", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  try {
    const hanjaCharacterId = req.params.id;

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
      return res.json({ ok: true, sentences: [] });
    }

    // 2. Search for existing approved sentences containing each word
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
      LIMIT 2
    `;

    const foundSentences = [];
    const coveredWords = new Set();
    const uncoveredWords = [];

    for (const word of headwords) {
      const { rows } = await dbQuery(sentenceSql, [`%${word}%`]);
      if (rows.length > 0) {
        coveredWords.add(word);
        for (const row of rows) {
          // Avoid duplicates if same sentence matches multiple words
          if (!foundSentences.find(s => s.content_item_id === row.content_item_id)) {
            foundSentences.push({
              content_item_id: row.content_item_id,
              text: row.text,
              notes: row.notes,
              cefr_level: row.cefr_level,
              topic: row.topic,
              source_word: word,
              generated: false,
            });
          }
        }
      } else {
        uncoveredWords.push(word);
      }
    }

    // 3. Generate sentences for uncovered words via OpenAI
    if (uncoveredWords.length > 0) {
      // Get the hanja character for context
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

      const wordList = uncoveredWords.join(", ");
      const prompt = `You are a Korean language teaching assistant.

Generate natural Korean practice sentences that contain these vocabulary words: ${wordList}

Context: These words all share the hanja character ${hanjaChar} (${hanjaReading} — ${hanjaGloss}).
Generate 1-2 sentences per word. Each sentence should naturally use the word in everyday context.

Rules:
- Use 요-form (해요체) politeness level.
- Each sentence must be a complete, natural, standalone Korean sentence.
- Each sentence should be 5-20 syllables long.
- Every sentence MUST end with punctuation (. ? !).
- Vary grammar patterns and tenses across sentences.
- Do NOT include English words mixed into Korean.

For each sentence provide:
- ko: the Korean sentence
- en: English translation
- source_word: which word from the list this sentence practices
- cefr_level: estimated CEFR level (A1, A2, B1, B2)
- topic: ONE from: daily_life, food, weather, travel, work, school, shopping, health, hobbies, relationships, directions, time, emotions, family, transportation, housing, clothing, nature, culture, technology
- naturalness_score: 0.0 to 1.0
- vocabulary: array of content words { "lemma_ko": "dictionary form", "pos_ko": "명사|동사|형용사|부사|기타" }
- grammar_patterns: array { "surface_form": "e.g. -았/었어요" }

Return ONLY valid JSON:
{
  "sentences": [
    {
      "ko": "...",
      "en": "...",
      "source_word": "...",
      "cefr_level": "A2",
      "topic": "daily_life",
      "naturalness_score": 0.9,
      "vocabulary": [{ "lemma_ko": "...", "pos_ko": "..." }],
      "grammar_patterns": [{ "surface_form": "..." }]
    }
  ]
}`;

      const raw = await callOpenAIOnce(prompt);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // If OpenAI returns bad JSON, just skip generation
        parsed = { sentences: [] };
      }

      const generated = (parsed.sentences || [])
        .filter(s => s && typeof s.ko === "string" && s.ko.trim().length >= 5)
        .filter(s => {
          const score = typeof s.naturalness_score === "number" ? s.naturalness_score : 1;
          return score >= 0.7;
        });

      // Store generated sentences in DB (same pattern as POST /v1/generate/sentences)
      if (generated.length > 0) {
        const { pool } = db;
        const client = await pool.connect();
        const q = client.query.bind(client);

        try {
          await q("BEGIN", []);

          for (const s of generated) {
            const ko = s.ko.trim();
            const en = typeof s.en === "string" ? s.en.trim() : null;
            const cefr = typeof s.cefr_level === "string" ? s.cefr_level.trim() : null;
            let topic = typeof s.topic === "string" ? s.topic.trim() : null;
            const score = typeof s.naturalness_score === "number" ? s.naturalness_score : null;
            const sourceWord = typeof s.source_word === "string" ? s.source_word.trim() : null;

            const ins = await q(
              `INSERT INTO content_items
                (owner_user_id, content_type, text, language, notes, cefr_level, topic, naturalness_score)
              VALUES ($1::uuid, 'sentence', $2, 'ko', $3, $4, $5, $6)
              RETURNING content_item_id, text, notes, cefr_level, topic`,
              [userId, ko, en, cefr, topic, score]
            );
            const item = ins.rows[0];

            await q(
              `INSERT INTO library_registry_items
                (content_type, content_id, owner_user_id, audience, global_state, operational_status)
              VALUES ('sentence', $1::uuid, $2::uuid, 'global', 'approved', 'active')`,
              [item.content_item_id, userId]
            );

            // Link vocabulary and grammar patterns
            const vocabArray = Array.isArray(s.vocabulary) ? s.vocabulary : [];
            const patternsArray = Array.isArray(s.grammar_patterns) ? s.grammar_patterns : [];
            await linkSentenceVocab(q, item.content_item_id, vocabArray);
            await linkSentenceGrammarPatterns(q, item.content_item_id, patternsArray);

            foundSentences.push({
              content_item_id: item.content_item_id,
              text: item.text,
              notes: item.notes,
              cefr_level: item.cefr_level,
              topic: item.topic,
              source_word: sourceWord,
              generated: true,
            });
          }

          await q("COMMIT", []);
        } catch (err) {
          try { await client.query("ROLLBACK"); } catch (_) {}
          throw err;
        } finally {
          client.release();
        }
      }
    }

    return res.json({
      ok: true,
      hanja_character_id: hanjaCharacterId,
      total_words: headwords.length,
      covered_words: coveredWords.size,
      generated_for: uncoveredWords.length,
      sentences: foundSentences,
    });
  } catch (err) {
    console.error("hanja practice-session POST failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;