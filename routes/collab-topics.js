// routes/collab-topics.js — Class-scoped collaboration topics (translated notebooks)

const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");

const router = express.Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSLATE_MODEL = "gpt-4o-mini";

const LANG_NAMES = {
  en: "English", ko: "Korean", fr: "French", es: "Spanish",
  ja: "Japanese", zh: "Chinese", de: "German", pt: "Portuguese",
};
function langName(code) { return LANG_NAMES[code] || code; }

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

/** Check class membership. Returns { isMember, isTeacher, role } */
async function checkClassAccess(classId, userId) {
  const r = await pool.query(
    `SELECT c.teacher_id,
            cm.role AS member_role
       FROM classes c
       LEFT JOIN class_members cm ON cm.class_id = c.class_id AND cm.user_id = $2::uuid
      WHERE c.class_id = $1::uuid`,
    [classId, userId]
  );
  if (r.rows.length === 0) return { isMember: false, isTeacher: false, role: null };
  const row = r.rows[0];
  const isTeacher = row.teacher_id === userId;
  const isMember = isTeacher || row.member_role != null;
  return { isMember, isTeacher, role: isTeacher ? "teacher" : row.member_role };
}

/** Get distinct primary_language values for all class members. */
async function getClassMemberLanguages(classId) {
  const r = await pool.query(
    `SELECT DISTINCT u.primary_language
       FROM class_members cm
       JOIN users u ON u.user_id = cm.user_id
      WHERE cm.class_id = $1::uuid AND u.primary_language IS NOT NULL
     UNION
     SELECT u.primary_language
       FROM classes c
       JOIN users u ON u.user_id = c.teacher_id
      WHERE c.class_id = $1::uuid AND u.primary_language IS NOT NULL`,
    [classId]
  );
  return r.rows.map(row => row.primary_language).filter(Boolean);
}

function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/* ------------------------------------------------------------------
   Translation (same pattern as collaboration.js)
------------------------------------------------------------------ */

async function detectLanguage(text) {
  if (!OPENAI_API_KEY) return "en";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "Detect the primary language. Return ONLY a two-letter ISO 639-1 code. Nothing else." },
        { role: "user", content: text },
      ],
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) return "en";
  return (json?.choices?.[0]?.message?.content || "en").trim().toLowerCase().slice(0, 2);
}

async function translateText(text, sourceLang, targetLang) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const systemPrompt = `You are translating a collaborative note in HakMun, a Korean language learning app.

The author is writing in ${langName(sourceLang)}.

Rules:
- Text inside quotation marks ("..." or "...") must be preserved EXACTLY as-is. Do NOT translate quoted text.
- Translate everything else into ${langName(targetLang)}.
- Keep the tone conversational and natural.
- Preserve all formatting (headings, lists, line breaks).
- Return ONLY the translation. No explanations.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`openai_translate_${resp.status}`);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("openai_translate_no_content");
  return content.trim();
}

/** Translate topic document content per-paragraph to all needed languages. */
/**
 * Translate topic content with per-paragraph caching.
 * Only paragraphs without a cached translation are sent to the API.
 * Returns { paragraphsSent, paragraphsCached }.
 */
async function translateTopicContent(topicId, content, hash, classId) {
  if (!content.trim()) return { paragraphsSent: 0, paragraphsCached: 0 };
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const paragraphs = content.split("\n\n").filter(p => p.trim());
  if (paragraphs.length === 0) return { paragraphsSent: 0, paragraphsCached: 0 };

  // Detect source language from first substantial paragraph
  const sampleText = paragraphs.find(p => p.trim().length > 10) || paragraphs[0];
  const sourceLang = await detectLanguage(sampleText);
  const allLangs = await getClassMemberLanguages(classId);
  const targetLangs = allLangs.filter(l => l !== sourceLang);

  let totalSent = 0;
  let totalCached = 0;

  for (const targetLang of targetLangs) {
    // Check if full document translation is already current
    const existing = await pool.query(
      `SELECT source_hash FROM collab_topic_translations
        WHERE topic_id = $1 AND language = $2`,
      [topicId, targetLang]
    );
    if (existing.rows.length > 0 && existing.rows[0].source_hash === hash) {
      totalCached += paragraphs.length;
      continue;
    }

    const translatedParagraphs = [];
    for (const para of paragraphs) {
      const paraHash = contentHash(para);

      // Check paragraph cache
      const cached = await pool.query(
        `SELECT translated_text FROM collab_paragraph_cache
          WHERE source_hash = $1 AND source_lang = $2 AND target_lang = $3`,
        [paraHash, sourceLang, targetLang]
      );

      if (cached.rows.length > 0) {
        translatedParagraphs.push(cached.rows[0].translated_text);
        totalCached++;
      } else {
        const translated = await translateText(para, sourceLang, targetLang);
        translatedParagraphs.push(translated);
        totalSent++;

        // Cache the paragraph translation
        await pool.query(
          `INSERT INTO collab_paragraph_cache (source_hash, source_lang, target_lang, translated_text)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_hash, source_lang, target_lang)
           DO UPDATE SET translated_text = EXCLUDED.translated_text, created_at = now()`,
          [paraHash, sourceLang, targetLang, translated]
        );
      }
    }

    const translatedDoc = translatedParagraphs.join("\n\n");
    await pool.query(
      `INSERT INTO collab_topic_translations (topic_id, language, translated_text, source_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (topic_id, language)
       DO UPDATE SET translated_text = EXCLUDED.translated_text,
                     source_hash = EXCLUDED.source_hash,
                     created_at = now()`,
      [topicId, targetLang, translatedDoc, hash]
    );
  }

  return { paragraphsSent: totalSent, paragraphsCached: totalCached };
}

/* ------------------------------------------------------------------
   GET /v1/classes/:classId/topics — List topics
------------------------------------------------------------------ */

router.get("/v1/classes/:classId/topics", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const r = await withTimeout(
      pool.query(
        `SELECT t.id, t.class_id, t.title, t.created_by, t.created_at, t.updated_at,
                CASE WHEN tr.last_read_at IS NULL OR t.updated_at > tr.last_read_at
                     THEN true ELSE false END AS has_unread
           FROM collab_topics t
           LEFT JOIN collab_topic_reads tr ON tr.topic_id = t.id AND tr.user_id = $2::uuid
          WHERE t.class_id = $1::uuid
          ORDER BY t.updated_at DESC`,
        [classId, userId]
      ),
      8000,
      "db-list-collab-topics"
    );

    res.json({ ok: true, topics: r.rows });
  } catch (err) {
    logger.error({ err }, "GET /topics failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/classes/:classId/topics — Create topic
------------------------------------------------------------------ */

router.post("/v1/classes/:classId/topics", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });
    if (access.role !== "teacher" && !access.isTeacher) {
      return res.status(403).json({ ok: false, error: "TEACHER_ONLY" });
    }

    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ ok: false, error: "TITLE_REQUIRED" });

    const r = await pool.query(
      `INSERT INTO collab_topics (class_id, title, created_by)
       VALUES ($1::uuid, $2, $3::uuid)
       RETURNING id, class_id, title, created_by, created_at, updated_at`,
      [classId, title.trim(), userId]
    );

    res.status(201).json({ ok: true, topic: { ...r.rows[0], has_unread: false } });
  } catch (err) {
    logger.error({ err }, "POST /topics failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   PUT /v1/classes/:classId/topics/:topicId — Update topic title
------------------------------------------------------------------ */

router.put("/v1/classes/:classId/topics/:topicId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const { title } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ ok: false, error: "TITLE_REQUIRED" });

    // Only topic creator or teacher can update
    const topic = await pool.query(
      `SELECT created_by FROM collab_topics WHERE id = $1::uuid AND class_id = $2::uuid`,
      [topicId, classId]
    );
    if (topic.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (topic.rows[0].created_by !== userId && !access.isTeacher && access.role !== "teacher") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    await pool.query(
      `UPDATE collab_topics SET title = $1, updated_at = now() WHERE id = $2::uuid`,
      [title.trim(), topicId]
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "PUT /topics/:id failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   DELETE /v1/classes/:classId/topics/:topicId — Delete topic
------------------------------------------------------------------ */

router.delete("/v1/classes/:classId/topics/:topicId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const topic = await pool.query(
      `SELECT created_by FROM collab_topics WHERE id = $1::uuid AND class_id = $2::uuid`,
      [topicId, classId]
    );
    if (topic.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (topic.rows[0].created_by !== userId && !access.isTeacher && access.role !== "teacher") {
      return res.status(403).json({ ok: false, error: "FORBIDDEN" });
    }

    await pool.query(`DELETE FROM collab_topics WHERE id = $1::uuid`, [topicId]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "DELETE /topics/:id failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/classes/:classId/topics/:topicId/content — Get document content
------------------------------------------------------------------ */

router.get("/v1/classes/:classId/topics/:topicId/content", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    // Get user's language for auto-display
    const userR = await pool.query(
      `SELECT primary_language FROM users WHERE user_id = $1::uuid`, [userId]
    );
    const userLang = userR.rows[0]?.primary_language || "en";

    const r = await pool.query(
      `SELECT content, content_hash, updated_at
         FROM collab_topics
        WHERE id = $1::uuid AND class_id = $2::uuid`,
      [topicId, classId]
    );
    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    // Mark as read
    await pool.query(
      `INSERT INTO collab_topic_reads (topic_id, user_id, last_read_at)
       VALUES ($1::uuid, $2::uuid, now())
       ON CONFLICT (topic_id, user_id)
       DO UPDATE SET last_read_at = now()`,
      [topicId, userId]
    );

    // Check if a translation exists for the user's language
    const transR = await pool.query(
      `SELECT translated_text, source_hash FROM collab_topic_translations
        WHERE topic_id = $1::uuid AND language = $2`,
      [topicId, userLang]
    );
    const translation = transR.rows[0] || null;

    const row = r.rows[0];
    res.json({
      ok: true,
      content: row.content || "",
      content_hash: row.content_hash,
      updated_at: row.updated_at,
      translation: translation ? translation.translated_text : null,
      translation_source_hash: translation ? translation.source_hash : null,
      translation_stale: translation ? translation.source_hash !== row.content_hash : null,
    });
  } catch (err) {
    logger.error({ err }, "GET /content failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   PUT /v1/classes/:classId/topics/:topicId/content — Save document content
------------------------------------------------------------------ */

router.put("/v1/classes/:classId/topics/:topicId/content", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const topicCheck = await pool.query(
      `SELECT 1 FROM collab_topics WHERE id = $1::uuid AND class_id = $2::uuid`,
      [topicId, classId]
    );
    if (topicCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ ok: false, error: "CONTENT_REQUIRED" });

    const hash = contentHash(content);

    await pool.query(
      `UPDATE collab_topics SET content = $1, content_hash = $2, updated_at = now()
        WHERE id = $3::uuid`,
      [content, hash, topicId]
    );

    res.json({ ok: true, content_hash: hash });
  } catch (err) {
    logger.error({ err }, "PUT /content failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/classes/:classId/topics/:topicId/translate — Trigger translation
   Saves content first, then translates only changed paragraphs.
------------------------------------------------------------------ */

router.post("/v1/classes/:classId/topics/:topicId/translate", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const { content, source_language } = req.body;
    if (typeof content !== "string" || !content.trim()) {
      return res.json({ ok: true, paragraphs_sent: 0, paragraphs_cached: 0 });
    }

    const hash = contentHash(content);
    const sourceLang = source_language || "en";

    // Save the source content to the right place
    if (sourceLang === "en") {
      // English content goes to the main content column
      await pool.query(
        `UPDATE collab_topics SET content = $1, content_hash = $2, updated_at = now()
          WHERE id = $3::uuid`,
        [content, hash, topicId]
      );
    } else {
      // Non-English content goes to the translations table as the source
      await pool.query(
        `INSERT INTO collab_topic_translations (topic_id, language, translated_text, source_hash)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (topic_id, language)
         DO UPDATE SET translated_text = EXCLUDED.translated_text,
                       source_hash = EXCLUDED.source_hash,
                       created_at = now()`,
        [topicId, sourceLang, content, hash]
      );
      await pool.query(
        `UPDATE collab_topics SET updated_at = now() WHERE id = $1::uuid`, [topicId]
      );
    }

    // Translate to all other class member languages
    const allLangs = await getClassMemberLanguages(classId);
    const targetLangs = allLangs.filter(l => l !== sourceLang);
    if (targetLangs.length === 0) {
      return res.json({ ok: true, paragraphs_sent: 0, paragraphs_cached: 0 });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_NOT_CONFIGURED" });
    }

    const paragraphs = content.split("\n\n").filter(p => p.trim());
    let totalSent = 0;
    let totalCached = 0;

    for (const targetLang of targetLangs) {
      const translatedParagraphs = [];
      for (const para of paragraphs) {
        const paraHash = contentHash(para);
        const cached = await pool.query(
          `SELECT translated_text FROM collab_paragraph_cache
            WHERE source_hash = $1 AND source_lang = $2 AND target_lang = $3`,
          [paraHash, sourceLang, targetLang]
        );
        if (cached.rows.length > 0) {
          translatedParagraphs.push(cached.rows[0].translated_text);
          totalCached++;
        } else {
          const translated = await translateText(para, sourceLang, targetLang);
          translatedParagraphs.push(translated);
          totalSent++;
          await pool.query(
            `INSERT INTO collab_paragraph_cache (source_hash, source_lang, target_lang, translated_text)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (source_hash, source_lang, target_lang)
             DO UPDATE SET translated_text = EXCLUDED.translated_text, created_at = now()`,
            [paraHash, sourceLang, targetLang, translated]
          );
        }
      }

      const translatedDoc = translatedParagraphs.join("\n\n");

      if (targetLang === "en") {
        // If translating TO English, update the main content column
        const enHash = contentHash(translatedDoc);
        await pool.query(
          `UPDATE collab_topics SET content = $1, content_hash = $2, updated_at = now()
            WHERE id = $3::uuid`,
          [translatedDoc, enHash, topicId]
        );
      } else {
        // Store as a translation
        await pool.query(
          `INSERT INTO collab_topic_translations (topic_id, language, translated_text, source_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (topic_id, language)
           DO UPDATE SET translated_text = EXCLUDED.translated_text,
                         source_hash = EXCLUDED.source_hash,
                         created_at = now()`,
          [topicId, targetLang, translatedDoc, hash]
        );
      }
    }

    res.json({
      ok: true,
      paragraphs_sent: totalSent,
      paragraphs_cached: totalCached,
    });
  } catch (err) {
    logger.error({ err, topicId: req.params.topicId }, "POST /translate failed");
    const msg = err.message === "OPENAI_API_KEY not configured" ? "OPENAI_NOT_CONFIGURED" : "INTERNAL";
    res.status(500).json({ ok: false, error: msg });
  }
});

/* ------------------------------------------------------------------
   PUT /v1/classes/:classId/topics/:topicId/translation — Save translated content directly
   Used when a user edits the translated version of the document.
------------------------------------------------------------------ */

router.put("/v1/classes/:classId/topics/:topicId/translation", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const topicCheck = await pool.query(
      `SELECT content_hash FROM collab_topics WHERE id = $1::uuid AND class_id = $2::uuid`,
      [topicId, classId]
    );
    if (topicCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const { content, language } = req.body;
    if (typeof content !== "string") return res.status(400).json({ ok: false, error: "CONTENT_REQUIRED" });
    if (!language) return res.status(400).json({ ok: false, error: "LANGUAGE_REQUIRED" });

    const sourceHash = topicCheck.rows[0].content_hash || "";

    await pool.query(
      `INSERT INTO collab_topic_translations (topic_id, language, translated_text, source_hash)
       VALUES ($1::uuid, $2, $3, $4)
       ON CONFLICT (topic_id, language)
       DO UPDATE SET translated_text = EXCLUDED.translated_text,
                     source_hash = EXCLUDED.source_hash,
                     created_at = now()`,
      [topicId, language, content, sourceHash]
    );

    // Update topic timestamp
    await pool.query(
      `UPDATE collab_topics SET updated_at = now() WHERE id = $1::uuid`, [topicId]
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "PUT /translation failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/classes/:classId/topics/:topicId/translation — Get translated content
------------------------------------------------------------------ */

router.get("/v1/classes/:classId/topics/:topicId/translation", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    // Get reader's language
    const userR = await pool.query(
      `SELECT primary_language FROM users WHERE user_id = $1::uuid`, [userId]
    );
    const lang = userR.rows[0]?.primary_language || "en";

    // Get current content hash
    const topicR = await pool.query(
      `SELECT content_hash FROM collab_topics WHERE id = $1::uuid AND class_id = $2::uuid`,
      [topicId, classId]
    );
    if (topicR.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const currentHash = topicR.rows[0].content_hash;

    // Only return translation if source_hash matches (not stale)
    const transR = await pool.query(
      `SELECT translated_text, source_hash FROM collab_topic_translations
        WHERE topic_id = $1::uuid AND language = $2`,
      [topicId, lang]
    );

    if (transR.rows.length === 0 || transR.rows[0].source_hash !== currentHash) {
      return res.json({ ok: true, translated_content: null, stale: transR.rows.length > 0 });
    }

    res.json({ ok: true, translated_content: transR.rows[0].translated_text, stale: false });
  } catch (err) {
    logger.error({ err }, "GET /translation failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/classes/:classId/topics/:topicId/read — Mark read
------------------------------------------------------------------ */

router.post("/v1/classes/:classId/topics/:topicId/read", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    await pool.query(
      `INSERT INTO collab_topic_reads (topic_id, user_id, last_read_at)
       VALUES ($1::uuid, $2::uuid, now())
       ON CONFLICT (topic_id, user_id)
       DO UPDATE SET last_read_at = now()`,
      [topicId, userId]
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /read failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
