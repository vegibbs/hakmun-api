// routes/collab-topics.js — Class-scoped collaboration topics (translated notebooks)

const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");
const { signImageUrl } = require("../util/s3");

const router = express.Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSLATE_MODEL = "gpt-4o-mini";

const AUTHOR_COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899"];

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

/** Get author color index for a user within a class (stable by join order). */
async function getAuthorColorMap(classId) {
  const r = await pool.query(
    `SELECT cm.user_id
       FROM class_members cm
      WHERE cm.class_id = $1::uuid
      ORDER BY cm.joined_at ASC`,
    [classId]
  );
  const map = {};
  r.rows.forEach((row, i) => {
    map[row.user_id] = AUTHOR_COLORS[i % AUTHOR_COLORS.length];
  });
  return map;
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
- Preserve Korean linguistic examples exactly as-is.
- Translate the discussion into ${langName(targetLang)}.
- Keep the tone conversational and natural.
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

/** Translate a block's text to all needed languages (incremental). */
async function translateBlock(blockId, text, hash, classId) {
  const sourceLang = await detectLanguage(text);
  const allLangs = await getClassMemberLanguages(classId);
  const targetLangs = allLangs.filter(l => l !== sourceLang);

  for (const targetLang of targetLangs) {
    // Check if we already have a translation with matching hash
    const existing = await pool.query(
      `SELECT 1 FROM collab_block_translations
        WHERE block_id = $1 AND language = $2 AND source_hash = $3`,
      [blockId, targetLang, hash]
    );
    if (existing.rows.length > 0) continue; // cache hit

    try {
      const translated = await translateText(text, sourceLang, targetLang);
      await pool.query(
        `INSERT INTO collab_block_translations (block_id, language, translated_text, source_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (block_id, language)
         DO UPDATE SET translated_text = EXCLUDED.translated_text,
                       source_hash = EXCLUDED.source_hash,
                       created_at = now()`,
        [blockId, targetLang, translated, hash]
      );
    } catch (err) {
      logger.error({ err, blockId, targetLang }, "collab-topic: translation failed");
    }
  }
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
        `SELECT t.id, t.title, t.created_by, t.created_at, t.updated_at,
                (SELECT COUNT(*)::int FROM collab_topic_blocks b WHERE b.topic_id = t.id) AS block_count,
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

    res.status(201).json({ ok: true, topic: { ...r.rows[0], block_count: 0, has_unread: false } });
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
   GET /v1/classes/:classId/topics/:topicId/blocks — List blocks
------------------------------------------------------------------ */

router.get("/v1/classes/:classId/topics/:topicId/blocks", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    // Verify topic belongs to class
    const topicCheck = await pool.query(
      `SELECT 1 FROM collab_topics WHERE id = $1::uuid AND class_id = $2::uuid`,
      [topicId, classId]
    );
    if (topicCheck.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const readerLang = await pool.query(
      `SELECT primary_language FROM users WHERE user_id = $1::uuid`, [userId]
    );
    const lang = readerLang.rows[0]?.primary_language || "en";

    const colorMap = await getAuthorColorMap(classId);

    const blocksR = await withTimeout(
      pool.query(
        `SELECT b.id, b.author_user_id, b.content_type, b.content_text,
                b.media_id, b.sort_order, b.created_at, b.updated_at,
                u.display_name AS author_display_name,
                m.object_key AS media_object_key,
                bt.translated_text, bt.source_hash AS translation_source_hash,
                b.content_hash
           FROM collab_topic_blocks b
           JOIN users u ON u.user_id = b.author_user_id
           LEFT JOIN media m ON m.id = b.media_id
           LEFT JOIN collab_block_translations bt
             ON bt.block_id = b.id AND bt.language = $2
          WHERE b.topic_id = $1::uuid
          ORDER BY b.sort_order ASC, b.created_at ASC`,
        [topicId, lang]
      ),
      8000,
      "db-list-collab-blocks"
    );

    const blocks = await Promise.all(blocksR.rows.map(async (row) => {
      let mediaUrl = null;
      if (row.media_object_key) {
        try { mediaUrl = await signImageUrl(row.media_object_key); } catch {}
      }

      // Only include translation if it's current (hash matches)
      const translatedText = (row.translated_text && row.translation_source_hash === row.content_hash)
        ? row.translated_text : null;

      return {
        id: row.id,
        author_user_id: row.author_user_id,
        author_display_name: row.author_display_name,
        author_color: colorMap[row.author_user_id] || AUTHOR_COLORS[0],
        content_type: row.content_type,
        content_text: row.content_text,
        translated_text: translatedText,
        is_translated: translatedText != null,
        media_url: mediaUrl,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }));

    // Mark as read
    await pool.query(
      `INSERT INTO collab_topic_reads (topic_id, user_id, last_read_at)
       VALUES ($1::uuid, $2::uuid, now())
       ON CONFLICT (topic_id, user_id)
       DO UPDATE SET last_read_at = now()`,
      [topicId, userId]
    );

    res.json({ ok: true, blocks });
  } catch (err) {
    logger.error({ err }, "GET /blocks failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/classes/:classId/topics/:topicId/blocks — Add block
------------------------------------------------------------------ */

router.post("/v1/classes/:classId/topics/:topicId/blocks", requireSession, async (req, res) => {
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

    const { content_type = "text", content_text, media_id, sort_order = 0 } = req.body;

    if (content_type === "text" && (!content_text || !content_text.trim())) {
      return res.status(400).json({ ok: false, error: "CONTENT_REQUIRED" });
    }

    const hash = content_text ? contentHash(content_text) : null;

    const r = await pool.query(
      `INSERT INTO collab_topic_blocks (topic_id, author_user_id, content_type, content_text, media_id, content_hash, sort_order)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
       RETURNING id, author_user_id, content_type, content_text, media_id, sort_order, created_at, updated_at`,
      [topicId, userId, content_type, content_text?.trim() || null, media_id || null, hash, sort_order]
    );

    // Update topic updated_at
    await pool.query(
      `UPDATE collab_topics SET updated_at = now() WHERE id = $1::uuid`,
      [topicId]
    );

    // Translate in background (don't block response)
    if (content_type === "text" && content_text) {
      const blockId = r.rows[0].id;
      translateBlock(blockId, content_text.trim(), hash, classId).catch(err => {
        logger.error({ err, blockId }, "collab-topic: background translation failed");
      });
    }

    res.status(201).json({ ok: true, block: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "POST /blocks failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   PUT /v1/classes/:classId/topics/:topicId/blocks/:blockId — Edit block
------------------------------------------------------------------ */

router.put("/v1/classes/:classId/topics/:topicId/blocks/:blockId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId, blockId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const block = await pool.query(
      `SELECT author_user_id, content_hash FROM collab_topic_blocks
        WHERE id = $1::uuid AND topic_id = $2::uuid`,
      [blockId, topicId]
    );
    if (block.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (block.rows[0].author_user_id !== userId) {
      return res.status(403).json({ ok: false, error: "NOT_AUTHOR" });
    }

    const { content_text } = req.body;
    if (!content_text || !content_text.trim()) {
      return res.status(400).json({ ok: false, error: "CONTENT_REQUIRED" });
    }

    const newHash = contentHash(content_text.trim());

    await pool.query(
      `UPDATE collab_topic_blocks
          SET content_text = $1, content_hash = $2, updated_at = now()
        WHERE id = $3::uuid`,
      [content_text.trim(), newHash, blockId]
    );

    // Update topic updated_at
    await pool.query(
      `UPDATE collab_topics SET updated_at = now() WHERE id = $1::uuid`,
      [topicId]
    );

    // Re-translate if content changed
    if (newHash !== block.rows[0].content_hash) {
      translateBlock(blockId, content_text.trim(), newHash, classId).catch(err => {
        logger.error({ err, blockId }, "collab-topic: re-translation failed");
      });
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "PUT /blocks/:id failed");
    res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   DELETE /v1/classes/:classId/topics/:topicId/blocks/:blockId
------------------------------------------------------------------ */

router.delete("/v1/classes/:classId/topics/:topicId/blocks/:blockId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId, topicId, blockId } = req.params;
    const access = await checkClassAccess(classId, userId);
    if (!access.isMember) return res.status(403).json({ ok: false, error: "NOT_MEMBER" });

    const block = await pool.query(
      `SELECT author_user_id FROM collab_topic_blocks
        WHERE id = $1::uuid AND topic_id = $2::uuid`,
      [blockId, topicId]
    );
    if (block.rows.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (block.rows[0].author_user_id !== userId) {
      return res.status(403).json({ ok: false, error: "NOT_AUTHOR" });
    }

    await pool.query(`DELETE FROM collab_topic_blocks WHERE id = $1::uuid`, [blockId]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "DELETE /blocks/:id failed");
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
