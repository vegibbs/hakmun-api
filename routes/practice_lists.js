// FILE: hakmun-api/routes/practice_lists.js
// PURPOSE: Generate and commit practice lists from teacher lesson notes.
// ENDPOINTS:
//   POST /v1/practice-lists/generate — Auto-import + LLM generation (returns for review)
//   POST /v1/practice-lists/commit   — Create content items + list from accepted sentences

const express = require("express");
const crypto = require("crypto");

const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { linkSentenceVocab } = require("../util/link_vocab_patterns");
const { ensureGoogleDocumentRow, cleanString } = require("../util/document_helpers");
const { analyzeTextForImport, generatePracticeSentences, validatePracticeSentences } = require("../util/openai");

const router = express.Router();

const QUERY_TIMEOUT_MS = 8000;

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// ---------------------------------------------------------------------------
// POST /v1/practice-lists/generate
// Auto-imports highlighted content then generates practice sentences via LLM.
// Returns generated sentences for client-side review (not committed yet).
// ---------------------------------------------------------------------------
router.post("/v1/practice-lists/generate", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const googleDocUrl = cleanString(req.body?.google_doc_url, 4000);
    const snapshotAssetId = cleanString(req.body?.asset_id, 80);
    const documentTitle = cleanString(req.body?.title, 140);
    const selectedText = cleanString(req.body?.selected_text, 50000);
    const rawSessionDate = cleanString(req.body?.session_date, 10);
    const sessionDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSessionDate) ? rawSessionDate : null;
    const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 20);
    const perspective = ["first_person", "third_person"].includes(req.body?.perspective)
      ? req.body.perspective : "first_person";
    const politeness = ["해요체", "합니다체", "반말"].includes(req.body?.politeness)
      ? req.body.politeness : "해요체";

    if (!selectedText) {
      return res.status(400).json({ ok: false, error: "SELECTED_TEXT_REQUIRED" });
    }
    if (!googleDocUrl) {
      return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });
    }

    // Fetch user CEFR level
    let cefrLevel = "A1";
    try {
      const uR = await withTimeout(
        pool.query(`SELECT cefr_current FROM users WHERE user_id = $1::uuid`, [userId]),
        QUERY_TIMEOUT_MS,
        "db-fetch-cefr"
      );
      cefrLevel = uR.rows?.[0]?.cefr_current || "A1";
    } catch (e) {
      logger.warn("[practice-lists] cefr fetch failed, defaulting to A1", { err: e?.message });
    }

    // Fetch canonical grammar patterns for import analysis
    let canonicalPatterns = null;
    try {
      const cpR = await withTimeout(
        pool.query(`
          SELECT gp.display_name,
                 array_agg(gpa.alias_raw ORDER BY gpa.alias_raw) FILTER (WHERE gpa.alias_raw IS NOT NULL) as aliases
          FROM grammar_patterns gp
          LEFT JOIN grammar_pattern_aliases gpa ON gpa.grammar_pattern_id = gp.id
          WHERE gp.active = true
          GROUP BY gp.id, gp.display_name
          ORDER BY gp.display_name
        `),
        QUERY_TIMEOUT_MS,
        "db-fetch-canonical-patterns"
      );
      canonicalPatterns = cpR.rows;
    } catch (e) {
      logger.warn("[practice-lists] canonical patterns fetch failed", { err: e?.message });
    }

    // --- Step 1: Standard import (analyze + commit) ---
    let importSummary = { sentences_created: 0, patterns_created: 0, vocab_touched: 0, fragments_created: 0 };
    let documentId = null;

    try {
      const analysis = await analyzeTextForImport({
        text: selectedText,
        importAs: "all",
        profile: "doc_import",
        glossLang: null,
        canonicalPatterns
      });

      // Auto-commit the import results
      documentId = await ensureGoogleDocumentRow({
        userId, googleDocUrl, snapshotAssetId, title: documentTitle
      });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const vocabulary = analysis.vocabulary || [];
        const sentences = analysis.sentences || [];
        const patterns = analysis.patterns || [];
        const fragments = analysis.fragments || [];

        let sentencesCreated = 0;
        let patternsCreated = 0;
        let vocabTouched = 0;
        let sentenceVocabLinked = 0;
        let fragmentsCreated = 0;
        const sentenceMap = new Map();

        // --- Sentences ---
        for (const s of sentences) {
          const ko = cleanString(s?.ko, 4000);
          if (!ko) continue;
          const gloss = cleanString(s?.gloss, 4000) || null;

          const existing = await withTimeout(
            client.query(
              `SELECT content_item_id FROM content_items
               WHERE owner_user_id = $1::uuid AND content_type = 'sentence' AND text = $2 LIMIT 1`,
              [userId, ko]
            ),
            QUERY_TIMEOUT_MS,
            "db-check-dup-sentence"
          );
          if (existing.rows.length > 0) {
            sentenceMap.set(ko, existing.rows[0].content_item_id);
            continue;
          }

          const contentItemId = crypto.randomUUID();
          const ins = await withTimeout(
            client.query(
              `INSERT INTO content_items (content_item_id, owner_user_id, content_type, text, language, notes)
               VALUES ($1::uuid, $2::uuid, 'sentence', $3, 'ko', $4)
               ON CONFLICT DO NOTHING
               RETURNING content_item_id`,
              [contentItemId, userId, ko, gloss]
            ),
            QUERY_TIMEOUT_MS,
            "db-insert-content-sentence"
          );

          const insertedId = ins.rows?.[0]?.content_item_id || null;
          if (insertedId) {
            sentencesCreated += 1;
            sentenceMap.set(ko, insertedId);

            await withTimeout(
              client.query(
                `INSERT INTO document_content_item_links (document_id, content_item_id, link_kind, session_date)
                 VALUES ($1::uuid, $2::uuid, 'sentence', $3::date)
                 ON CONFLICT (document_id, content_item_id, link_kind)
                 DO UPDATE SET session_date = GREATEST(EXCLUDED.session_date, document_content_item_links.session_date)`,
                [documentId, insertedId, sessionDate]
              ),
              QUERY_TIMEOUT_MS,
              "db-link-doc-content-sentence"
            );

            await withTimeout(
              client.query(
                `INSERT INTO library_registry_items (id, content_type, content_id, owner_user_id, audience, global_state, operational_status)
                 VALUES ($1::uuid, 'sentence', $2::uuid, $3::uuid, 'personal', NULL, 'active')
                 ON CONFLICT (content_type, content_id) DO NOTHING`,
                [crypto.randomUUID(), insertedId, userId]
              ),
              QUERY_TIMEOUT_MS,
              "db-insert-registry-sentence"
            );
          }
        }

        // --- Patterns ---
        for (const p of patterns) {
          const surface = cleanString(p?.surface_form, 200);
          const context = cleanString(p?.context_span, 400);
          if (!surface) continue;

          const text = context ? `${surface}\n${context}` : surface;

          const existingPattern = await withTimeout(
            client.query(
              `SELECT content_item_id FROM content_items
               WHERE owner_user_id = $1::uuid AND content_type = 'pattern' AND text = $2 LIMIT 1`,
              [userId, text]
            ),
            QUERY_TIMEOUT_MS,
            "db-check-dup-pattern"
          );
          if (existingPattern.rows.length > 0) continue;

          const norm = surface.replace(/[\s\t\n\r]/g, "");
          let matchedPatternId = null;
          try {
            const aliasMatch = await withTimeout(
              client.query(`SELECT grammar_pattern_id FROM grammar_pattern_aliases WHERE alias_norm = $1 LIMIT 1`, [norm]),
              QUERY_TIMEOUT_MS,
              "db-match-grammar-alias"
            );
            if (aliasMatch.rows.length > 0) matchedPatternId = aliasMatch.rows[0].grammar_pattern_id;
          } catch (e) {
            logger.warn("[practice-lists] alias lookup failed", { surface, norm, error: e?.message });
          }

          const contentItemId = crypto.randomUUID();
          const ins = await withTimeout(
            client.query(
              `INSERT INTO content_items (content_item_id, owner_user_id, content_type, text, language, notes, grammar_pattern_id)
               VALUES ($1::uuid, $2::uuid, 'pattern', $3, 'ko', NULL, $4::uuid)
               ON CONFLICT DO NOTHING
               RETURNING content_item_id`,
              [contentItemId, userId, text, matchedPatternId]
            ),
            QUERY_TIMEOUT_MS,
            "db-insert-content-pattern"
          );

          const insertedId = ins.rows?.[0]?.content_item_id || null;
          if (insertedId) {
            patternsCreated += 1;

            await withTimeout(
              client.query(
                `INSERT INTO document_content_item_links (document_id, content_item_id, link_kind, session_date)
                 VALUES ($1::uuid, $2::uuid, 'pattern', $3::date)
                 ON CONFLICT (document_id, content_item_id, link_kind)
                 DO UPDATE SET session_date = GREATEST(EXCLUDED.session_date, document_content_item_links.session_date)`,
                [documentId, insertedId, sessionDate]
              ),
              QUERY_TIMEOUT_MS,
              "db-link-doc-content-pattern"
            );

            await withTimeout(
              client.query(
                `INSERT INTO library_registry_items (id, content_type, content_id, owner_user_id, audience, global_state, operational_status)
                 VALUES ($1::uuid, 'pattern', $2::uuid, $3::uuid, 'personal', NULL, 'active')
                 ON CONFLICT (content_type, content_id) DO NOTHING`,
                [crypto.randomUUID(), insertedId, userId]
              ),
              QUERY_TIMEOUT_MS,
              "db-insert-registry-pattern"
            );

            if (matchedPatternId) {
              await withTimeout(
                client.query(
                  `INSERT INTO content_item_grammar_links (content_item_id, grammar_pattern_id, role)
                   VALUES ($1::uuid, $2::uuid, 'primary') ON CONFLICT DO NOTHING`,
                  [insertedId, matchedPatternId]
                ),
                QUERY_TIMEOUT_MS,
                "db-insert-grammar-link-primary"
              );
            }
          }
        }

        // --- Sentence→Vocab links ---
        const q = client.query.bind(client);
        for (const s of sentences) {
          const ko = cleanString(s?.ko, 4000);
          if (!ko) continue;
          const contentItemId = sentenceMap.get(ko);
          if (!contentItemId) continue;
          const sentenceVocab = Array.isArray(s?.vocabulary) ? s.vocabulary : [];
          sentenceVocabLinked += await linkSentenceVocab(q, contentItemId, sentenceVocab, { createProvisional: true });
        }

        // --- Vocabulary ---
        for (const v of vocabulary) {
          const lemma = cleanString(v?.lemma_ko, 200);
          if (!lemma) continue;

          let vocabIdUuid = null;
          const tvMatch = await withTimeout(
            client.query(`SELECT id FROM teaching_vocab WHERE lemma = $1 LIMIT 1`, [lemma]),
            QUERY_TIMEOUT_MS,
            "db-match-teaching-vocab"
          );
          if (tvMatch.rows.length > 0) vocabIdUuid = tvMatch.rows[0].id;

          await withTimeout(
            client.query(
              `INSERT INTO user_vocab_items (user_id, lemma, vocab_id, first_seen_at, last_seen_at)
               VALUES ($1::uuid, $2, $3::uuid, now(), now())
               ON CONFLICT (user_id, lemma)
               DO UPDATE SET last_seen_at = now(), vocab_id = COALESCE(EXCLUDED.vocab_id, user_vocab_items.vocab_id)`,
              [userId, lemma, vocabIdUuid]
            ),
            QUERY_TIMEOUT_MS,
            "db-upsert-user-vocab"
          );
          vocabTouched += 1;

          await withTimeout(
            client.query(
              `INSERT INTO document_vocab_links (document_id, user_id, lemma, session_date)
               VALUES ($1::uuid, $2::uuid, $3, $4::date)
               ON CONFLICT (document_id, user_id, lemma)
               DO UPDATE SET session_date = GREATEST(EXCLUDED.session_date, document_vocab_links.session_date)`,
              [documentId, userId, lemma, sessionDate]
            ),
            QUERY_TIMEOUT_MS,
            "db-link-doc-vocab"
          );
        }

        // --- Fragments ---
        for (const f of fragments) {
          const text = cleanString(f?.text, 8000);
          if (!text) continue;
          const label = cleanString(f?.label, 200) || null;

          const existing = await withTimeout(
            client.query(
              `SELECT fragment_id FROM document_fragments WHERE document_id = $1::uuid AND text = $2 LIMIT 1`,
              [documentId, text]
            ),
            QUERY_TIMEOUT_MS,
            "db-check-dup-fragment"
          );
          if (existing.rows.length > 0) continue;

          await withTimeout(
            client.query(
              `INSERT INTO document_fragments (fragment_id, document_id, owner_user_id, session_date, text, label)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6)
               ON CONFLICT DO NOTHING`,
              [crypto.randomUUID(), documentId, userId, sessionDate, text, label]
            ),
            QUERY_TIMEOUT_MS,
            "db-insert-fragment"
          );
          fragmentsCreated += 1;
        }

        await client.query("COMMIT");

        importSummary = {
          sentences_created: sentencesCreated,
          patterns_created: patternsCreated,
          vocab_touched: vocabTouched,
          fragments_created: fragmentsCreated
        };
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      // Import failure is non-fatal — we still try to generate practice sentences.
      // The user gets the import_summary showing zeros so they know it didn't work.
      logger.warn("[practice-lists] auto-import failed, continuing with generation", { err: e?.message });
    }

    // --- Step 2: Generate practice sentences ---
    let practiceSentences = [];
    try {
      const genResult = await generatePracticeSentences({
        text: selectedText,
        cefrLevel,
        glossLang: "en",
        count,
        perspective,
        politeness
      });

      const generated = genResult.sentences || [];

      // --- Step 3: Validate for naturalness ---
      if (generated.length > 0) {
        try {
          const valResult = await validatePracticeSentences(generated, "en");
          const validations = valResult.validations || [];

          // Merge validation into generated sentences
          for (const v of validations) {
            const idx = v.index - 1; // 1-based to 0-based
            if (idx >= 0 && idx < generated.length) {
              generated[idx].validation_score = v.naturalness_score;
              generated[idx].validation_natural = v.natural;
              generated[idx].issues = v.issues;
              generated[idx].suggested_fix = v.suggested_fix;
              generated[idx].explanation = v.explanation;
            }
          }
        } catch (valErr) {
          // Validation failure is non-fatal — sentences still usable, just unvalidated
          logger.warn("[practice-lists] validation failed, returning unvalidated", { err: valErr?.message });
        }
      }

      practiceSentences = generated;
    } catch (genErr) {
      logger.error("[practice-lists] generation failed", { err: genErr?.message, stack: genErr?.stack });
      return res.status(500).json({
        ok: false,
        error: "GENERATION_FAILED",
        detail: genErr?.message?.startsWith("openai_") ? genErr.message : undefined
      });
    }

    return res.status(200).json({
      ok: true,
      document_id: documentId,
      import_summary: importSummary,
      practice_sentences: practiceSentences
    });

  } catch (err) {
    const msg = String(err?.message || err);

    if (msg === "SNAPSHOT_ASSET_ID_REQUIRED") {
      return res.status(400).json({ ok: false, error: "SNAPSHOT_ASSET_ID_REQUIRED" });
    }

    logger.error("[practice-lists] generate failed", {
      message: err?.message,
      code: err?.code,
      stack: err?.stack
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/practice-lists/commit
// Creates content items for accepted practice sentences, creates a list,
// and adds items to the list.
// ---------------------------------------------------------------------------
router.post("/v1/practice-lists/commit", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const documentId = cleanString(req.body?.document_id, 80) || null;
    const rawSessionDate = cleanString(req.body?.session_date, 10);
    const sessionDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSessionDate) ? rawSessionDate : null;
    const customName = cleanString(req.body?.name, 100) || null;
    const sentences = Array.isArray(req.body?.sentences) ? req.body.sentences : [];

    if (sentences.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_SENTENCES" });
    }
    if (sentences.length > 100) {
      return res.status(413).json({ ok: false, error: "TOO_MANY_SENTENCES" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Determine list name: "Practice List N"
      const countR = await withTimeout(
        client.query(
          `SELECT COUNT(*) AS cnt FROM lists WHERE user_id = $1::uuid AND source_kind = 'practice_generation'`,
          [userId]
        ),
        QUERY_TIMEOUT_MS,
        "db-count-practice-lists"
      );
      const listNumber = (parseInt(countR.rows[0]?.cnt, 10) || 0) + 1;
      const listName = customName || `Practice List ${listNumber}`;

      // Create the list
      const listId = crypto.randomUUID();
      await withTimeout(
        client.query(
          `INSERT INTO lists (id, user_id, name, description, global_weight, is_active, source_kind, source_document_id)
           VALUES ($1::uuid, $2::uuid, $3, $4, 3, true, 'practice_generation', $5::uuid)`,
          [listId, userId, listName, "Auto-generated practice list", documentId]
        ),
        QUERY_TIMEOUT_MS,
        "db-create-practice-list"
      );

      // Create content items and add to list
      const contentItemIds = [];
      let position = 100;
      const q = client.query.bind(client);

      for (const s of sentences) {
        const ko = cleanString(s?.ko, 4000);
        if (!ko) continue;
        const en = cleanString(s?.en, 4000) || null;
        const cefrLevel = cleanString(s?.cefr_level, 4) || null;
        const topic = cleanString(s?.topic, 40) || null;
        const naturalness = (typeof s?.naturalness_score === "number" && Number.isFinite(s.naturalness_score))
          ? s.naturalness_score : null;
        const politeness = cleanString(s?.politeness, 20) || null;
        const tense = cleanString(s?.tense, 20) || null;

        // Dedup: check if sentence already exists
        let contentItemId = null;
        const existing = await withTimeout(
          client.query(
            `SELECT content_item_id FROM content_items
             WHERE owner_user_id = $1::uuid AND content_type = 'sentence' AND text = $2 LIMIT 1`,
            [userId, ko]
          ),
          QUERY_TIMEOUT_MS,
          "db-check-dup-practice-sentence"
        );

        if (existing.rows.length > 0) {
          contentItemId = existing.rows[0].content_item_id;
        } else {
          contentItemId = crypto.randomUUID();
          await withTimeout(
            client.query(
              `INSERT INTO content_items (content_item_id, owner_user_id, content_type, text, language, notes, cefr_level, topic, naturalness_score, politeness, tense)
               VALUES ($1::uuid, $2::uuid, 'sentence', $3, 'ko', $4, $5, $6, $7, $8, $9)
               ON CONFLICT DO NOTHING`,
              [contentItemId, userId, ko, en, cefrLevel, topic, naturalness, politeness, tense]
            ),
            QUERY_TIMEOUT_MS,
            "db-insert-practice-sentence"
          );

          await withTimeout(
            client.query(
              `INSERT INTO library_registry_items (id, content_type, content_id, owner_user_id, audience, global_state, operational_status)
               VALUES ($1::uuid, 'sentence', $2::uuid, $3::uuid, 'personal', NULL, 'active')
               ON CONFLICT (content_type, content_id) DO NOTHING`,
              [crypto.randomUUID(), contentItemId, userId]
            ),
            QUERY_TIMEOUT_MS,
            "db-insert-registry-practice-sentence"
          );

          // Link to document
          if (documentId) {
            await withTimeout(
              client.query(
                `INSERT INTO document_content_item_links (document_id, content_item_id, link_kind, session_date)
                 VALUES ($1::uuid, $2::uuid, 'sentence', $3::date)
                 ON CONFLICT (document_id, content_item_id, link_kind)
                 DO UPDATE SET session_date = GREATEST(EXCLUDED.session_date, document_content_item_links.session_date)`,
                [documentId, contentItemId, sessionDate]
              ),
              QUERY_TIMEOUT_MS,
              "db-link-doc-practice-sentence"
            );
          }

          // Link vocabulary
          const sentenceVocab = Array.isArray(s?.vocabulary) ? s.vocabulary : [];
          await linkSentenceVocab(q, contentItemId, sentenceVocab, { createProvisional: true });
        }

        contentItemIds.push(contentItemId);

        // Add to list
        await withTimeout(
          client.query(
            `INSERT INTO list_items (id, list_id, item_type, item_id, position)
             VALUES ($1::uuid, $2::uuid, 'sentence', $3::uuid, $4)
             ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), listId, contentItemId, position]
          ),
          QUERY_TIMEOUT_MS,
          "db-add-list-item"
        );
        position += 100;
      }

      await client.query("COMMIT");

      return res.status(201).json({
        ok: true,
        list_id: listId,
        list_name: listName,
        items_created: contentItemIds.length
      });

    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error("[practice-lists] commit failed", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      stack: err?.stack
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
