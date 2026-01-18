// routes/library/index.js — HakMun API (v0.12)
// Library router entrypoint: mounts sub-routers (no logic)

const express = require("express");

const router = express.Router();

// List/read surfaces
router.use(require("./listing"));
router.use(require("./item_status"));

// Share grants
router.use(require("./share"));

// Moderation actions
router.use(require("./moderation"));

module.exports = router;