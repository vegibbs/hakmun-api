// routes/auth_apple.js — HakMun API (v0.12)
// POST /v1/auth/apple

const express = require("express");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const { verifyAppleToken, verifyAppleCode } = require("../auth/apple");
const { ensureCanonicalUser } = require("../auth/identity");
const { issueSessionTokens, getUserState, requireSession } = require("../auth/session");
const { audit } = require("../util/audit");

const router = express.Router();

/* ------------------------------------------------------------------
   Helpers (kept local; no behavior changes)
------------------------------------------------------------------ */
function requireJsonField(req, res, fieldName) {
  const v = req.body?.[fieldName];
  if (!v || String(v).trim() === "") {
    res.status(400).json({ error: `${fieldName} is required` });
    return null;
  }
  return String(v);
}

/* ------------------------------------------------------------------
   POST /v1/auth/apple
------------------------------------------------------------------ */
router.post("/v1/auth/apple", async (req, res) => {
  logger.info("[/v1/auth/apple] START", { rid: req._rid });
  res.set("X-HakMun-AuthApple", "v0.13");

  try {
    // Two flows:
    //   Native: { identityToken } — client sends Apple identity JWT directly
    //   Web:    { code, redirectUri } — client sends authorization code from Apple OAuth redirect
    const identityToken = req.body?.identityToken;
    const code = req.body?.code;

    let appleSubject, audience, email;

    if (code) {
      // Web flow: exchange authorization code with Apple
      const redirectUri = req.body?.redirectUri;
      if (!redirectUri || String(redirectUri).trim() === "") {
        return res.status(400).json({ error: "redirectUri is required for web sign-in" });
      }
      ({ appleSubject, audience, email } = await verifyAppleCode(String(code), String(redirectUri)));
      logger.info("[/v1/auth/apple] web flow verified", { rid: req._rid, audience, hasEmail: Boolean(email) });
    } else if (identityToken) {
      // Native flow: verify identity token directly
      ({ appleSubject, audience, email } = await verifyAppleToken(String(identityToken)));
      logger.info("[/v1/auth/apple] native flow verified", { rid: req._rid, audience, hasEmail: Boolean(email) });
    } else {
      return res.status(400).json({ error: "identityToken or code is required" });
    }

    const userID = await withTimeout(
      ensureCanonicalUser({ provider: "apple", subject: appleSubject, audience, email }, req._rid),
      6000,
      "ensureCanonicalUser"
    );
    logger.info("[/v1/auth/apple] canonical", { rid: req._rid, userID });

    const state = await withTimeout(getUserState(userID), 6000, "getUserState");
    logger.info("[/v1/auth/apple] state", { rid: req._rid, active: Boolean(state.is_active) });

    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    const tokens = await withTimeout(issueSessionTokens({ userID }), 3000, "issueSessionTokens");
    logger.info("[/v1/auth/apple] issued tokens", { rid: req._rid });

    // Check for linked profiles
    let profiles = null;
    try {
      const { rows: linkedRows } = await pool.query(
        `SELECT lp.user_id, lp.label, u.role, u.is_active,
                uh.handle AS primary_handle
         FROM linked_profiles lp
         JOIN users u ON u.user_id = lp.user_id
         LEFT JOIN user_handles uh ON uh.user_id = lp.user_id AND uh.kind = 'primary'
         WHERE lp.apple_sub = $1`,
        [appleSubject]
      );

      if (linkedRows.length > 0) {
        // Include primary account + linked profiles
        const { rows: primaryHandle } = await pool.query(
          `SELECT handle FROM user_handles WHERE user_id = $1 AND kind = 'primary' LIMIT 1`,
          [userID]
        );

        profiles = [
          {
            userID,
            primaryHandle: primaryHandle?.[0]?.handle || null,
            role: state.role,
            label: null,
            isActive: Boolean(state.is_active),
            isPrimary: true
          },
          ...linkedRows
            .filter((r) => r.user_id !== userID)
            .map((r) => ({
              userID: r.user_id,
              primaryHandle: r.primary_handle,
              role: r.role,
              label: r.label,
              isActive: Boolean(r.is_active),
              isPrimary: false
            }))
        ];
      }
    } catch (err) {
      logger.warn("[/v1/auth/apple] profiles lookup failed (non-fatal)", {
        rid: req._rid,
        err: err?.message || String(err)
      });
    }

    const response = {
      ...tokens,
      user: {
        userID,
        role: state.role,
        isTeacher: String(state.role || "student") === "teacher",
        isAdmin: Boolean(state.is_admin),
        isRootAdmin: Boolean(state.is_root_admin),
        isActive: Boolean(state.is_active)
      }
    };

    if (profiles) response.profiles = profiles;

    audit(req, 'user.signin', 'user', userID, { audience }, userID).catch(() => {});
    return res.json(response);
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("/v1/auth/apple failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:apple-jwtVerify") || msg.startsWith("timeout:apple-web-jwtVerify")) {
      return res.status(503).json({ error: "apple verification timeout" });
    }
    if (msg.startsWith("timeout:apple-token-exchange")) {
      return res.status(503).json({ error: "apple token exchange timeout" });
    }
    if (msg.startsWith("timeout:ensureCanonicalUser")) {
      return res.status(503).json({ error: "db timeout: ensureCanonicalUser" });
    }
    if (msg.startsWith("timeout:getUserState")) {
      return res.status(503).json({ error: "db timeout: getUserState" });
    }
    if (msg.startsWith("timeout:issueSessionTokens")) {
      return res.status(503).json({ error: "timeout: token issuance" });
    }

    return res.status(401).json({ error: "authentication failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/auth/switch-profile
------------------------------------------------------------------ */
function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

router.post("/v1/auth/switch-profile", requireSession, async (req, res) => {
  try {
    const targetUserID = String(req.body?.targetUserID || "").trim();
    if (!targetUserID || !looksLikeUUID(targetUserID)) {
      return res.status(400).json({ error: "invalid targetUserID" });
    }

    const currentUserID = req.user.userID;

    // Find the apple_sub for the current user.
    // Could be the primary (in auth_identities) or a linked profile.
    let appleSub = null;

    const { rows: aiRows } = await pool.query(
      `SELECT subject FROM auth_identities WHERE user_id = $1 AND provider = 'apple' LIMIT 1`,
      [currentUserID]
    );
    if (aiRows?.length) {
      appleSub = aiRows[0].subject;
    } else {
      const { rows: lpRows } = await pool.query(
        `SELECT apple_sub FROM linked_profiles WHERE user_id = $1 LIMIT 1`,
        [currentUserID]
      );
      if (lpRows?.length) appleSub = lpRows[0].apple_sub;
    }

    if (!appleSub) {
      return res.status(403).json({ error: "no Apple identity found" });
    }

    // Validate target is accessible: either primary account or linked profile for same apple_sub.
    const { rows: primaryCheck } = await pool.query(
      `SELECT user_id FROM auth_identities WHERE provider = 'apple' AND subject = $1 AND user_id = $2 LIMIT 1`,
      [appleSub, targetUserID]
    );
    const isPrimary = primaryCheck?.length > 0;

    if (!isPrimary) {
      const { rows: linkedCheck } = await pool.query(
        `SELECT user_id FROM linked_profiles WHERE apple_sub = $1 AND user_id = $2 LIMIT 1`,
        [appleSub, targetUserID]
      );
      if (!linkedCheck?.length) {
        return res.status(403).json({ error: "target profile not linked to your identity" });
      }
    }

    // Target must be active.
    const state = await getUserState(targetUserID);
    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "target account disabled" });
    }

    // Issue full normal session tokens for the target.
    const tokens = await issueSessionTokens({ userID: targetUserID });

    logger.info("[auth] profile switch", {
      rid: req._rid,
      fromUserID: currentUserID,
      toUserID: targetUserID
    });

    return res.json({
      ...tokens,
      user: {
        userID: targetUserID,
        role: state.role,
        isTeacher: String(state.role || "student") === "teacher",
        isAdmin: Boolean(state.is_admin),
        isRootAdmin: Boolean(state.is_root_admin),
        isActive: Boolean(state.is_active)
      }
    });
  } catch (err) {
    logger.error("/v1/auth/switch-profile failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "profile switch failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/auth/profiles
   Returns all linked profiles for the current user's Apple sub.
   Any authenticated user can call this (not admin-only).
------------------------------------------------------------------ */
router.get("/v1/auth/profiles", requireSession, async (req, res) => {
  try {
    const currentUserID = req.user.userID;

    // Resolve apple_sub (same logic as switch-profile).
    let appleSub = null;

    const { rows: aiRows } = await pool.query(
      `SELECT subject FROM auth_identities WHERE user_id = $1 AND provider = 'apple' LIMIT 1`,
      [currentUserID]
    );
    if (aiRows?.length) {
      appleSub = aiRows[0].subject;
    } else {
      const { rows: lpRows } = await pool.query(
        `SELECT apple_sub FROM linked_profiles WHERE user_id = $1 LIMIT 1`,
        [currentUserID]
      );
      if (lpRows?.length) appleSub = lpRows[0].apple_sub;
    }

    if (!appleSub) {
      // No linked profiles — just return empty array.
      return res.json({ profiles: [] });
    }

    // Primary account(s) from auth_identities.
    const { rows: primaryRows } = await pool.query(
      `SELECT DISTINCT ON (ai.user_id) ai.user_id, u.role, u.is_active, uh.handle AS primary_handle
       FROM auth_identities ai
       JOIN users u ON u.user_id = ai.user_id
       LEFT JOIN user_handles uh ON uh.user_id = ai.user_id AND uh.kind = 'primary'
       WHERE ai.provider = 'apple' AND ai.subject = $1`,
      [appleSub]
    );

    // Linked profiles.
    const { rows: linkedRows } = await pool.query(
      `SELECT lp.user_id, lp.label, u.role, u.is_active, uh.handle AS primary_handle
       FROM linked_profiles lp
       JOIN users u ON u.user_id = lp.user_id
       LEFT JOIN user_handles uh ON uh.user_id = lp.user_id AND uh.kind = 'primary'
       WHERE lp.apple_sub = $1`,
      [appleSub]
    );

    const primaryUserIDs = new Set(primaryRows.map((r) => r.user_id));
    const profiles = [];

    for (const row of primaryRows) {
      profiles.push({
        userID: row.user_id,
        primaryHandle: row.primary_handle,
        role: row.role,
        label: null,
        isActive: Boolean(row.is_active),
        isPrimary: true
      });
    }

    for (const row of linkedRows) {
      if (primaryUserIDs.has(row.user_id)) continue;
      profiles.push({
        userID: row.user_id,
        primaryHandle: row.primary_handle,
        role: row.role,
        label: row.label,
        isActive: Boolean(row.is_active),
        isPrimary: false
      });
    }

    return res.json({ profiles });
  } catch (err) {
    logger.error("/v1/auth/profiles failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "list profiles failed" });
  }
});

module.exports = router;