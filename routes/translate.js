// routes/translate.js — Shared translation service
// Used by bug reports and collaboration messages.

const express = require("express");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");

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

/** Fetch the user's primary_language from the DB (= app_language). */
async function getUserAppLanguage(userId) {
  const r = await pool.query(
    `SELECT primary_language FROM users WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0]?.primary_language || null;
}

/* ------------------------------------------------------------------
   Prompt templates
------------------------------------------------------------------ */

const LANG_NAMES = {
  en: "English", ko: "Korean", fr: "French", es: "Spanish",
  ja: "Japanese", zh: "Chinese", de: "German", pt: "Portuguese",
};

function langName(code) {
  return LANG_NAMES[code] || code;
}

function buildBugReportPrompt(appLanguage, detectedSource, targetLanguage) {
  const mismatchBlock =
    appLanguage && appLanguage !== detectedSource
      ? `- Because they are writing in a non-native language, their phrasing may
  reflect ${langName(appLanguage)} patterns — word order, dropped articles,
  translated idioms, or terms borrowed from ${langName(appLanguage)} where they
  lack the ${langName(detectedSource)} equivalent. Interpret generously
  and produce a clear, natural translation in ${langName(targetLanguage)} that
  captures their intended meaning, not a literal mapping of their words.`
      : "";

  return `You are translating a bug report or feature request for HakMun, a Korean
language learning app.

About the author:
- Their primary (native) language is ${langName(appLanguage)}.
- They are writing this report in ${langName(detectedSource)}.
${mismatchBlock}

Rules:
- Preserve Korean example text (words, sentences, grammar patterns)
  exactly as-is when they appear as examples of what the user was
  practicing or what appeared on screen. These are learning content,
  not text to translate.
- App feature names (Notebook, Writing Practice, Hanja, Content Items,
  etc.) should remain in English — these are UI labels.
- Technical terms (crash, freeze, button, scroll) should be translated
  naturally into ${langName(targetLanguage)}.
- If the author mixes languages mid-sentence (common for bilingual users
  in a language learning context), sort out which parts are description
  vs. example and translate only the description.
- Return ONLY the translation. No explanations, no notes, no formatting.`;
}

function buildCollaborationPrompt(appLanguage, detectedSource, targetLanguage) {
  const mismatchBlock =
    appLanguage && appLanguage !== detectedSource
      ? `- They are writing in a non-native language. Their phrasing may reflect
  ${langName(appLanguage)} thinking patterns. Produce a clear, natural
  translation in ${langName(targetLanguage)} that conveys their intent accurately.`
      : "";

  return `You are translating a team message in HakMun, a Korean language learning
app used by teachers and developers.

About the author:
- Their primary (native) language is ${langName(appLanguage)}.
- They are writing this message in ${langName(detectedSource)}.
${mismatchBlock}

Rules:
- Messages may discuss Korean language teaching concepts, app features,
  curriculum design, or student progress.
- Preserve Korean linguistic examples (words, grammar patterns, sentences
  being discussed as learning content) exactly as-is.
- Translate the discussion around them into ${langName(targetLanguage)}.
- Keep the tone conversational and natural — this is team chat, not
  formal documentation.
- If the author mixes languages (very common in this context), determine
  from context which parts are being discussed as Korean language content
  vs. which parts are the author's own commentary, and translate only
  the commentary.
- Return ONLY the translation. No explanations, no notes, no formatting.`;
}

function buildGeneralPrompt(detectedSource, targetLanguage) {
  return `Translate the following text from ${langName(detectedSource)} to ${langName(targetLanguage)}.
Return ONLY the translation. No explanations, no notes, no formatting.`;
}

function buildSystemPrompt(context, appLanguage, detectedSource, targetLanguage) {
  switch (context) {
    case "bug_report":
      return buildBugReportPrompt(appLanguage, detectedSource, targetLanguage);
    case "collaboration":
      return buildCollaborationPrompt(appLanguage, detectedSource, targetLanguage);
    default:
      return buildGeneralPrompt(detectedSource, targetLanguage);
  }
}

/* ------------------------------------------------------------------
   OpenAI call
------------------------------------------------------------------ */

async function translateText(text, systemPrompt) {
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
  if (!resp.ok) {
    const msg = JSON.stringify(json).slice(0, 500);
    throw new Error(`openai_translate_${resp.status}: ${msg}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("openai_translate_no_content");
  }
  return content.trim();
}

/* ------------------------------------------------------------------
   Detect source language (ask the model)
------------------------------------------------------------------ */

async function detectLanguage(text) {
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
        {
          role: "system",
          content:
            "Detect the primary language of the following text. Return ONLY a two-letter ISO 639-1 language code (e.g. en, ko, fr, es, ja, zh, de, pt). Nothing else.",
        },
        { role: "user", content: text },
      ],
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) return "en"; // fallback

  const code = (json?.choices?.[0]?.message?.content || "en").trim().toLowerCase().slice(0, 2);
  return code;
}

/* ------------------------------------------------------------------
   POST /v1/translate
------------------------------------------------------------------ */

router.post("/v1/translate", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { text, source_language, target_languages, context } = req.body || {};

    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });
    }
    if (!Array.isArray(target_languages) || target_languages.length === 0) {
      return res.status(400).json({ ok: false, error: "TARGET_LANGUAGES_REQUIRED" });
    }
    if (target_languages.length > 5) {
      return res.status(400).json({ ok: false, error: "TOO_MANY_TARGETS" });
    }

    // Fetch user's app_language (primary_language) from profile
    const appLanguage = await withTimeout(getUserAppLanguage(userId), 5000, "db-get-app-lang");
    if (!appLanguage) {
      return res.status(400).json({ ok: false, error: "APP_LANGUAGE_NOT_SET" });
    }

    // Detect or use provided source language
    const detectedSource = source_language || await withTimeout(
      detectLanguage(text.trim()),
      TRANSLATE_TIMEOUT_MS,
      "detect-lang"
    );

    // Translate into each requested target language
    const ctx = context || "general";
    const translations = {};

    await Promise.all(
      target_languages.map(async (targetLang) => {
        // Skip if target === source (no translation needed)
        if (targetLang === detectedSource) {
          translations[targetLang] = text.trim();
          return;
        }
        const systemPrompt = buildSystemPrompt(ctx, appLanguage, detectedSource, targetLang);
        translations[targetLang] = await withTimeout(
          translateText(text.trim(), systemPrompt),
          TRANSLATE_TIMEOUT_MS,
          `translate-${targetLang}`
        );
      })
    );

    return res.json({
      ok: true,
      source_language: detectedSource,
      translations,
    });
  } catch (err) {
    logger.error("[translate] failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "TRANSLATE_FAILED" });
  }
});

module.exports = router;
