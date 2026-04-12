// routes/auth_setup.js — HakMun API
// POST /v1/auth/complete-setup — create new account from provisional token
// POST /v1/auth/link — link new provider identity to existing account

const crypto = require("crypto");
const express = require("express");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const { verifyProvisionalToken, issueSessionTokens, getUserState } = require("../auth/session");
const { ensureCanonicalUser, findUserByIdentity } = require("../auth/identity");
const { verifyAppleToken, verifyAppleCode } = require("../auth/apple");
const { verifyGoogleCode } = require("../auth/google");
const { audit } = require("../util/audit");

const router = express.Router();

/* ------------------------------------------------------------------
   POST /v1/auth/complete-setup
   Create a new account with a username, binding the provisional identity.
------------------------------------------------------------------ */
router.post("/v1/auth/complete-setup", async (req, res) => {
  logger.info("[/v1/auth/complete-setup] START", { rid: req._rid });

  try {
    const provisionalToken = req.body?.provisionalToken;
    if (!provisionalToken || String(provisionalToken).trim() === "") {
      return res.status(400).json({ error: "provisionalToken is required" });
    }

    const username = req.body?.username;
    if (!username || String(username).trim() === "") {
      return res.status(400).json({ error: "username is required" });
    }

    const handle = String(username).trim();

    // Basic handle validation: 2-30 chars, alphanumeric + underscores
    if (!/^[a-zA-Z0-9_]{2,30}$/.test(handle)) {
      return res.status(400).json({
        error: "invalid_username",
        message: "Username must be 2-30 characters, letters/numbers/underscores only"
      });
    }

    // Verify the provisional token
    let identity;
    try {
      identity = await verifyProvisionalToken(provisionalToken);
    } catch (err) {
      logger.warn("[/v1/auth/complete-setup] invalid provisional token", {
        rid: req._rid,
        err: err?.message || String(err)
      });
      return res.status(401).json({ error: "invalid or expired provisional token" });
    }

    // Check if this identity was already bound (idempotent — someone already completed setup)
    const existingUserID = await withTimeout(
      findUserByIdentity({
        provider: identity.provider,
        subject: identity.sub,
        audience: identity.audience
      }),
      3000,
      "findUserByIdentity"
    );

    if (existingUserID) {
      // Identity already bound — just sign them in
      const state = await withTimeout(getUserState(existingUserID), 6000, "getUserState");
      if (!Boolean(state.is_active)) {
        return res.status(403).json({ error: "account disabled" });
      }
      const tokens = await withTimeout(issueSessionTokens({ userID: existingUserID }), 3000, "issueSessionTokens");
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
    }

    // Create user + handle + bind identity in a transaction
    const client = await pool.connect();
    try {
      await client.query("set statement_timeout = 6000;");
      await client.query("set lock_timeout = 2000;");
      await client.query("BEGIN");

      // Check handle uniqueness (case-insensitive)
      const exists = await client.query(
        `SELECT 1 FROM user_handles WHERE kind = 'primary' AND lower(handle) = lower($1) LIMIT 1`,
        [handle]
      );
      if (exists.rows?.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "handle_taken", message: "That username is already taken" });
      }

      const newUserID = crypto.randomUUID();

      // Create user row
      await client.query(
        `INSERT INTO users (user_id, role, is_active, is_admin, is_root_admin, display_name, primary_language, gloss_language)
         VALUES ($1, 'student', true, false, false, $2, $3, $4)`,
        [
          newUserID,
          req.body?.displayName ? String(req.body.displayName).trim() : null,
          req.body?.primaryLanguage ? String(req.body.primaryLanguage).trim() : "English",
          req.body?.glossLanguage ? String(req.body.glossLanguage).trim() : "Korean"
        ]
      );

      // Create primary handle
      await client.query(
        `INSERT INTO user_handles (user_id, kind, handle, primary_handle)
         VALUES ($1, 'primary', $2, $2)`,
        [newUserID, handle]
      );

      // Bind provider identity
      await client.query(
        `INSERT INTO auth_identities (provider, subject, audience, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [identity.provider, identity.sub, identity.audience, newUserID]
      );

      await client.query("COMMIT");

      // Notify Discord
      const webhookUrl = process.env.DISCORD_SIGNUP_WEBHOOK_URL;
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🎉 **New HakMun user** joined!\nHandle: \`${handle}\`\nUser ID: \`${newUserID}\`\nProvider: ${identity.provider}\nPlatform: web`
          })
        }).catch((err) =>
          logger.warn("[discord] signup webhook failed", { rid: req._rid, err: err?.message || String(err) })
        );
      }

      logger.info("[/v1/auth/complete-setup] user created", {
        rid: req._rid,
        userID: newUserID,
        handle,
        provider: identity.provider
      });

      const state = await withTimeout(getUserState(newUserID), 6000, "getUserState");
      const tokens = await withTimeout(issueSessionTokens({ userID: newUserID }), 3000, "issueSessionTokens");

      audit(req, "user.signup", "user", newUserID, { provider: identity.provider, handle, platform: "web" }, newUserID).catch(() => {});

      return res.json({
        ...tokens,
        user: {
          userID: newUserID,
          role: state.role,
          isTeacher: String(state.role || "student") === "teacher",
          isAdmin: Boolean(state.is_admin),
          isRootAdmin: Boolean(state.is_root_admin),
          isActive: Boolean(state.is_active)
        }
      });
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}

      if (err?.code === "23505") {
        return res.status(409).json({ error: "handle_taken", message: "That username is already taken" });
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("/v1/auth/complete-setup failed", { rid: req._rid, err: msg });
    return res.status(500).json({ error: "account setup failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/auth/link
   Link a new provider identity to an existing account by authenticating
   with the existing account's provider.
------------------------------------------------------------------ */
router.post("/v1/auth/link", async (req, res) => {
  logger.info("[/v1/auth/link] START", { rid: req._rid });

  try {
    // 1. Verify the provisional token (the NEW identity being linked)
    const provisionalToken = req.body?.provisionalToken;
    if (!provisionalToken || String(provisionalToken).trim() === "") {
      return res.status(400).json({ error: "provisionalToken is required" });
    }

    let newIdentity;
    try {
      newIdentity = await verifyProvisionalToken(provisionalToken);
    } catch (err) {
      logger.warn("[/v1/auth/link] invalid provisional token", {
        rid: req._rid,
        err: err?.message || String(err)
      });
      return res.status(401).json({ error: "invalid or expired provisional token" });
    }

    // 2. Verify the existing provider auth (proves ownership of the existing account)
    const existingAuth = req.body?.existingAuth;
    if (!existingAuth || typeof existingAuth !== "object") {
      return res.status(400).json({ error: "existingAuth is required" });
    }

    const existingProvider = String(existingAuth.provider || "").trim();
    if (!existingProvider) {
      return res.status(400).json({ error: "existingAuth.provider is required" });
    }

    let existingSubject, existingAudience, existingEmail;

    if (existingProvider === "apple") {
      // Apple: accept identityToken (native) or code + redirectUri (web)
      if (existingAuth.code) {
        const redirectUri = existingAuth.redirectUri;
        if (!redirectUri) {
          return res.status(400).json({ error: "existingAuth.redirectUri is required for Apple web flow" });
        }
        ({ appleSubject: existingSubject, audience: existingAudience, email: existingEmail } =
          await verifyAppleCode(String(existingAuth.code), String(redirectUri)));
      } else if (existingAuth.identityToken) {
        ({ appleSubject: existingSubject, audience: existingAudience, email: existingEmail } =
          await verifyAppleToken(String(existingAuth.identityToken)));
      } else {
        return res.status(400).json({ error: "existingAuth requires code or identityToken for Apple" });
      }
    } else if (existingProvider === "google") {
      if (!existingAuth.code) {
        return res.status(400).json({ error: "existingAuth.code is required for Google" });
      }
      const redirectUri = existingAuth.redirectUri;
      if (!redirectUri) {
        return res.status(400).json({ error: "existingAuth.redirectUri is required for Google" });
      }
      const googleResult = await verifyGoogleCode(String(existingAuth.code), String(redirectUri));
      existingSubject = googleResult.googleSubject;
      existingAudience = googleResult.audience;
      existingEmail = googleResult.email;
    } else {
      return res.status(400).json({ error: `unsupported provider: ${existingProvider}` });
    }

    // 3. Find the existing user
    const existingUserID = await withTimeout(
      findUserByIdentity({
        provider: existingProvider,
        subject: existingSubject,
        audience: existingAudience
      }),
      3000,
      "findUserByIdentity-existing"
    );

    if (!existingUserID) {
      return res.status(404).json({
        error: "no_account_found",
        message: "No HakMun account found for that sign-in. Did you mean to create a new account?"
      });
    }

    // 4. Check account is active
    const state = await withTimeout(getUserState(existingUserID), 6000, "getUserState");
    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    // 5. Bind the new identity to the existing user
    await pool.query(
      `INSERT INTO auth_identities (provider, subject, audience, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [newIdentity.provider, newIdentity.sub, newIdentity.audience, existingUserID]
    );

    logger.info("[/v1/auth/link] identity linked", {
      rid: req._rid,
      userID: existingUserID,
      newProvider: newIdentity.provider,
      existingProvider
    });

    // 6. Issue session tokens for the existing user
    const tokens = await withTimeout(
      issueSessionTokens({ userID: existingUserID }),
      3000,
      "issueSessionTokens"
    );

    audit(req, "user.link_provider", "user", existingUserID, {
      newProvider: newIdentity.provider,
      existingProvider,
      platform: "web"
    }, existingUserID).catch(() => {});

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
    logger.error("/v1/auth/link failed", { rid: req._rid, err: msg });
    return res.status(500).json({ error: "account linking failed" });
  }
});

module.exports = router;
