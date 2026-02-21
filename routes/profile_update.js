// routes/profile_update.js — HakMun API
// Self-service profile updates: display name, role (student/teacher), handle.
// ENDPOINT: PATCH /v1/me/profile

const express = require("express");
const router = express.Router();

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { requireSession } = require("../auth/session");

// ---------- Handle validation (mirrors admin.js) ----------

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

async function buildProfileResponse(userID, reqUser) {
  // Fetch primary handle
  const { rows: handleRows } = await pool.query(
    `SELECT handle FROM user_handles WHERE user_id = $1 AND kind = 'primary' LIMIT 1`,
    [userID]
  );
  const primaryHandle = handleRows?.[0]?.handle || null;
  const profileComplete = Boolean(primaryHandle && String(primaryHandle).trim());

  // Fetch fresh user state for display_name and role
  const { rows: userRows } = await pool.query(
    `SELECT role, is_admin, is_root_admin, is_active, display_name FROM users WHERE user_id = $1 LIMIT 1`,
    [userID]
  );
  const u = userRows?.[0] || {};

  return {
    userID,
    role: u.role || "student",
    isTeacher: String(u.role || "student") === "teacher",
    isAdmin: Boolean(u.is_admin),
    isRootAdmin: Boolean(u.is_root_admin),
    isActive: Boolean(u.is_active),
    entitlements: reqUser.entitlements || [],
    capabilities: reqUser.capabilities || {},
    profileComplete,
    primaryHandle,
    username: primaryHandle,
    displayName: u.display_name || null
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

      // Update existing handle row (user already has a primary handle if they passed the gate)
      const { rowCount } = await pool.query(
        `UPDATE user_handles SET handle = $1, primary_handle = $1 WHERE user_id = $2 AND kind = 'primary'`,
        [handle, userID]
      );

      // If no row existed (edge case: first handle), insert
      if (!rowCount) {
        await pool.query(
          `INSERT INTO user_handles (user_id, kind, handle, primary_handle) VALUES ($1, 'primary', $2, $2)`,
          [userID, handle]
        );
      }

      changed = true;
    }

    if (!changed) {
      return res.status(400).json({ error: "NO_UPDATES", message: "No fields to update" });
    }

    // Return fresh whoami-shaped response
    const profile = await buildProfileResponse(userID, req.user);

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
