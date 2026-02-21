// routes/profile_update.js — HakMun API
// Self-service profile updates: display name, role, handle, language, privacy, location, CEFR.
// ENDPOINT: PATCH /v1/me/profile

const express = require("express");
const router = express.Router();

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { requireSession, computeEntitlementsFromUser } = require("../auth/session");

// ---------- Validation ----------

const VALID_LANGUAGES = ["en", "ko", "ja", "zh", "es", "vi"];
const VALID_CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];

function normalizeHandle(raw) {
  return String(raw || "").trim();
}

function isValidPrimaryHandle(handle) {
  const h = String(handle || "").trim();
  if (!h) return false;
  if (/\s/.test(h)) return false;
  if (h.length < 2 || h.length > 32) return false;
  return true;
}

// ---------- Build whoami-shaped response ----------

async function buildProfileResponse(userID) {
  // Fetch primary handle
  const { rows: handleRows } = await pool.query(
    `SELECT handle FROM user_handles WHERE user_id = $1 AND kind = 'primary' LIMIT 1`,
    [userID]
  );
  const primaryHandle = handleRows?.[0]?.handle || null;
  const profileComplete = Boolean(primaryHandle && String(primaryHandle).trim());

  // Fetch fresh user state
  const { rows: userRows } = await pool.query(
    `SELECT role, is_admin, is_root_admin, is_active, display_name,
            primary_language, gloss_language,
            customize_learning, share_progress_default, allow_teacher_adjust_default,
            location_city, location_country, share_city, share_country,
            cefr_current, cefr_target
     FROM users WHERE user_id = $1 LIMIT 1`,
    [userID]
  );
  const u = userRows?.[0] || {};

  // Recompute entitlements from fresh DB state (role may have changed).
  const freshUser = {
    role: u.role || "student",
    isActive: Boolean(u.is_active),
    isAdmin: Boolean(u.is_admin),
    isRootAdmin: Boolean(u.is_root_admin)
  };
  const { entitlements, capabilities } = computeEntitlementsFromUser(freshUser);

  return {
    userID,
    role: freshUser.role,
    isTeacher: freshUser.role === "teacher",
    isAdmin: freshUser.isAdmin,
    isRootAdmin: freshUser.isRootAdmin,
    isActive: freshUser.isActive,
    entitlements,
    capabilities,
    profileComplete,
    primaryHandle,
    username: primaryHandle,
    displayName: u.display_name || null,
    // Preferences
    primaryLanguage: u.primary_language || "en",
    glossLanguage: u.gloss_language || "en",
    customizeLearning: Boolean(u.customize_learning),
    shareProgressDefault: Boolean(u.share_progress_default),
    allowTeacherAdjustDefault: Boolean(u.allow_teacher_adjust_default),
    locationCity: u.location_city || null,
    locationCountry: u.location_country || null,
    shareCity: Boolean(u.share_city),
    shareCountry: Boolean(u.share_country),
    cefrCurrent: u.cefr_current || "A1",
    cefrTarget: u.cefr_target || null
  };
}

// ---------- PATCH /v1/me/profile ----------

router.patch("/v1/me/profile", requireSession, async (req, res) => {
  try {
    const { userID } = req.user;
    const body = req.body || {};

    let changed = false;

    // --- Display Name ---
    if ("displayName" in body) {
      const raw = body.displayName;
      const displayName = raw == null ? null : String(raw).trim().slice(0, 64);
      const val = displayName === "" ? null : displayName;

      await pool.query(
        `UPDATE users SET display_name = $1 WHERE user_id = $2`,
        [val, userID]
      );
      changed = true;
    }

    // --- Role (student or teacher only) ---
    if ("role" in body && body.role != null) {
      const role = String(body.role).trim();
      if (!["student", "teacher"].includes(role)) {
        return res.status(403).json({ error: "ROLE_NOT_ALLOWED", message: "Self-service role must be student or teacher" });
      }
      await pool.query(
        `UPDATE users SET role = $1 WHERE user_id = $2`,
        [role, userID]
      );
      changed = true;
    }

    // --- Primary Handle ---
    if ("primaryHandle" in body && body.primaryHandle != null) {
      const handle = normalizeHandle(body.primaryHandle);

      if (!isValidPrimaryHandle(handle)) {
        return res.status(400).json({ error: "INVALID_HANDLE", message: "Handle must be 2-32 characters with no whitespace" });
      }

      // Check uniqueness (case-insensitive)
      const { rows: existing } = await pool.query(
        `SELECT user_id FROM user_handles WHERE kind = 'primary' AND lower(handle) = lower($1) LIMIT 1`,
        [handle]
      );

      if (existing.length && existing[0].user_id !== userID) {
        return res.status(409).json({ error: "HANDLE_TAKEN", message: "That username is already taken" });
      }

      const { rowCount } = await pool.query(
        `UPDATE user_handles SET handle = $1, primary_handle = $1 WHERE user_id = $2 AND kind = 'primary'`,
        [handle, userID]
      );

      if (!rowCount) {
        await pool.query(
          `INSERT INTO user_handles (user_id, kind, handle, primary_handle) VALUES ($1, 'primary', $2, $2)`,
          [userID, handle]
        );
      }

      changed = true;
    }

    // --- Primary Language ---
    if ("primaryLanguage" in body) {
      const val = String(body.primaryLanguage || "").trim();
      if (!VALID_LANGUAGES.includes(val)) {
        return res.status(400).json({ error: "INVALID_LANGUAGE", message: `Must be one of: ${VALID_LANGUAGES.join(", ")}` });
      }
      await pool.query(`UPDATE users SET primary_language = $1 WHERE user_id = $2`, [val, userID]);
      changed = true;
    }

    // --- Gloss Language ---
    if ("glossLanguage" in body) {
      const val = String(body.glossLanguage || "").trim();
      if (!VALID_LANGUAGES.includes(val)) {
        return res.status(400).json({ error: "INVALID_LANGUAGE", message: `Must be one of: ${VALID_LANGUAGES.join(", ")}` });
      }
      await pool.query(`UPDATE users SET gloss_language = $1 WHERE user_id = $2`, [val, userID]);
      changed = true;
    }

    // --- Privacy: Customize Learning ---
    if ("customizeLearning" in body) {
      const val = Boolean(body.customizeLearning);
      await pool.query(`UPDATE users SET customize_learning = $1 WHERE user_id = $2`, [val, userID]);
      // Cascade: turning off clears dependent switches
      if (!val) {
        await pool.query(
          `UPDATE users SET share_progress_default = false, allow_teacher_adjust_default = false WHERE user_id = $1`,
          [userID]
        );
      }
      changed = true;
    }

    // --- Privacy: Share Progress Default ---
    if ("shareProgressDefault" in body) {
      const val = Boolean(body.shareProgressDefault);
      await pool.query(`UPDATE users SET share_progress_default = $1 WHERE user_id = $2`, [val, userID]);
      // Cascade: turning off clears allow_teacher_adjust_default
      if (!val) {
        await pool.query(`UPDATE users SET allow_teacher_adjust_default = false WHERE user_id = $1`, [userID]);
      }
      changed = true;
    }

    // --- Privacy: Allow Teacher Adjust Default ---
    if ("allowTeacherAdjustDefault" in body) {
      const val = Boolean(body.allowTeacherAdjustDefault);
      if (val) {
        const { rows } = await pool.query(
          `SELECT customize_learning, share_progress_default FROM users WHERE user_id = $1`,
          [userID]
        );
        const u = rows?.[0];
        if (!u?.customize_learning || !u?.share_progress_default) {
          return res.status(400).json({
            error: "DEPENDENCY_NOT_MET",
            message: "Requires both customizeLearning and shareProgressDefault to be enabled"
          });
        }
      }
      await pool.query(`UPDATE users SET allow_teacher_adjust_default = $1 WHERE user_id = $2`, [val, userID]);
      changed = true;
    }

    // --- Location City ---
    if ("locationCity" in body) {
      const val = body.locationCity == null ? null : String(body.locationCity).trim().slice(0, 128);
      await pool.query(`UPDATE users SET location_city = $1 WHERE user_id = $2`, [val || null, userID]);
      changed = true;
    }

    // --- Location Country ---
    if ("locationCountry" in body) {
      const val = body.locationCountry == null ? null : String(body.locationCountry).trim().slice(0, 128);
      await pool.query(`UPDATE users SET location_country = $1 WHERE user_id = $2`, [val || null, userID]);
      changed = true;
    }

    // --- Share City ---
    if ("shareCity" in body) {
      await pool.query(`UPDATE users SET share_city = $1 WHERE user_id = $2`, [Boolean(body.shareCity), userID]);
      changed = true;
    }

    // --- Share Country ---
    if ("shareCountry" in body) {
      await pool.query(`UPDATE users SET share_country = $1 WHERE user_id = $2`, [Boolean(body.shareCountry), userID]);
      changed = true;
    }

    // --- CEFR Current ---
    if ("cefrCurrent" in body) {
      const val = String(body.cefrCurrent || "").trim().toUpperCase();
      if (!VALID_CEFR.includes(val)) {
        return res.status(400).json({ error: "INVALID_CEFR", message: `Must be one of: ${VALID_CEFR.join(", ")}` });
      }
      await pool.query(`UPDATE users SET cefr_current = $1 WHERE user_id = $2`, [val, userID]);
      changed = true;
    }

    // --- CEFR Target ---
    if ("cefrTarget" in body) {
      if (body.cefrTarget == null) {
        await pool.query(`UPDATE users SET cefr_target = NULL WHERE user_id = $1`, [userID]);
      } else {
        const val = String(body.cefrTarget).trim().toUpperCase();
        if (!VALID_CEFR.includes(val)) {
          return res.status(400).json({ error: "INVALID_CEFR", message: `Must be one of: ${VALID_CEFR.join(", ")}` });
        }
        await pool.query(`UPDATE users SET cefr_target = $1 WHERE user_id = $2`, [val, userID]);
      }
      changed = true;
    }

    if (!changed) {
      return res.status(400).json({ error: "NO_UPDATES", message: "No fields to update" });
    }

    // Return fresh whoami-shaped response
    const profile = await buildProfileResponse(userID);

    logger.info("[profile] self-service update", {
      rid: req._rid,
      userID,
      fields: Object.keys(body).filter(k => body[k] !== undefined)
    });

    return res.json(profile);
  } catch (err) {
    // Handle uniqueness constraint violation
    if (err?.code === "23505") {
      return res.status(409).json({ error: "HANDLE_TAKEN", message: "That username is already taken" });
    }
    logger.error("PATCH /v1/me/profile failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "INTERNAL" });
  }
});

module.exports = router;
