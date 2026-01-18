// routes/handles.js — HakMun API (v0.12)
// GET /v1/handles/me

const express = require("express");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { requireSession } = require("../auth/session");

const router = express.Router();

// GET /v1/handles/me
router.get("/v1/handles/me", requireSession, async (req, res) => {
  const { userID } = req.user;

  try {
    const { rows } = await pool.query(
      `
      select handle
      from user_handles
      where user_id = $1 and kind = 'primary'
      limit 1
      `,
      [userID]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "no username set" });
    }

    return res.json(rows[0]);
  } catch (err) {
    logger.error("handles/me failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "resolve failed" });
  }
});

module.exports = router;