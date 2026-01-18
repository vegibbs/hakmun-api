// routes/generate.js — HakMun API (v0.12)
// Sentence generation (optional)

const express = require("express");

const router = express.Router();

// POST /v1/generate/sentences
router.post("/v1/generate/sentences", (req, res) => {
  return res.status(501).json({ error: "not enabled in this build" });
});

module.exports = router;