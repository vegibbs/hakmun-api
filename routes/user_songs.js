// routes/user_songs.js — HakMun API
// Per-user song storage (lyrics, timings, metadata).
// ENDPOINTS:
//   GET    /v1/me/songs        — list user's songs (metadata only)
//   GET    /v1/me/songs/:id    — get song with full lyrics/timings
//   POST   /v1/me/songs        — create or upsert song (by apple_music_id)
//   PUT    /v1/me/songs/:id    — update song
//   DELETE /v1/me/songs/:id    — delete song

const express = require("express");
const router = express.Router();
const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");

// ---------------------------------------------------------------------------
// GET /v1/me/songs — list (metadata only, no lines)
// ---------------------------------------------------------------------------
router.get("/v1/me/songs", requireSession, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, artist_name, album_title, apple_music_id, is_manual,
              created_at, updated_at
         FROM user_songs
        WHERE owner_user_id = $1
        ORDER BY updated_at DESC`,
      [req.user.userID]
    );
    res.json({ ok: true, songs: rows });
  } catch (err) {
    logger.error("[user_songs] list failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Failed to list songs." });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/me/songs/:id — full song with lines
// ---------------------------------------------------------------------------
router.get("/v1/me/songs/:id", requireSession, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, artist_name, album_title, apple_music_id, is_manual,
              lines, created_at, updated_at
         FROM user_songs
        WHERE id = $1 AND owner_user_id = $2`,
      [req.params.id, req.user.userID]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Song not found." });
    }
    res.json({ ok: true, song: rows[0] });
  } catch (err) {
    logger.error("[user_songs] get failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Failed to get song." });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/me/songs — create (or upsert on apple_music_id)
// ---------------------------------------------------------------------------
router.post("/v1/me/songs", requireSession, async (req, res) => {
  const { title, artist_name, album_title, apple_music_id, is_manual, lines } = req.body;

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ ok: false, error: "title is required." });
  }
  if (!artist_name || typeof artist_name !== "string" || !artist_name.trim()) {
    return res.status(400).json({ ok: false, error: "artist_name is required." });
  }
  if (lines !== undefined && lines !== null && !Array.isArray(lines)) {
    return res.status(400).json({ ok: false, error: "lines must be an array." });
  }

  try {
    // If apple_music_id is provided, upsert on (owner_user_id, apple_music_id)
    if (apple_music_id) {
      const { rows } = await pool.query(
        `INSERT INTO user_songs (owner_user_id, title, artist_name, album_title,
                                 apple_music_id, is_manual, lines)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (owner_user_id, apple_music_id)
            WHERE apple_music_id IS NOT NULL
         DO UPDATE SET title = EXCLUDED.title,
                       artist_name = EXCLUDED.artist_name,
                       album_title = EXCLUDED.album_title,
                       is_manual = EXCLUDED.is_manual,
                       lines = EXCLUDED.lines,
                       updated_at = NOW()
         RETURNING id, title, artist_name, album_title, apple_music_id, is_manual,
                   lines, created_at, updated_at`,
        [
          req.user.userID,
          title.trim(),
          artist_name.trim(),
          album_title?.trim() || null,
          apple_music_id.trim(),
          is_manual ?? false,
          lines ? JSON.stringify(lines) : null
        ]
      );
      return res.status(201).json({ ok: true, song: rows[0] });
    }

    // No apple_music_id — plain insert (manual song)
    const { rows } = await pool.query(
      `INSERT INTO user_songs (owner_user_id, title, artist_name, album_title,
                               is_manual, lines)
            VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, artist_name, album_title, apple_music_id, is_manual,
                 lines, created_at, updated_at`,
      [
        req.user.userID,
        title.trim(),
        artist_name.trim(),
        album_title?.trim() || null,
        is_manual ?? true,
        lines ? JSON.stringify(lines) : null
      ]
    );
    res.status(201).json({ ok: true, song: rows[0] });
  } catch (err) {
    logger.error("[user_songs] create failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Failed to save song." });
  }
});

// ---------------------------------------------------------------------------
// PUT /v1/me/songs/:id — update song
// ---------------------------------------------------------------------------
router.put("/v1/me/songs/:id", requireSession, async (req, res) => {
  const { title, artist_name, album_title, apple_music_id, is_manual, lines } = req.body;

  if (lines !== undefined && lines !== null && !Array.isArray(lines)) {
    return res.status(400).json({ ok: false, error: "lines must be an array." });
  }

  // Build SET clause dynamically from provided fields
  const sets = [];
  const vals = [];
  let idx = 1;

  if (title !== undefined) { sets.push(`title = $${idx++}`); vals.push(title.trim()); }
  if (artist_name !== undefined) { sets.push(`artist_name = $${idx++}`); vals.push(artist_name.trim()); }
  if (album_title !== undefined) { sets.push(`album_title = $${idx++}`); vals.push(album_title?.trim() || null); }
  if (apple_music_id !== undefined) { sets.push(`apple_music_id = $${idx++}`); vals.push(apple_music_id?.trim() || null); }
  if (is_manual !== undefined) { sets.push(`is_manual = $${idx++}`); vals.push(is_manual); }
  if (lines !== undefined) { sets.push(`lines = $${idx++}`); vals.push(lines ? JSON.stringify(lines) : null); }

  if (sets.length === 0) {
    return res.status(400).json({ ok: false, error: "No fields to update." });
  }

  sets.push(`updated_at = NOW()`);
  vals.push(req.params.id, req.user.userID);

  try {
    const { rows } = await pool.query(
      `UPDATE user_songs
          SET ${sets.join(", ")}
        WHERE id = $${idx++} AND owner_user_id = $${idx}
       RETURNING id, title, artist_name, album_title, apple_music_id, is_manual,
                 lines, created_at, updated_at`,
      vals
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Song not found." });
    }
    res.json({ ok: true, song: rows[0] });
  } catch (err) {
    logger.error("[user_songs] update failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Failed to update song." });
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/me/songs/:id
// ---------------------------------------------------------------------------
router.delete("/v1/me/songs/:id", requireSession, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM user_songs WHERE id = $1 AND owner_user_id = $2`,
      [req.params.id, req.user.userID]
    );
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Song not found." });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error("[user_songs] delete failed", { error: err.message });
    res.status(500).json({ ok: false, error: "Failed to delete song." });
  }
});

module.exports = router;
