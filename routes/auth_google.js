// routes/auth_google.js — HakMun API
// POST /v1/auth/google — Google Sign-In for web app

const express = require("express");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const { verifyGoogleCode } = require("../auth/google");
const { ensureCanonicalUser } = require("../auth/identity");
const { issueSessionTokens, getUserState } = require("../auth/session");
const { audit } = require("../util/audit");

const router = express.Router();

/* ------------------------------------------------------------------
   POST /v1/auth/google
------------------------------------------------------------------ */
router.post("/v1/auth/google", async (req, res) => {
  logger.info("[/v1/auth/google] START", { rid: req._rid });

  try {
    const code = req.body?.code;
    if (!code || String(code).trim() === "") {
      return res.status(400).json({ error: "code is required" });
    }

    const redirectUri = req.body?.redirectUri;
    if (!redirectUri || String(redirectUri).trim() === "") {
      return res.status(400).json({ error: "redirectUri is required" });
    }

    const { googleSubject, audience, email, name } = await verifyGoogleCode(
      String(code),
      String(redirectUri)
    );
    logger.info("[/v1/auth/google] verified", {
      rid: req._rid,
      audience,
      hasEmail: Boolean(email)
    });

    const userID = await withTimeout(
      ensureCanonicalUser(
        { provider: "google", subject: googleSubject, audience, email },
        req._rid
      ),
      6000,
      "ensureCanonicalUser"
    );
    logger.info("[/v1/auth/google] canonical", { rid: req._rid, userID });

    const state = await withTimeout(getUserState(userID), 6000, "getUserState");

    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    const tokens = await withTimeout(
      issueSessionTokens({ userID }),
      3000,
      "issueSessionTokens"
    );

    audit(req, "user.signin", "user", userID, { provider: "google", audience }, userID).catch(
      () => {}
    );

    return res.json({
      ...tokens,
      user: {
        userID,
        role: state.role,
        isTeacher: String(state.role || "student") === "teacher",
        isAdmin: Boolean(state.is_admin),
        isRootAdmin: Boolean(state.is_root_admin),
        isActive: Boolean(state.is_active)
      }
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("/v1/auth/google failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:google-token-exchange")) {
      return res.status(503).json({ error: "google token exchange timeout" });
    }
    if (msg.startsWith("timeout:google-jwtVerify")) {
      return res.status(503).json({ error: "google verification timeout" });
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

module.exports = router;
