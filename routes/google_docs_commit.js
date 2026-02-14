// FILE: hakmun-api/routes/google_docs_commit.js
// PURPOSE: D2.x — Commit reviewed highlight-import items into user library tables.
// ENDPOINT:
//   POST /v1/documents/google/commit
//
// Contract:
// - Requires user session (Bearer)
// - Accepts user-approved items (vocabulary, sentences, patterns)
// - Writes user-scoped items to:
//     - content_items (sentences, patterns)
//     - user_vocab_items (vocabulary)
// - Ensures a documents row exists for provenance (google_doc_url + snapshot asset_id)
// - Attempts to write document linkage rows (document_vocab_links, document_content_item_links)
//   so practice modules can scope to a document.
//
// Notes:
// - This endpoint is synchronous and intended for small, reviewed batches.
// - It does NOT call OpenAI.

const express = require("express");
const crypto = require("crypto");

const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));
}

function cleanString(v, maxLen = 2000) {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function ensureGoogleDocumentRow({ userId, googleDocUrl, snapshotAssetId, title }) {
  // Prefer reusing an existing document row for this user+source_uri.
  const r = await withTimeout(
    pool.query(
      `SELECT document_id
         FROM documents
        WHERE owner_user_id = $1::uuid
          AND source_kind = 'google_doc'
          AND source_uri = $2
        LIMIT 1`,
      [userId, googleDocUrl]
    ),
    8000,
    "db-find-document"
  );

  const existing = r.rows?.[0]?.document_id || null;
  if (existing) return existing;

  if (!looksLikeUUID(snapshotAssetId)) {
    throw new Error("SNAPSHOT_ASSET_ID_REQUIRED");
  }

  const documentId = crypto.randomUUID();
  const t = cleanString(title, 140) || "Google Doc";

  await withTimeout(
    pool.query(
      `INSERT INTO documents (
         document_id, owner_user_id, asset_id, source_kind, source_uri, title, ingest_status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'google_doc', $4, $5, 'verified'
       )`,
      [documentId, userId, snapshotAssetId, googleDocUrl, t]
    ),
    8000,
    "db-insert-document"
  );

  return documentId;
}

router.post("/v1/documents/google/commit", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const googleDocUrl = cleanString(req.body?.google_doc_url, 4000);
    const snapshotAssetId = cleanString(req.body?.asset_id, 80);
    const documentTitle = cleanString(req.body?.title, 140);

    // Session date from the HEADING_1 the highlighted text falls under (YYYY-MM-DD or null)
    const rawSessionDate = cleanString(req.body?.session_date, 10);
    const sessionDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSessionDate) ? rawSessionDate : null;

    if (!googleDocUrl) {
      return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });
    }

    // Reviewed payloads (tabs)
    const vocabulary = Array.isArray(req.body?.vocabulary) ? req.body.vocabulary : [];
    const sentences = Array.isArray(req.body?.sentences) ? req.body.sentences : [];
    const patterns = Array.isArray(req.body?.patterns) ? req.body.patterns : [];

    // Guardrails (synchronous endpoint)
    if (vocabulary.length + sentences.length + patterns.length === 0) {
      return res.status(400).json({ ok: false, error: "NOTHING_TO_COMMIT" });
    }
    if (vocabulary.length > 500 || sentences.length > 500 || patterns.length > 500) {
      return res.status(413).json({ ok: false, error: "TOO_MANY_ITEMS" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const documentId = await ensureGoogleDocumentRow({
        userId,
        googleDocUrl,
        snapshotAssetId,
        title: documentTitle
      });

      let sentencesCreated = 0;
      let patternsCreated = 0;
      let vocabTouched = 0;

      // -----------------------------
      // Sentences -> content_items (dedupe on owner + text)
      // -----------------------------
      for (const s of sentences) {
        const ko = cleanString(s?.ko, 4000);
        if (!ko) continue;

        // Check for existing sentence with same text for this user
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
        if (existing.rows.length > 0) continue;

        const contentItemId = crypto.randomUUID();

        const ins = await withTimeout(
          client.query(
            `INSERT INTO content_items (
               content_item_id,
               owner_user_id,
               content_type,
               text,
               language,
               notes
             )
             VALUES ($1::uuid, $2::uuid, $3, $4, 'ko', NULL)
             ON CONFLICT DO NOTHING
             RETURNING content_item_id`,
            [contentItemId, userId, "sentence", ko]
          ),
          8000,
          "db-insert-content-sentence"
        );

        const insertedId = ins.rows?.[0]?.content_item_id || null;
        if (insertedId) {
          sentencesCreated += 1;

          // Link to document for scoping (requires table to exist)
          await withTimeout(
            client.query(
              `INSERT INTO document_content_item_links (document_id, content_item_id, link_kind, session_date)
               VALUES ($1::uuid, $2::uuid, 'sentence', $3::date)
               ON CONFLICT DO NOTHING`,
              [documentId, insertedId, sessionDate]
            ),
            8000,
            "db-link-doc-content-sentence"
          );

          await withTimeout(
            client.query(
              `INSERT INTO library_registry_items
                 (id, content_type, content_id, owner_user_id, audience, global_state, operational_status)
               VALUES
                 ($1::uuid, $2::text, $3::uuid, $4::uuid, 'personal', NULL, 'active')
               ON CONFLICT (content_type, content_id) DO NOTHING`,
              [crypto.randomUUID(), 'sentence', insertedId, userId]
            ),
            8000,
            "db-insert-registry-sentence"
          );
        }
      }

      // -----------------------------
      // Patterns -> content_items (dedupe on owner + text)
      // -----------------------------
      for (const p of patterns) {
        const surface = cleanString(p?.surface_form, 200);
        const context = cleanString(p?.context_span, 400);
        if (!surface) continue;

        const text = context ? `${surface}\n${context}` : surface;

        // Check for existing pattern with same text for this user
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
        if (existingPattern.rows.length > 0) continue;

        const contentItemId = crypto.randomUUID();

        const ins = await withTimeout(
          client.query(
            `INSERT INTO content_items (
               content_item_id,
               owner_user_id,
               content_type,
               text,
               language,
               notes
             )
             VALUES ($1::uuid, $2::uuid, $3, $4, 'ko', NULL)
             ON CONFLICT DO NOTHING
             RETURNING content_item_id`,
            [contentItemId, userId, "pattern", text]
          ),
          8000,
          "db-insert-content-pattern"
        );

        const insertedId = ins.rows?.[0]?.content_item_id || null;
        if (insertedId) {
          patternsCreated += 1;

          await withTimeout(
            client.query(
              `INSERT INTO document_content_item_links (document_id, content_item_id, link_kind, session_date)
               VALUES ($1::uuid, $2::uuid, 'pattern', $3::date)
               ON CONFLICT DO NOTHING`,
              [documentId, insertedId, sessionDate]
            ),
            8000,
            "db-link-doc-content-pattern"
          );

          await withTimeout(
            client.query(
              `INSERT INTO library_registry_items
                 (id, content_type, content_id, owner_user_id, audience, global_state, operational_status)
               VALUES
                 ($1::uuid, $2::text, $3::uuid, $4::uuid, 'personal', NULL, 'active')
               ON CONFLICT (content_type, content_id) DO NOTHING`,
              [crypto.randomUUID(), 'pattern', insertedId, userId]
            ),
            8000,
            "db-insert-registry-pattern"
          );
        }

        // Also stage for later promotion if needed (best-effort; table may not exist yet)
        // IMPORTANT: This must NOT abort the surrounding transaction.
        // We use a SAVEPOINT so any staging failure can be rolled back without poisoning BEGIN/COMMIT.
        const spName = "sp_unmatched_grammar";
        try {
          await client.query(`SAVEPOINT ${spName}`);

          const norm = surface.replace(/[\s\t\n\r]/g, "");
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
          // ignore (staging not yet installed or other non-fatal staging error)
        }
      }

      // -----------------------------
      // Vocabulary -> user_vocab_items (unique per user_id + lemma)
      // -----------------------------
      for (const v of vocabulary) {
        const lemma = cleanString(v?.lemma_ko, 200);
        if (!lemma) continue;

        // Link to teaching_vocab by lemma if not already provided
        let vocabIdUuid = null;
        const providedVocabId = cleanString(v?.vocab_id, 80);
        if (looksLikeUUID(providedVocabId)) {
          vocabIdUuid = providedVocabId;
        } else {
          // Look up lemma in teaching_vocab
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

        await withTimeout(
          client.query(
            `INSERT INTO user_vocab_items (user_id, lemma, vocab_id, first_seen_at, last_seen_at)
             VALUES ($1::uuid, $2, $3::uuid, now(), now())
             ON CONFLICT (user_id, lemma)
             DO UPDATE SET
               last_seen_at = now(),
               vocab_id = COALESCE(EXCLUDED.vocab_id, user_vocab_items.vocab_id)`,
            [userId, lemma, vocabIdUuid]
          ),
          8000,
          "db-upsert-user-vocab"
        );

        vocabTouched += 1;

        // Link vocab to document for later scoping (requires table to exist)
        await withTimeout(
          client.query(
            `INSERT INTO document_vocab_links (document_id, user_id, lemma, session_date)
             VALUES ($1::uuid, $2::uuid, $3, $4::date)
             ON CONFLICT DO NOTHING`,
            [documentId, userId, lemma, sessionDate]
          ),
          8000,
          "db-link-doc-vocab"
        );
      }

      await client.query("COMMIT");

      return res.status(201).json({
        ok: true,
        document_id: documentId,
        sentences_created: sentencesCreated,
        patterns_created: patternsCreated,
        vocab_touched: vocabTouched
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = String(err?.message || err);

    // Helpful deterministic errors
    if (msg === "SNAPSHOT_ASSET_ID_REQUIRED") {
      return res.status(400).json({ ok: false, error: "SNAPSHOT_ASSET_ID_REQUIRED" });
    }

    // Missing link tables: fail loudly so we add migrations (document scoping depends on them).
    if (msg.includes("relation \"document_content_item_links\" does not exist")) {
      return res.status(500).json({ ok: false, error: "MISSING_TABLE", table: "document_content_item_links" });
    }
    if (msg.includes("relation \"document_vocab_links\" does not exist")) {
      return res.status(500).json({ ok: false, error: "MISSING_TABLE", table: "document_vocab_links" });
    }

    logger.error("[google-commit] failed", {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      constraint: err?.constraint,
      table: err?.table,
      schema: err?.schema,
      column: err?.column,
      where: err?.where,
      stack: err?.stack
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;