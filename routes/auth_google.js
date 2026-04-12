// routes/auth_google.js — HakMun API
// POST /v1/auth/google — Google Sign-In for web app

const express = require("express");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const { verifyGoogleCode } = require("../auth/google");
const { findUserByIdentity, ensureCanonicalUser } = require("../auth/identity");
const { issueSessionTokens, issueProvisionalToken, getUserState } = require("../auth/session");
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

    // Look up without creating — if no user, return provisional token for setup flow
    const existingUserID = await withTimeout(
      findUserByIdentity({ provider: "google", subject: googleSubject, audience }),
      3000,
      "findUserByIdentity"
    );

    if (!existingUserID) {
      // Unknown identity — issue provisional token for account setup
      const provisionalToken = await withTimeout(
        issueProvisionalToken({
          provider: "google",
          sub: googleSubject,
          audience,
          email,
          name
        }),
        3000,
        "issueProvisionalToken"
      );

      logger.info("[/v1/auth/google] new identity, provisional token issued", {
        rid: req._rid,
        hasEmail: Boolean(email),
        hasName: Boolean(name)
      });

      return res.json({
        status: "new_identity",
        provisionalToken,
        provider: "google",
        email: email || null,
        name: name || null
      });
    }

    // Known user — issue session tokens
    logger.info("[/v1/auth/google] canonical", { rid: req._rid, userID: existingUserID });

    const state = await withTimeout(getUserState(existingUserID), 6000, "getUserState");

    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    // Bind this audience if not already bound (handles web vs native client ID difference)
    ensureCanonicalUser(
      { provider: "google", subject: googleSubject, audience, email },
      req._rid
    ).catch((err) =>
      logger.warn("[/v1/auth/google] audience bind failed (non-fatal)", {
        rid: req._rid,
        err: err?.message || String(err)
      })
    );

    const tokens = await withTimeout(
      issueSessionTokens({ userID: existingUserID }),
      3000,
      "issueSessionTokens"
    );

    audit(req, "user.signin", "user", existingUserID, { provider: "google", audience }, existingUserID).catch(
      () => {}
    );

    return res.json({
      ...tokens,
      user: {
        userID: existingUserID,
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
