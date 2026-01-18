// routes/dev.js — HakMun API (v0.12)
// DEV — Smoke Token (backend-only)

const express = require("express");
const crypto = require("crypto");

const { logger } = require("../util/log");
const { getUserState, issueSessionTokens } = require("../auth/session");

const router = express.Router();

/* ------------------------------------------------------------------
   DEV — Smoke Token
   - Disabled unless ENABLE_SMOKE_TOKEN=1
   - Requires X-Smoke-Secret header
   - NEVER logs tokens
------------------------------------------------------------------ */

function smokeTokenEnabled() {
  return String(process.env.ENABLE_SMOKE_TOKEN || "").trim() === "1";
}

function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

function requireSmokeSecret(req) {
  const expected = String(process.env.SMOKE_TEST_SECRET || "").trim();
  if (!expected) return false;
  const got = String(req.headers["x-smoke-secret"] || "").trim();
  if (!got) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

// POST /v1/dev/smoke-token
router.post("/v1/dev/smoke-token", async (req, res) => {
  try {
    if (!smokeTokenEnabled()) return res.status(404).json({ error: "not found" });
    if (!requireSmokeSecret(req)) return res.status(401).json({ error: "unauthorized" });

    const userID = String(process.env.SMOKE_TEST_USER_ID || "").trim();
    if (!userID || !looksLikeUUID(userID)) {
      return res.status(500).json({ error: "smoke user not configured" });
    }

    const state = await getUserState(userID);
    if (!Boolean(state.is_active)) return res.status(403).json({ error: "smoke user inactive" });

    const tokens = await issueSessionTokens({ userID });
    return res.json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
  } catch (err) {
    logger.error("[/v1/dev/smoke-token] failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "smoke token failed" });
  }
});

module.exports = router;