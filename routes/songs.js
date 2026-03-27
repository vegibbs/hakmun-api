// routes/songs.js — HakMun API
// Song lyrics translation and audio alignment via OpenAI.
// ENDPOINTS:
//   POST /v1/songs/translate-lyrics
//   POST /v1/songs/align-lyrics

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { requireSession } = require("../auth/session");
const { translateSongLyrics, alignLyricsToAudio } = require("../util/openai");
const { logger } = require("../util/log");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

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

// ---------------------------------------------------------------------------
// POST /v1/songs/align-lyrics
//
// Multipart form: audio file + lines JSON.
// Uses OpenAI Whisper to align audio to Korean lyrics.
//
// Input:  audio (file), lines (JSON string: ["한글 가사", "", "다음 줄", ...])
// Output: { ok: true, timings: [{ index, startMs, endMs }, ...] }
// ---------------------------------------------------------------------------
router.post("/v1/songs/align-lyrics", requireSession, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No audio file provided" });
    }

    let lines;
    try {
      lines = JSON.parse(req.body.lines || "[]");
    } catch {
      return res.status(400).json({ ok: false, error: "lines must be a valid JSON array of strings" });
    }

    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ ok: false, error: "lines must be a non-empty array of strings" });
    }

    if (lines.length > 200) {
      return res.status(400).json({ ok: false, error: "Too many lines (max 200)" });
    }

    const sanitized = lines.map(l => (typeof l === "string" ? l : ""));

    logger.info("align-lyrics start", {
      fileSize: req.file.size,
      lineCount: sanitized.length,
      filename: req.file.originalname
    });

    const result = await alignLyricsToAudio(
      req.file.buffer,
      req.file.originalname,
      sanitized,
      120_000
    );

    return res.json({ ok: true, timings: result.timings });
  } catch (err) {
    logger.error("align-lyrics failed", { error: err.message });

    if (err.message && err.message.includes("openai_timeout")) {
      return res.status(504).json({ ok: false, error: "Alignment timed out. Try again." });
    }

    return res.status(500).json({ ok: false, error: "Alignment failed. Please try again." });
  }
});

module.exports = router;
