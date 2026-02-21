// routes/auth_apple.js — HakMun API (v0.12)
// POST /v1/auth/apple

const express = require("express");

const OpenAI = require("openai");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const { verifyAppleToken } = require("../auth/apple");
const { issueSessionTokens, getUserState, touchLastSeen, requireSession } = require("../auth/session");

const router = express.Router();

/* ------------------------------------------------------------------
   OpenAI (server-side only)
------------------------------------------------------------------ */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai =
  OPENAI_API_KEY && String(OPENAI_API_KEY).trim()
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

// openai is intentionally not used in this build (parity with original)

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
   Canonical identity resolution (auth_identities authority + tx bind)
------------------------------------------------------------------ */
async function ensureCanonicalUser({ appleSubject, audience, email }, rid) {
  // FAST PATH 1: exact auth_identities match
  try {
    const r = await withTimeout(
      pool.query(
        `
        select user_id
        from auth_identities
        where provider = $1 and subject = $2 and audience = $3
        limit 1
        `,
        ["apple", appleSubject, audience]
      ),
      3000,
      "auth_identities-lookup"
    );

    const userID = r?.rows?.[0]?.user_id || null;
    if (userID) {
      touchLastSeen(userID).catch(() => {});
      return userID;
    }
  } catch (e) {
    logger.error("[auth] fast auth_identities lookup failed", { rid, err: e?.message || String(e) });
  }

  // FAST PATH 2: same Apple subject already known under a different audience
  try {
    const r = await withTimeout(
      pool.query(
        `
        select user_id
        from auth_identities
        where provider = $1 and subject = $2
        limit 1
        `,
        ["apple", appleSubject]
      ),
      3000,
      "auth_identities-any-audience"
    );

    const userID = r?.rows?.[0]?.user_id || null;
    if (userID) {
      // Bind this audience to the same canonical user.
      pool
        .query(
          `
          insert into auth_identities (provider, subject, audience, user_id)
          values ('apple', $1, $2, $3)
          on conflict do nothing
          `,
          [appleSubject, audience, userID]
        )
        .catch((err) =>
          logger.warn("[warn] auth_identities bind (audience) failed", {
            rid,
            code: err?.code,
            err: err?.detail || err?.message || String(err)
          })
        );

      touchLastSeen(userID).catch(() => {});
      return userID;
    }
  } catch (e) {
    logger.error("[auth] fast auth_identities any-audience lookup failed", {
      rid,
      err: e?.message || String(e)
    });
  }

  // SLOW PATH: transactional create/bind (fail-fast on locks)
  const client = await pool.connect();
  try {
    await client.query(`set statement_timeout = 6000;`);
    await client.query(`set lock_timeout = 2000;`);
    await client.query("BEGIN");

    // Single-flight per Apple subject to prevent duplicate user creation.
    await client.query(`select pg_advisory_xact_lock(hashtext($1));`, [`apple:${appleSubject}`]);

    // Re-check exact match.
    const rExact = await client.query(
      `
      select user_id
      from auth_identities
      where provider = 'apple' and subject = $1 and audience = $2
      limit 1
      `,
      [appleSubject, audience]
    );

    let canonicalUserID = rExact.rows?.[0]?.user_id || null;

    // Re-check any-audience match.
    if (!canonicalUserID) {
      const rAny = await client.query(
        `
        select user_id
        from auth_identities
        where provider = 'apple' and subject = $1
        limit 1
        `,
        [appleSubject]
      );
      canonicalUserID = rAny.rows?.[0]?.user_id || null;
    }

    // One-time legacy bridge: match legacy users.apple_user_id by email (preferred) or old sub.
    if (!canonicalUserID && email) {
      const rLegacyEmail = await client.query(
        `
        select user_id
        from users
        where apple_user_id = $1
        limit 1
        `,
        [email]
      );
      canonicalUserID = rLegacyEmail.rows?.[0]?.user_id || null;
    }

    if (!canonicalUserID) {
      const rLegacySub = await client.query(
        `
        select user_id
        from users
        where apple_user_id = $1
        limit 1
        `,
        [appleSubject]
      );
      canonicalUserID = rLegacySub.rows?.[0]?.user_id || null;
    }

    // Create new canonical user (Apple-independent) if still missing.
    if (!canonicalUserID) {
      const created = await client.query(
        `
        insert into users (user_id, apple_user_id, last_seen_at, role, is_active, is_admin, is_root_admin)
        values (gen_random_uuid(), null, now(), 'student', true, false, false)
        returning user_id
        `
      );
      canonicalUserID = created.rows[0].user_id;
    }

    // Bind this (sub,aud) to canonical user.
    await client.query(
      `
      insert into auth_identities (provider, subject, audience, user_id)
      values ('apple', $1, $2, $3)
      on conflict do nothing
      `,
      [appleSubject, audience, canonicalUserID]
    );

    await client.query("COMMIT");

    touchLastSeen(canonicalUserID).catch(() => {});
    return canonicalUserID;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    logger.error("[auth] ensureCanonicalUser TX FAILED", { rid, err: err?.message || String(err) });
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------
   POST /v1/auth/apple
------------------------------------------------------------------ */
router.post("/v1/auth/apple", async (req, res) => {
  logger.info("[/v1/auth/apple] START", { rid: req._rid });
  res.set("X-HakMun-AuthApple", "v0.12");

  try {
    const identityToken = requireJsonField(req, res, "identityToken");
    if (!identityToken) return;

    const { appleSubject, audience, email } = await verifyAppleToken(identityToken);
    logger.info("[/v1/auth/apple] verified", { rid: req._rid, audience, hasEmail: Boolean(email) });

    const userID = await withTimeout(
      ensureCanonicalUser({ appleSubject, audience, email }, req._rid),
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

    return res.json(response);
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("/v1/auth/apple failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:apple-jwtVerify")) {
      return res.status(503).json({ error: "apple verification timeout" });
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

module.exports = router;