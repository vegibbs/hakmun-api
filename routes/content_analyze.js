// FILE: hakmun-api/routes/content_analyze.js
// PURPOSE: Source-agnostic content analysis, commit, and practice generation.
//
// Endpoints:
//   POST /v1/content/analyze — Analyze text via OpenAI (preview-only, no DB writes)
//   POST /v1/content/analyze/commit — Commit reviewed items to user library
//   POST /v1/content/analyze/generate-practice — Generate practice sentences from text
//
// This decouples text analysis from the Google Doc-specific endpoints,
// allowing HakDocs, pasted text, or any other source to use the same pipeline.

const express = require("express");
const crypto = require("crypto");

const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { analyzeTextForImport, generatePracticeSentences, validatePracticeSentences } = require("../util/openai");
const { linkSentenceVocab } = require("../util/link_vocab_patterns");
const { ensureDocumentRow, looksLikeUUID, cleanString } = require("../util/document_helpers");

const router = express.Router();

const MAX_TEXT_CHARS = 500_000;
const VALID_SOURCE_TYPES = new Set(["hakdoc", "google_doc", "paste", "other"]);
const VALID_IMPORT_AS = new Set(["all", "vocab", "sentences", "patterns"]);

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /v1/content/analyze — Analyze text (preview-only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post("/v1/content/analyze", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const text = (typeof req.body?.text === "string") ? req.body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });
    }

    const bounded = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

    const sourceType = VALID_SOURCE_TYPES.has(req.body?.source_type)
      ? req.body.source_type
      : "other";
    const sourceId = cleanString(req.body?.source_id, 200) || null;
    const importAs = VALID_IMPORT_AS.has(req.body?.import_as)
      ? req.body.import_as
      : "all";

    // Fetch canonical patterns for grammar matching
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
        8000,
        "db-fetch-canonical-patterns"
      );
      canonicalPatterns = cpR.rows;
    } catch (e) {
      logger.warn("[content-analyze] canonical patterns fetch failed, proceeding without", { err: e?.message });
    }

    const analysis = await analyzeTextForImport({
      text: bounded,
      importAs,
      profile: "doc_import",
      glossLang: null,
      canonicalPatterns
    });

    return res.status(200).json({
      ok: true,
      source_type: sourceType,
      source_id: sourceId,
      selection_chars: bounded.length,
      preview: {
        vocabulary: analysis.vocabulary || [],
        sentences: analysis.sentences || [],
        patterns: analysis.patterns || [],
        fragments: analysis.fragments || [],
        gloss_lang: analysis.gloss_lang || null
      }
    });
  } catch (err) {
    logger.error("[content-analyze] analyze failed", { error: err?.message, stack: err?.stack });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /v1/content/analyze/commit — Commit reviewed items to DB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post("/v1/content/analyze/commit", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const sourceType = VALID_SOURCE_TYPES.has(req.body?.source_type)
      ? req.body.source_type
      : "other";
    const sourceId = cleanString(req.body?.source_id, 200) || null;
    const documentTitle = cleanString(req.body?.document_title, 140) || null;

    const rawSessionDate = cleanString(req.body?.session_date, 10);
    const sessionDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSessionDate) ? rawSessionDate : null;

    const vocabulary = Array.isArray(req.body?.vocabulary) ? req.body.vocabulary : [];
    const sentences = Array.isArray(req.body?.sentences) ? req.body.sentences : [];
    const patterns = Array.isArray(req.body?.patterns) ? req.body.patterns : [];
    const fragments = Array.isArray(req.body?.fragments) ? req.body.fragments : [];

    if (vocabulary.length + sentences.length + patterns.length + fragments.length === 0) {
      return res.status(400).json({ ok: false, error: "NOTHING_TO_COMMIT" });
    }
    if (vocabulary.length > 500 || sentences.length > 500 || patterns.length > 500 || fragments.length > 200) {
      return res.status(413).json({ ok: false, error: "TOO_MANY_ITEMS" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const documentId = await ensureDocumentRow({
        userId,
        sourceKind: sourceType,
        sourceId,
        title: documentTitle
      });

      let sentencesCreated = 0;
      let sentencesExisting = 0;
      let patternsCreated = 0;
      let patternsExisting = 0;
      let vocabCreated = 0;
      let vocabExisting = 0;

      const sentenceMap = new Map();
      const patternLinks = [];

      // ── Sentences ──
      for (const s of sentences) {
        const ko = cleanString(s?.ko, 4000);
        if (!ko) continue;
        const gloss = cleanString(s?.gloss, 4000) || null;

        const existing = await withTimeout(
          client.query(
            `SELECT content_item_id FROM content_items
             WHERE owner_user_id = $1::uuid
               AND content_type = 'sentence'
               AND text = $2
             LIMIT 1`,
            [userId, ko]
          ),
          8000,
          "db-check-dup-sentence"
        );

        let resolvedId = existing.rows?.[0]?.content_item_id || null;
        const wasExisting = !!resolvedId;

        if (!resolvedId) {
          const contentItemId = crypto.randomUUID();
          const ins = await withTimeout(
            client.query(
              `INSERT INTO content_items (
                 content_item_id, owner_user_id, content_type, text, language, notes
               ) VALUES ($1::uuid, $2::uuid, $3, $4, 'ko', $5)
               ON CONFLICT DO NOTHING
               RETURNING content_item_id`,
              [contentItemId, userId, "sentence", ko, gloss]
            ),
            8000,
            "db-insert-content-sentence"
          );
          resolvedId = ins.rows?.[0]?.content_item_id || null;
          if (resolvedId) sentencesCreated += 1;
        } else if (wasExisting) {
          sentencesExisting += 1;
        }

        if (resolvedId) {
          sentenceMap.set(ko, resolvedId);

          await withTimeout(
            client.query(
              `INSERT INTO document_content_item_links (document_id, content_item_id, link_kind, session_date)
               VALUES ($1::uuid, $2::uuid, 'sentence', $3::date)
               ON CONFLICT (document_id, content_item_id, link_kind)
               DO UPDATE SET session_date = GREATEST(EXCLUDED.session_date, document_content_item_links.session_date)`,
              [documentId, resolvedId, sessionDate]
            ),
            8000,
            "db-link-doc-content-sentence"
          );

          await withTimeout(
            client.query(
              `INSERT INTO library_registry_items
                 (id, content_type, content_id, owner_user_id, audience, global_state, operational_status)
               VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'personal', NULL, 'active')
               ON CONFLICT (content_type, content_id) DO NOTHING`,
              [crypto.randomUUID(), "sentence", resolvedId, userId]
            ),
            8000,
            "db-insert-registry-sentence"
          );
        }
      }

      // ── Patterns ──
      for (const p of patterns) {
        const surface = cleanString(p?.surface_form, 200);
        const context = cleanString(p?.context_span, 400);
        if (!surface) continue;

        const text = context ? `${surface}\n${context}` : surface;

        const existingPattern = await withTimeout(
          client.query(
            `SELECT content_item_id FROM content_items
             WHERE owner_user_id = $1::uuid
               AND content_type = 'pattern'
               AND text = $2
             LIMIT 1`,
            [userId, text]
          ),
          8000,
          "db-check-dup-pattern"
        );

        let resolvedId = existingPattern.rows?.[0]?.content_item_id || null;
        const wasExisting = !!resolvedId;

        const norm = surface.replace(/[\s\t\n\r]/g, "");
        let matchedPatternId = null;

        try {
          const aliasMatch = await withTimeout(
            client.query(
              `SELECT grammar_pattern_id
                 FROM grammar_pattern_aliases
                WHERE alias_norm = $1
                LIMIT 1`,
              [norm]
            ),
            8000,
            "db-match-grammar-alias"
          );
          if (aliasMatch.rows.length > 0) {
            matchedPatternId = aliasMatch.rows[0].grammar_pattern_id;
          }
        } catch (e) {
          logger.warn("[content-analyze-commit] alias lookup failed", { surface, norm, error: e?.message });
        }

        if (!resolvedId) {
          const contentItemId = crypto.randomUUID();
          const ins = await withTimeout(
            client.query(
              `INSERT INTO content_items (
                 content_item_id, owner_user_id, content_type, text, language, notes, grammar_pattern_id
               ) VALUES ($1::uuid, $2::uuid, $3, $4, 'ko', NULL, $5::uuid)
               ON CONFLICT DO NOTHING
               RETURNING content_item_id`,
              [contentItemId, userId, "pattern", text, matchedPatternId]
            ),
            8000,
            "db-insert-content-pattern"
          );
          resolvedId = ins.rows?.[0]?.content_item_id || null;
          if (resolvedId) patternsCreated += 1;
        } else if (wasExisting) {
          patternsExisting += 1;
        }

        if (resolvedId) {
          await withTimeout(
            client.query(
              `INSERT INTO document_content_item_links (document_id, content_item_id, link_kind, session_date)
               VALUES ($1::uuid, $2::uuid, 'pattern', $3::date)
               ON CONFLICT (document_id, content_item_id, link_kind)
               DO UPDATE SET session_date = GREATEST(EXCLUDED.session_date, document_content_item_links.session_date)`,
              [documentId, resolvedId, sessionDate]
            ),
            8000,
            "db-link-doc-content-pattern"
          );

          await withTimeout(
            client.query(
              `INSERT INTO library_registry_items
                 (id, content_type, content_id, owner_user_id, audience, global_state, operational_status)
               VALUES ($1::uuid, $2::text, $3::uuid, $4::uuid, 'personal', NULL, 'active')
               ON CONFLICT (content_type, content_id) DO NOTHING`,
              [crypto.randomUUID(), "pattern", resolvedId, userId]
            ),
            8000,
            "db-insert-registry-pattern"
          );

          if (matchedPatternId) {
            await withTimeout(
              client.query(
                `INSERT INTO content_item_grammar_links (content_item_id, grammar_pattern_id, role)
                 VALUES ($1::uuid, $2::uuid, 'primary')
                 ON CONFLICT DO NOTHING`,
                [resolvedId, matchedPatternId]
              ),
              8000,
              "db-insert-grammar-link-primary"
            );
            patternLinks.push({ contentItemId: resolvedId, grammarPatternId: matchedPatternId, contextSpan: context });
          }
        }

        // Log unmatched surface forms
        if (!matchedPatternId) {
          const spName = "sp_unmatched_grammar";
          try {
            await client.query(`SAVEPOINT ${spName}`);
            await client.query(
              `INSERT INTO unmatched_grammar_patterns (unmatched_id, owner_user_id, document_id, surface_form, alias_norm, context_span, count, first_seen_at, last_seen_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, now(), now())
               ON CONFLICT (owner_user_id, alias_norm)
               DO UPDATE SET last_seen_at = now(), count = unmatched_grammar_patterns.count + 1`,
              [crypto.randomUUID(), userId, documentId, surface, norm, context || null]
            );
            await client.query(`RELEASE SAVEPOINT ${spName}`);
          } catch (e) {
            try {
              await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
              await client.query(`RELEASE SAVEPOINT ${spName}`);
            } catch (_) {}
          }
        }
      }

      // ── Cross-link: sentences ↔ grammar patterns ──
      for (const pl of patternLinks) {
        const sentenceItemId = sentenceMap.get(pl.contextSpan);
        if (sentenceItemId) {
          await withTimeout(
            client.query(
              `INSERT INTO content_item_grammar_links (content_item_id, grammar_pattern_id, role)
               VALUES ($1::uuid, $2::uuid, 'component')
               ON CONFLICT DO NOTHING`,
              [sentenceItemId, pl.grammarPatternId]
            ),
            8000,
            "db-insert-grammar-link-component"
          );
        }
      }

      // ── Sentence→Vocab links ──
      let sentenceVocabLinked = 0;
      const q = client.query.bind(client);
      for (const s of sentences) {
        const ko = cleanString(s?.ko, 4000);
        if (!ko) continue;
        const contentItemId = sentenceMap.get(ko);
        if (!contentItemId) continue;
        const sentenceVocab = Array.isArray(s?.vocabulary) ? s.vocabulary : [];
        sentenceVocabLinked += await linkSentenceVocab(q, contentItemId, sentenceVocab, { createProvisional: true });
      }

      // ── Vocabulary ──
      for (const v of vocabulary) {
        const lemma = cleanString(v?.lemma_ko, 200);
        if (!lemma) continue;

        let vocabIdUuid = null;
        const providedVocabId = cleanString(v?.vocab_id, 80);
        if (looksLikeUUID(providedVocabId)) {
          vocabIdUuid = providedVocabId;
        } else {
          const tvMatch = await withTimeout(
            client.query(
              `SELECT id FROM teaching_vocab WHERE lemma = $1 LIMIT 1`,
              [lemma]
            ),
            8000,
            "db-match-teaching-vocab"
          );
          if (tvMatch.rows.length > 0) {
            vocabIdUuid = tvMatch.rows[0].id;
          }
        }

        const vocabUpsert = await withTimeout(
          client.query(
            `INSERT INTO user_vocab_items (user_id, lemma, vocab_id, first_seen_at, last_seen_at)
             VALUES ($1::uuid, $2, $3::uuid, now(), now())
             ON CONFLICT (user_id, lemma)
             DO UPDATE SET
               last_seen_at = now(),
               vocab_id = COALESCE(EXCLUDED.vocab_id, user_vocab_items.vocab_id)
             RETURNING (xmax = 0) AS is_new`,
            [userId, lemma, vocabIdUuid]
          ),
          8000,
          "db-upsert-user-vocab"
        );

        if (vocabUpsert.rows?.[0]?.is_new) {
          vocabCreated += 1;
        } else {
          vocabExisting += 1;
        }

        await withTimeout(
          client.query(
            `INSERT INTO document_vocab_links (document_id, user_id, lemma, session_date)
             VALUES ($1::uuid, $2::uuid, $3, $4::date)
             ON CONFLICT (document_id, user_id, lemma)
             DO UPDATE SET session_date = GREATEST(EXCLUDED.session_date, document_vocab_links.session_date)`,
            [documentId, userId, lemma, sessionDate]
          ),
          8000,
          "db-link-doc-vocab"
        );

        if (!vocabIdUuid) {
          const spName = "sp_unmatched_vocab";
          try {
            await client.query(`SAVEPOINT ${spName}`);
            let contextSpan = null;
            for (const s of sentences) {
              const sKo = cleanString(s?.ko, 4000);
              if (sKo && sKo.includes(lemma)) {
                contextSpan = sKo;
                break;
              }
            }
            await client.query(
              `INSERT INTO unmatched_vocab
                 (unmatched_id, owner_user_id, document_id, lemma, pos, context_span, count, first_seen_at, last_seen_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, now(), now())
               ON CONFLICT (owner_user_id, lemma)
               DO UPDATE SET
                 last_seen_at = now(),
                 count = unmatched_vocab.count + 1,
                 context_span = COALESCE(EXCLUDED.context_span, unmatched_vocab.context_span)`,
              [crypto.randomUUID(), userId, documentId, lemma, cleanString(v?.pos_ko, 40) || null, contextSpan]
            );
            await client.query(`RELEASE SAVEPOINT ${spName}`);
          } catch (e) {
            try {
              await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
              await client.query(`RELEASE SAVEPOINT ${spName}`);
            } catch (_) {}
          }
        }
      }

      // ── Fragments ──
      let fragmentsCreated = 0;
      for (const f of fragments) {
        const text = cleanString(f?.text, 8000);
        if (!text) continue;
        const label = cleanString(f?.label, 200) || null;

        const existing = await withTimeout(
          client.query(
            `SELECT fragment_id FROM document_fragments
             WHERE document_id = $1::uuid
               AND text = $2
             LIMIT 1`,
            [documentId, text]
          ),
          8000,
          "db-check-dup-fragment"
        );
        if (existing.rows.length > 0) continue;

        await withTimeout(
          client.query(
            `INSERT INTO document_fragments (
               fragment_id, document_id, owner_user_id, session_date, text, label
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6)
             ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), documentId, userId, sessionDate, text, label]
          ),
          8000,
          "db-insert-fragment"
        );
        fragmentsCreated += 1;
      }

      await client.query("COMMIT");

      return res.status(201).json({
        ok: true,
        document_id: documentId,
        sentences_created: sentencesCreated,
        sentences_existing: sentencesExisting,
        patterns_created: patternsCreated,
        patterns_existing: patternsExisting,
        vocab_created: vocabCreated,
        vocab_existing: vocabExisting,
        sentence_vocab_linked: sentenceVocabLinked,
        fragments_created: fragmentsCreated
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = String(err?.message || err);

    if (msg === "SOURCE_KIND_REQUIRED") {
      return res.status(400).json({ ok: false, error: "SOURCE_KIND_REQUIRED" });
    }
    if (msg.includes("relation") && msg.includes("does not exist")) {
      const table = msg.match(/relation "([^"]+)"/)?.[1] || "unknown";
      return res.status(500).json({ ok: false, error: "MISSING_TABLE", table });
    }

    logger.error("[content-analyze-commit] commit failed", { error: msg, stack: err?.stack });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /v1/content/analyze/generate-practice
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post("/v1/content/analyze/generate-practice", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const selectedText = (typeof req.body?.selected_text === "string") ? req.body.selected_text.trim() : "";
    if (!selectedText) {
      return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });
    }

    const sourceType = VALID_SOURCE_TYPES.has(req.body?.source_type)
      ? req.body.source_type
      : "other";
    const sourceId = cleanString(req.body?.source_id, 200) || null;

    const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 20);
    const perspective = req.body?.perspective || "first_person";
    const politeness = req.body?.politeness || "해요체";
    const autoImport = req.body?.auto_import !== false; // default true

    // Fetch user's CEFR level
    let cefrLevel = "A1";
    let cefrTarget = "A2";
    try {
      const userR = await withTimeout(
        pool.query(
          `SELECT facts FROM users WHERE user_id = $1::uuid LIMIT 1`,
          [userId]
        ),
        8000,
        "db-fetch-user-cefr"
      );
      const facts = userR.rows?.[0]?.facts;
      if (facts?.cefrLevel) cefrLevel = facts.cefrLevel;
      if (facts?.cefrTarget) cefrTarget = facts.cefrTarget;
    } catch (e) {
      logger.warn("[content-analyze-gen] failed to fetch user CEFR, using defaults", { error: e?.message });
    }

    // Step 1: auto-import (analyze + commit) if requested
    if (autoImport) {
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
          8000,
          "db-fetch-canonical-patterns-gen"
        );
        canonicalPatterns = cpR.rows;
      } catch (_) {}

      try {
        const analysis = await analyzeTextForImport({
          text: selectedText.length > MAX_TEXT_CHARS ? selectedText.slice(0, MAX_TEXT_CHARS) : selectedText,
          importAs: "all",
          profile: "doc_import",
          glossLang: null,
          canonicalPatterns
        });

        // Auto-commit analysis results
        if (analysis.sentences?.length || analysis.vocabulary?.length || analysis.patterns?.length) {
          const documentId = await ensureDocumentRow({
            userId,
            sourceKind: sourceType,
            sourceId,
            title: sourceType
          });

          const client = await pool.connect();
          try {
            await client.query("BEGIN");

            for (const s of (analysis.sentences || [])) {
              const ko = cleanString(s?.ko, 4000);
              if (!ko) continue;
              const gloss = cleanString(s?.gloss, 4000) || null;
              const contentItemId = crypto.randomUUID();
              await withTimeout(
                client.query(
                  `INSERT INTO content_items (content_item_id, owner_user_id, content_type, text, language, notes)
                   VALUES ($1::uuid, $2::uuid, 'sentence', $3, 'ko', $4)
                   ON CONFLICT DO NOTHING`,
                  [contentItemId, userId, ko, gloss]
                ),
                8000,
                "db-autoimport-sentence"
              );
            }

            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK");
            logger.warn("[content-analyze-gen] auto-import failed, continuing with generation", { error: e?.message });
          } finally {
            client.release();
          }
        }
      } catch (e) {
        logger.warn("[content-analyze-gen] auto-import analysis failed, continuing", { error: e?.message });
      }
    }

    // Step 2: Generate practice sentences
    const generated = await generatePracticeSentences({
      text: selectedText,
      cefrLevel,
      cefrTarget,
      count,
      perspective,
      politeness
    });

    // Step 3: Validate generated sentences
    let practiceSentences = generated.sentences || [];
    if (practiceSentences.length > 0) {
      try {
        const glossLang = generated.gloss_lang || "en";
        const validated = await validatePracticeSentences(practiceSentences, glossLang);
        // Merge validation scores
        for (let i = 0; i < practiceSentences.length && i < (validated?.sentences?.length || 0); i++) {
          practiceSentences[i] = {
            ...practiceSentences[i],
            ...(validated.sentences[i] || {})
          };
        }
      } catch (e) {
        logger.warn("[content-analyze-gen] validation step failed, returning unvalidated", { error: e?.message });
      }
    }

    return res.status(200).json({
      ok: true,
      source_type: sourceType,
      source_id: sourceId,
      practice_sentences: practiceSentences,
      count: practiceSentences.length,
      cefr_level: cefrLevel,
      cefr_target: cefrTarget,
      perspective,
      politeness
    });
  } catch (err) {
    logger.error("[content-analyze-gen] generate-practice failed", { error: err?.message, stack: err?.stack });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
