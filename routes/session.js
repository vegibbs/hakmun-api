// routes/session.js — HakMun API (v0.12)
// Session refresh + whoami

const express = require("express");

const { logger } = require("../util/log");
const { requireSession, verifySessionJWT, issueSessionTokens, getUserState } = require("../auth/session");

const router = express.Router();

function requireJsonField(req, res, fieldName) {
  const v = req.body?.[fieldName];
  if (!v || String(v).trim() === "") {
    res.status(400).json({ error: `${fieldName} is required` });
    return null;
  }
  return String(v);
}

/* ------------------------------------------------------------------
   POST /v1/session/refresh
------------------------------------------------------------------ */
router.post("/v1/session/refresh", async (req, res) => {
  try {
    const refreshToken = requireJsonField(req, res, "refreshToken");
    if (!refreshToken) return;

    const decoded = await verifySessionJWT(refreshToken);
    if (decoded.typ !== "refresh") {
      return res.status(401).json({ error: "refresh token required" });
    }

    const state = await getUserState(decoded.userID);
    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    const tokens = await issueSessionTokens({ userID: decoded.userID });
    return res.json(tokens);
  } catch (err) {
    // Keep exact alert match strings from the epic.
    logger.warn("/v1/session/refresh failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(401).json({ error: "refresh failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/session/whoami
------------------------------------------------------------------ */
async function getPrimaryHandleForUser(userID, pool) {
  const { rows } = await pool.query(
    `
    select handle
    from user_handles
    where user_id = $1 and kind = 'primary'
    limit 1
    `,
    [userID]
  );
  return rows?.[0]?.handle || null;
}

const { pool } = require("../db/pool");
const { ensureAtLeastOneRootAdminNonFatal } = require("../auth/session");

router.get("/v1/session/whoami", requireSession, async (req, res) => {
  try {
    await ensureAtLeastOneRootAdminNonFatal("whoami");

    const primaryHandle = await getPrimaryHandleForUser(req.user.userID, pool);
    const profileComplete = Boolean(primaryHandle && String(primaryHandle).trim());

    // Load per-user feature flags
    const { rows: flagRows } = await pool.query(
      `SELECT flag_key, enabled FROM user_feature_flags WHERE user_id = $1`,
      [req.user.userID]
    );
    const featureFlags = {};
    for (const row of flagRows) {
      featureFlags[row.flag_key] = row.enabled;
    }

    return res.json({
      userID: req.user.userID,
      role: req.user.role,
      isTeacher: Boolean(req.user.isTeacher),
      isAdmin: Boolean(req.user.isAdmin),
      isRootAdmin: Boolean(req.user.isRootAdmin),
      isActive: Boolean(req.user.isActive),

      // Server-authoritative capabilities
      entitlements: req.user.entitlements || [],
      capabilities: req.user.capabilities || {},

      // Per-user feature flags (admin-controlled)
      featureFlags,

      // Canonical profile facts
      profileComplete,
      primaryHandle,
      username: primaryHandle,
      displayName: req.user.displayName || null,

      // Preferences
      primaryLanguage: req.user.primaryLanguage,
      glossLanguage: req.user.glossLanguage,
      customizeLearning: req.user.customizeLearning,
      shareProgressDefault: req.user.shareProgressDefault,
      allowTeacherAdjustDefault: req.user.allowTeacherAdjustDefault,
      locationCity: req.user.locationCity,
      locationCountry: req.user.locationCountry,
      locationLat: req.user.locationLat,
      locationLon: req.user.locationLon,
      shareCity: req.user.shareCity,
      shareCountry: req.user.shareCountry,
      cefrCurrent: req.user.cefrCurrent,
      cefrTarget: req.user.cefrTarget
    });
  } catch (err) {
    logger.error("/v1/session/whoami failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "whoami failed" });
  }
});

module.exports = router;