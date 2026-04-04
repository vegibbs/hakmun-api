// routes/collaboration.js — Collaboration space (channels + messages with AI translation)

const express = require("express");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");
const { signImageUrl } = require("../util/s3");

const router = express.Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSLATE_MODEL = "gpt-4o-mini";
const TRANSLATE_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

async function getUserAppLanguage(userId) {
  const r = await pool.query(
    `SELECT primary_language FROM users WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0]?.primary_language || null;
}

/** Check if user is a member of the channel. */
async function isMember(channelId, userId) {
  const r = await pool.query(
    `SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId]
  );
  return r.rows.length > 0;
}

/** Check if user is admin of the channel. */
async function isChannelAdmin(channelId, userId) {
  const r = await pool.query(
    `SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role = 'admin'`,
    [channelId, userId]
  );
  return r.rows.length > 0;
}

/** Get unique languages needed for channel members (excluding source). */
async function getChannelMemberLanguages(channelId, excludeLang) {
  const r = await pool.query(
    `SELECT DISTINCT u.primary_language
     FROM channel_members cm
     JOIN users u ON u.user_id = cm.user_id
     WHERE cm.channel_id = $1 AND u.primary_language IS NOT NULL`,
    [channelId]
  );
  return r.rows
    .map((row) => row.primary_language)
    .filter((lang) => lang && lang !== excludeLang);
}

/* ------------------------------------------------------------------
   Translation helpers (reuse patterns from translate.js)
------------------------------------------------------------------ */

const LANG_NAMES = {
  en: "English", ko: "Korean", fr: "French", es: "Spanish",
  ja: "Japanese", zh: "Chinese", de: "German", pt: "Portuguese",
};
function langName(code) { return LANG_NAMES[code] || code; }

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

async function translateText(text, appLanguage, sourceLang, targetLang) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const mismatchBlock = appLanguage && appLanguage !== sourceLang
    ? `- They are writing in a non-native language. Produce a clear, natural translation in ${langName(targetLang)} that conveys their intent accurately.`
    : "";

  const systemPrompt = `You are translating a team message in HakMun, a Korean language learning app.

About the author:
- Their primary language is ${langName(appLanguage)}.
- They are writing in ${langName(sourceLang)}.
${mismatchBlock}

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

/* ------------------------------------------------------------------
   GET /v1/channels — List channels the user is a member of
------------------------------------------------------------------ */

router.get("/v1/channels", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const appLang = await getUserAppLanguage(userId);

    const r = await withTimeout(
      pool.query(
        `SELECT c.id, c.name, c.description, c.is_archived, c.created_at, c.updated_at,
                cm.role AS member_role,
                ct.name AS translated_name, ct.description AS translated_description
         FROM channels c
         JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
         LEFT JOIN channel_translations ct ON ct.channel_id = c.id AND ct.language = $2
         WHERE c.is_archived = false
         ORDER BY c.updated_at DESC`,
        [userId, appLang || "en"]
      ),
      8000,
      "db-list-channels"
    );

    const channels = r.rows.map((row) => ({
      id: row.id,
      name: row.translated_name || row.name,
      description: row.translated_description || row.description,
      original_name: row.name,
      member_role: row.member_role,
      is_archived: row.is_archived,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return res.json({ ok: true, channels });
  } catch (err) {
    logger.error("[collaboration] list channels failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/channels — Create a channel
------------------------------------------------------------------ */

router.post("/v1/channels", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { name, description } = req.body || {};
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ ok: false, error: "NAME_REQUIRED" });
    }

    const appLang = await getUserAppLanguage(userId);
    if (!appLang) {
      return res.status(400).json({ ok: false, error: "APP_LANGUAGE_NOT_SET" });
    }

    // Create channel
    const channelR = await withTimeout(
      pool.query(
        `INSERT INTO channels (name, description, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, name, description, created_at`,
        [name.trim(), description || null, userId]
      ),
      8000,
      "db-create-channel"
    );
    const channel = channelR.rows[0];

    // Add creator as admin member
    await pool.query(
      `INSERT INTO channel_members (channel_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [channel.id, userId]
    );

    // Translate channel name for other languages
    // Get unique member languages (just the creator for now)
    // We'll translate the name from the creator's language
    try {
      const detectedLang = await detectLanguage(name.trim());
      // Translate to common languages (en, ko) if different from source
      const targetLangs = ["en", "ko"].filter((l) => l !== detectedLang);
      for (const targetLang of targetLangs) {
        const translatedName = await translateText(name.trim(), appLang, detectedLang, targetLang);
        let translatedDesc = null;
        if (description && description.trim()) {
          translatedDesc = await translateText(description.trim(), appLang, detectedLang, targetLang);
        }
        await pool.query(
          `INSERT INTO channel_translations (channel_id, language, name, description)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (channel_id, language) DO UPDATE SET name = $3, description = $4`,
          [channel.id, targetLang, translatedName, translatedDesc]
        );
      }
      // Also store the original language version
      await pool.query(
        `INSERT INTO channel_translations (channel_id, language, name, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id, language) DO NOTHING`,
        [channel.id, detectedLang, name.trim(), description || null]
      );
    } catch (translationErr) {
      logger.warn("[collaboration] channel name translation failed", { err: String(translationErr?.message) });
      // Non-fatal — channel still created
    }

    return res.status(201).json({ ok: true, channel });
  } catch (err) {
    logger.error("[collaboration] create channel failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/channels/:id — Channel metadata + member list
------------------------------------------------------------------ */

router.get("/v1/channels/:id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    if (!await isMember(req.params.id, userId)) {
      return res.status(403).json({ ok: false, error: "NOT_A_MEMBER" });
    }

    const appLang = await getUserAppLanguage(userId);

    const channelR = await pool.query(
      `SELECT c.*, ct.name AS translated_name, ct.description AS translated_description
       FROM channels c
       LEFT JOIN channel_translations ct ON ct.channel_id = c.id AND ct.language = $2
       WHERE c.id = $1`,
      [req.params.id, appLang || "en"]
    );
    if (channelR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    const ch = channelR.rows[0];

    const membersR = await pool.query(
      `SELECT cm.user_id, cm.role, cm.joined_at,
              u.display_name, u.profile_photo_object_key
       FROM channel_members cm
       JOIN users u ON u.user_id = cm.user_id
       WHERE cm.channel_id = $1
       ORDER BY cm.joined_at`,
      [req.params.id]
    );

    const members = [];
    for (const m of membersR.rows) {
      const photoUrl = m.profile_photo_object_key
        ? await signImageUrl(m.profile_photo_object_key)
        : null;
      members.push({
        user_id: m.user_id,
        display_name: m.display_name,
        role: m.role,
        profile_photo_url: photoUrl,
        joined_at: m.joined_at,
      });
    }

    return res.json({
      ok: true,
      channel: {
        id: ch.id,
        name: ch.translated_name || ch.name,
        description: ch.translated_description || ch.description,
        original_name: ch.name,
        is_archived: ch.is_archived,
        created_at: ch.created_at,
      },
      members,
    });
  } catch (err) {
    logger.error("[collaboration] get channel failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   PUT /v1/channels/:id — Update channel name/description
------------------------------------------------------------------ */

router.put("/v1/channels/:id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    if (!await isChannelAdmin(req.params.id, userId)) {
      return res.status(403).json({ ok: false, error: "NOT_ADMIN" });
    }

    const { name, description } = req.body || {};

    await withTimeout(
      pool.query(
        `UPDATE channels
         SET name = COALESCE($1, name),
             description = COALESCE($2, description),
             updated_at = now()
         WHERE id = $3`,
        [name || null, description !== undefined ? description : null, req.params.id]
      ),
      8000,
      "db-update-channel"
    );

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[collaboration] update channel failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/channels/:id/members — Add members
------------------------------------------------------------------ */

router.post("/v1/channels/:id/members", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    if (!await isMember(req.params.id, userId)) {
      return res.status(403).json({ ok: false, error: "NOT_A_MEMBER" });
    }

    const { user_id: targetUserId } = req.body || {};
    if (!targetUserId) {
      return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });
    }

    await pool.query(
      `INSERT INTO channel_members (channel_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [req.params.id, targetUserId]
    );

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[collaboration] add member failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   DELETE /v1/channels/:id/members/:userId — Remove member
------------------------------------------------------------------ */

router.delete("/v1/channels/:id/members/:userId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    if (!await isChannelAdmin(req.params.id, userId)) {
      return res.status(403).json({ ok: false, error: "NOT_ADMIN" });
    }

    await pool.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[collaboration] remove member failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/channels/:id/messages — Paginated messages
------------------------------------------------------------------ */

router.get("/v1/channels/:id/messages", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    if (!await isMember(req.params.id, userId)) {
      return res.status(403).json({ ok: false, error: "NOT_A_MEMBER" });
    }

    const appLang = await getUserAppLanguage(userId);
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const cursor = req.query.cursor || null; // ISO timestamp

    let query, params;
    if (cursor) {
      query = `SELECT m.id, m.author_user_id, m.original_text, m.original_language,
                      m.translation_status, m.created_at,
                      u.display_name AS author_display_name,
                      u.profile_photo_object_key AS author_photo_key,
                      mt.translated_text
               FROM messages m
               JOIN users u ON u.user_id = m.author_user_id
               LEFT JOIN message_translations mt ON mt.message_id = m.id AND mt.language = $3
               WHERE m.channel_id = $1 AND m.created_at < $4
               ORDER BY m.created_at DESC
               LIMIT $2`;
      params = [req.params.id, limit, appLang || "en", cursor];
    } else {
      query = `SELECT m.id, m.author_user_id, m.original_text, m.original_language,
                      m.translation_status, m.created_at,
                      u.display_name AS author_display_name,
                      u.profile_photo_object_key AS author_photo_key,
                      mt.translated_text
               FROM messages m
               JOIN users u ON u.user_id = m.author_user_id
               LEFT JOIN message_translations mt ON mt.message_id = m.id AND mt.language = $3
               WHERE m.channel_id = $1
               ORDER BY m.created_at DESC
               LIMIT $2`;
      params = [req.params.id, limit, appLang || "en"];
    }

    const r = await withTimeout(pool.query(query, params), 8000, "db-list-messages");

    // Fetch media attachments for all messages in one query
    const messageIds = r.rows.map(row => row.id);
    const mediaByMessageId = {};
    if (messageIds.length > 0) {
      const mediaR = await pool.query(
        `SELECT mm.message_id, med.id AS media_id, med.object_key, med.content_type, med.size_bytes
         FROM message_media mm
         JOIN media med ON med.id = mm.media_id
         WHERE mm.message_id = ANY($1)
         ORDER BY mm.sort_order`,
        [messageIds]
      );
      for (const mrow of mediaR.rows) {
        if (!mediaByMessageId[mrow.message_id]) mediaByMessageId[mrow.message_id] = [];
        const url = mrow.object_key ? await signImageUrl(mrow.object_key) : null;
        mediaByMessageId[mrow.message_id].push({
          media_id: mrow.media_id,
          url,
          content_type: mrow.content_type,
          size_bytes: mrow.size_bytes,
        });
      }
    }

    const messages = [];
    for (const row of r.rows) {
      const authorPhotoUrl = row.author_photo_key
        ? await signImageUrl(row.author_photo_key)
        : null;

      // Determine which text to show and whether this is a translation
      const isOwnMessage = row.author_user_id === userId;
      const isOriginalInUserLang = row.original_language === appLang;

      messages.push({
        id: row.id,
        author: {
          user_id: row.author_user_id,
          display_name: row.author_display_name,
          profile_photo_url: authorPhotoUrl,
        },
        original_text: row.original_text,
        original_language: row.original_language,
        translated_text: row.translated_text || null,
        translated_language: appLang,
        is_translated: !isOriginalInUserLang && row.translated_text != null,
        translation_status: row.translation_status,
        created_at: row.created_at,
        attachments: mediaByMessageId[row.id] || [],
      });
    }

    const nextCursor = messages.length === limit
      ? messages[messages.length - 1].created_at
      : null;

    return res.json({ ok: true, messages, next_cursor: nextCursor });
  } catch (err) {
    logger.error("[collaboration] list messages failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/channels/:id/messages — Post message (translate-on-send)
------------------------------------------------------------------ */

router.post("/v1/channels/:id/messages", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    if (!await isMember(req.params.id, userId)) {
      return res.status(403).json({ ok: false, error: "NOT_A_MEMBER" });
    }

    const { text, source_language } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });
    }

    const appLang = await getUserAppLanguage(userId);
    if (!appLang) {
      return res.status(400).json({ ok: false, error: "APP_LANGUAGE_NOT_SET" });
    }

    // Detect source language
    const detectedLang = source_language || await withTimeout(
      detectLanguage(text.trim()),
      TRANSLATE_TIMEOUT_MS,
      "detect-lang-msg"
    );

    // Insert message
    const msgR = await withTimeout(
      pool.query(
        `INSERT INTO messages (channel_id, author_user_id, original_text, original_language)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [req.params.id, userId, text.trim(), detectedLang]
      ),
      8000,
      "db-insert-message"
    );
    const msg = msgR.rows[0];

    // Store the original text as a "translation" in its own language
    await pool.query(
      `INSERT INTO message_translations (message_id, language, translated_text)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [msg.id, detectedLang, text.trim()]
    );

    // Translate to all unique member languages (except source)
    const targetLangs = await getChannelMemberLanguages(req.params.id, detectedLang);
    let translationStatus = "complete";

    for (const targetLang of targetLangs) {
      try {
        const translated = await withTimeout(
          translateText(text.trim(), appLang, detectedLang, targetLang),
          TRANSLATE_TIMEOUT_MS,
          `translate-msg-${targetLang}`
        );
        await pool.query(
          `INSERT INTO message_translations (message_id, language, translated_text)
           VALUES ($1, $2, $3)
           ON CONFLICT (message_id, language) DO UPDATE SET translated_text = $3`,
          [msg.id, targetLang, translated]
        );
      } catch (translationErr) {
        logger.warn("[collaboration] message translation failed", {
          messageId: msg.id,
          targetLang,
          err: String(translationErr?.message),
        });
        translationStatus = "failed";
      }
    }

    // Update translation status
    await pool.query(
      `UPDATE messages SET translation_status = $1 WHERE id = $2`,
      [translationStatus, msg.id]
    );

    // Touch channel updated_at
    await pool.query(
      `UPDATE channels SET updated_at = now() WHERE id = $1`,
      [req.params.id]
    );

    // Return the message with the caller's translation
    const callerTranslation = appLang !== detectedLang
      ? (await pool.query(
          `SELECT translated_text FROM message_translations WHERE message_id = $1 AND language = $2`,
          [msg.id, appLang]
        )).rows[0]?.translated_text || null
      : null;

    return res.status(201).json({
      ok: true,
      message: {
        id: msg.id,
        author: { user_id: userId },
        original_text: text.trim(),
        original_language: detectedLang,
        translated_text: callerTranslation,
        translated_language: appLang,
        is_translated: callerTranslation != null,
        translation_status: translationStatus,
        created_at: msg.created_at,
      },
    });
  } catch (err) {
    logger.error("[collaboration] post message failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   DELETE /v1/channels/:id/messages/:msgId — Delete own message only
------------------------------------------------------------------ */

router.delete("/v1/channels/:id/messages/:msgId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await pool.query(
      `DELETE FROM messages WHERE id = $1 AND channel_id = $2 AND author_user_id = $3
       RETURNING id`,
      [req.params.msgId, req.params.id, userId]
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND_OR_NOT_AUTHOR" });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[collaboration] delete message failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/channels/:id/messages/:msgId/media — Attach media to message
------------------------------------------------------------------ */

router.post("/v1/channels/:id/messages/:msgId/media", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    // Verify message ownership
    const msgR = await pool.query(
      `SELECT id FROM messages WHERE id = $1 AND channel_id = $2 AND author_user_id = $3`,
      [req.params.msgId, req.params.id, userId]
    );
    if (msgR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND_OR_NOT_AUTHOR" });
    }

    const { media_id } = req.body || {};
    if (!media_id) {
      return res.status(400).json({ ok: false, error: "MEDIA_ID_REQUIRED" });
    }

    // Verify media ownership
    const mediaR = await pool.query(
      `SELECT id FROM media WHERE id = $1 AND owner_user_id = $2`,
      [media_id, userId]
    );
    if (mediaR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "MEDIA_NOT_FOUND" });
    }

    const orderR = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM message_media WHERE message_id = $1`,
      [req.params.msgId]
    );

    await pool.query(
      `INSERT INTO message_media (message_id, media_id, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.msgId, media_id, orderR.rows[0].next_order]
    );

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[collaboration] attach media failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
