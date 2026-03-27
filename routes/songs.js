// routes/songs.js — HakMun API
// Song lyrics translation via OpenAI.
// ENDPOINT: POST /v1/songs/translate-lyrics

const express = require("express");
const router = express.Router();
const { requireSession } = require("../auth/session");
const { translateSongLyrics } = require("../util/openai");
const { logger } = require("../util/log");

// ---------------------------------------------------------------------------
// POST /v1/songs/translate-lyrics
//
// Input:  { lines: ["한글 가사 첫 줄", "", "다음 절 가사", ...] }
//         Empty strings represent stanza breaks.
//
// Output: { ok: true, lines: [{ ko, literal, natural }, ...] }
// ---------------------------------------------------------------------------
router.post("/v1/songs/translate-lyrics", requireSession, async (req, res) => {
  try {
    const { lines } = req.body;

    if (!Array.isArray(lines)) {
      return res.status(400).json({ ok: false, error: "lines must be an array of strings" });
    }

    if (lines.length === 0) {
      return res.json({ ok: true, lines: [] });
    }

    if (lines.length > 200) {
      return res.status(400).json({ ok: false, error: "Too many lines (max 200)" });
    }

    // Ensure all elements are strings
    const sanitized = lines.map(l => (typeof l === "string" ? l : ""));

    const result = await translateSongLyrics(sanitized, 90_000);

    return res.json({ ok: true, lines: result.lines });
  } catch (err) {
    logger.error("translate-lyrics failed", { error: err.message });

    if (err.message && err.message.startsWith("openai_timeout")) {
      return res.status(504).json({ ok: false, error: "Translation timed out. Try with fewer lines." });
    }

    return res.status(500).json({ ok: false, error: "Translation failed. Please try again." });
  }
});

module.exports = router;
