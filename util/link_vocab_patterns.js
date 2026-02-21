// util/link_vocab_patterns.js — HakMun API
// Shared functions for linking sentences to vocabulary and grammar patterns.
// Used by both google_docs_commit.js (doc import) and generate.js (sentence generation).

const { withTimeout } = require("./time");
const { logger } = require("./log");

const QUERY_TIMEOUT_MS = 8000;

/**
 * Link a sentence to its vocabulary words via sentence_vocab_links.
 *
 * By default, only links to EXISTING teaching_vocab entries (lookup-only mode).
 * teaching_vocab is a curated, teacher-approved list — we don't auto-create entries.
 * Pass { createProvisional: true } to allow creating provisional entries (used by doc import
 * where a teacher is actively importing content and expects new words to be tracked).
 *
 * @param {Function} q - Bound query function (client.query.bind(client) or pool.query)
 * @param {string} sentenceContentItemId - UUID of the sentence content_item
 * @param {Array<{lemma_ko: string, pos_ko?: string}>} vocabularyArray
 * @param {Object} [opts]
 * @param {boolean} [opts.createProvisional=false] - If true, create missing teaching_vocab entries as provisional
 * @returns {number} Number of links created
 */
async function linkSentenceVocab(q, sentenceContentItemId, vocabularyArray, opts = {}) {
  if (!Array.isArray(vocabularyArray) || vocabularyArray.length === 0) return 0;

  const createProvisional = opts.createProvisional === true;
  let linked = 0;

  for (const v of vocabularyArray) {
    const lemma = cleanStr(v?.lemma_ko, 200);
    if (!lemma) continue;
    const pos = cleanStr(v?.pos_ko, 40) || "기타";

    // Look up existing teaching_vocab by lemma
    let tvId = null;
    const tvMatch = await withTimeout(
      q(
        `SELECT id FROM teaching_vocab WHERE lemma = $1 LIMIT 1`,
        [lemma]
      ),
      QUERY_TIMEOUT_MS,
      "link-match-tv"
    );

    if (tvMatch.rows.length > 0) {
      tvId = tvMatch.rows[0].id;
    } else if (createProvisional) {
      // Create new teaching_vocab entry (provisional) — doc import only
      const tvInsert = await withTimeout(
        q(
          `INSERT INTO teaching_vocab (lemma, part_of_speech, pos_code, status)
           VALUES ($1, $2, $3, 'provisional')
           ON CONFLICT (lemma, part_of_speech) DO UPDATE SET lemma = EXCLUDED.lemma
           RETURNING id`,
          [lemma, pos, pos]
        ),
        QUERY_TIMEOUT_MS,
        "link-create-tv"
      );
      tvId = tvInsert.rows?.[0]?.id || null;
    }
    // else: word not in curated teaching_vocab — skip link

    if (tvId) {
      await withTimeout(
        q(
          `INSERT INTO sentence_vocab_links (sentence_content_item_id, teaching_vocab_id)
           VALUES ($1::uuid, $2::uuid)
           ON CONFLICT (sentence_content_item_id, teaching_vocab_id) DO NOTHING`,
          [sentenceContentItemId, tvId]
        ),
        QUERY_TIMEOUT_MS,
        "link-insert-svl"
      );
      linked += 1;
    }
  }

  return linked;
}

/**
 * Link a sentence to grammar patterns via content_item_grammar_links.
 * Matches surface forms against grammar_pattern_aliases.
 *
 * @param {Function} q - Bound query function
 * @param {string} sentenceContentItemId - UUID of the sentence content_item
 * @param {Array<{surface_form: string}>} patternsArray
 * @returns {number} Number of links created
 */
async function linkSentenceGrammarPatterns(q, sentenceContentItemId, patternsArray) {
  if (!Array.isArray(patternsArray) || patternsArray.length === 0) return 0;

  let linked = 0;

  for (const p of patternsArray) {
    const surface = cleanStr(p?.surface_form, 200);
    if (!surface) continue;

    const norm = surface.replace(/[\s\t\n\r]/g, "");
    if (!norm) continue;

    try {
      const aliasMatch = await withTimeout(
        q(
          `SELECT grammar_pattern_id
             FROM grammar_pattern_aliases
            WHERE alias_norm = $1
            LIMIT 1`,
          [norm]
        ),
        QUERY_TIMEOUT_MS,
        "link-match-alias"
      );

      if (aliasMatch.rows.length > 0) {
        const grammarPatternId = aliasMatch.rows[0].grammar_pattern_id;
        await withTimeout(
          q(
            `INSERT INTO content_item_grammar_links (content_item_id, grammar_pattern_id, role)
             VALUES ($1::uuid, $2::uuid, 'component')
             ON CONFLICT DO NOTHING`,
            [sentenceContentItemId, grammarPatternId]
          ),
          QUERY_TIMEOUT_MS,
          "link-insert-cigl"
        );
        linked += 1;
      }
    } catch (e) {
      logger.warn("[link-patterns] alias match failed", {
        surface,
        norm,
        error: e?.message,
      });
    }
  }

  return linked;
}

function cleanStr(v, maxLen = 200) {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

module.exports = { linkSentenceVocab, linkSentenceGrammarPatterns };
