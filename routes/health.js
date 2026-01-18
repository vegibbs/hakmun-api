// routes/health.js — HakMun API (v0.12)
// Health check

const express = require("express");

const router = express.Router();

// GET /
router.get("/", (req, res) => res.send("hakmun-api up"));

module.exports = router;