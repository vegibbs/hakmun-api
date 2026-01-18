// routes/library/moderation/index.js — HakMun API (v0.12)
// Moderation router entrypoint: mounts per-endpoint handlers (no logic)

const express = require("express");

const router = express.Router();

router.use(require("./needs_review"));
router.use(require("./restore"));
router.use(require("./approve"));
router.use(require("./reject"));
router.use(require("./keep_under_review"));

module.exports = router;