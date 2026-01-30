// FILE: hakmun-api/routes/dictionary_pins_delete.js
// PURPOSE: DV2 – My Dictionary pins (DELETE / unpin)
// ENDPOINT: DELETE /v1/me/dictionary/pins
//
// Body: { headword: string }
// Behavior: deletes the pin for the authenticated user (idempotent).
// Returns: { ok: true, deleted: <count> }

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

// DELETE /v1/me/dictionary/pins
router.delete("/v1/me/dictionary/pins", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: "NO_SESSION" });
    }

    const headword = typeof req.body?.headword === "string" ? req.body.headword.trim() : "";
    if (!headword) {
      return res.status(400).json({ ok: false, error: "HEADWORD_REQUIRED" });
    }

    const sql = `
      DELETE FROM user_dictionary_pins
      WHERE user_id = $1::uuid
        AND headword = $2::text
    `;

    const result = await dbQuery(sql, [userId, headword]);
    const deleted = typeof result?.rowCount === "number" ? result.rowCount : 0;

    // Idempotent: always ok:true even if nothing deleted
    return res.json({ ok: true, deleted });
  } catch (err) {
    console.error("dictionary pins DELETE failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;