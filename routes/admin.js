// routes/admin.js — HakMun API (v0.12)
// EPIC 3 — Admin Ops Routes (root-admin-only)

const express = require("express");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const {
  requireSession,
  requireEntitlement,
  isPinnedRootAdmin
} = require("../auth/session");

const router = express.Router();

/* ------------------------------------------------------------------
   Helpers (copied verbatim behavior)
------------------------------------------------------------------ */
function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

function requireJsonField(req, res, fieldName) {
  const v = req.body?.[fieldName];
  if (!v || String(v).trim() === "") {
    res.status(400).json({ error: `${fieldName} is required` });
    return null;
  }
  return String(v);
}

function normalizeHandle(raw) {
  // Canonical handle normalization (server-authoritative)
  // - trim whitespace
  // - no internal whitespace
  // - preserve unicode (Korean handles are allowed)
  return String(raw || "").trim();
}

function isValidPrimaryHandle(handle) {
  const h = String(handle || "").trim();
  if (!h) return false;
  // Disallow spaces/tabs/newlines anywhere.
  if (/\s/.test(h)) return false;
  // Keep it conservative; we can widen later with an explicit rename/process.
  if (h.length < 2 || h.length > 32) return false;
  return true;
}

/* ------------------------------------------------------------------
   Root-admin gate (server-authoritative)
------------------------------------------------------------------ */
function requireRootAdmin(req, res, next) {
  if (!req.user?.capabilities?.canAdminUsers) {
    return res.status(403).json({ error: "root admin required" });
  }
  return next();
}

/* ------------------------------------------------------------------
   Admin test user creation (deterministic; no Apple IDs)
------------------------------------------------------------------ */
async function createUserWithPrimaryHandle({ primaryHandle, role = "student", isActive = true }) {
  const client = await pool.connect();
  try {
    await client.query(`set statement_timeout = 6000;`);
    await client.query(`set lock_timeout = 2000;`);
    await client.query("BEGIN");

    // Re-check uniqueness inside the TX.
    const exists = await client.query(
      `
      select 1
      from user_handles
      where kind = 'primary' and lower(handle) = lower($1)
      limit 1
      `,
      [primaryHandle]
    );

    if (exists.rows && exists.rows.length) {
      await client.query("ROLLBACK");
      return { error: "handle_taken" };
    }

    // Avoid Postgres extensions (gen_random_uuid) and optional columns (last_seen_at).
    const newUserID = crypto.randomUUID();

    const createdUser = await client.query(
      `
      insert into users (user_id, role, is_active, is_admin, is_root_admin)
      values ($1, $2, $3, false, false)
      returning user_id, role, is_active, is_admin, is_root_admin
      `,
      [newUserID, role, Boolean(isActive)]
    );

    const user = createdUser.rows?.[0];
    if (!user?.user_id) {
      throw new Error("failed to create user");
    }

    // Primary handle row MUST include primary_handle (NOT NULL).
    await client.query(
      `
      insert into user_handles (user_id, kind, handle, primary_handle)
      values ($1, 'primary', $2, $2)
      `,
      [user.user_id, primaryHandle]
    );

    await client.query("COMMIT");

    return {
      user: {
        user_id: user.user_id,
        role: user.role,
        is_active: user.is_active,
        is_admin: user.is_admin,
        is_root_admin: user.is_root_admin,
        primary_handle: primaryHandle
      }
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    // If a DB unique index exists, surface it deterministically as handle_taken.
    if (err?.code === "23505") {
      return { error: "handle_taken" };
    }

    throw new Error(String(err?.message || err));
  } finally {
    client.release();
  }
}

async function findUsersForAdmin({ search }) {
  const s = String(search || "").trim();

  // If UUID, direct lookup.
  if (s && looksLikeUUID(s)) {
    const { rows } = await pool.query(
      `
      select
        u.user_id,
        u.role,
        u.is_active,
        u.is_admin,
        u.is_root_admin,
        uh.handle as primary_handle
      from users u
      left join user_handles uh
        on uh.user_id = u.user_id and uh.kind = 'primary'
      where u.user_id = $1
      limit 1
      `,
      [s]
    );
    return rows || [];
  }

  // Otherwise search by primary handle (case-insensitive substring).
  const q = s ? `%${s}%` : "%";
  const { rows } = await pool.query(
    `
    select
      u.user_id,
      u.role,
      u.is_active,
      u.is_admin,
      u.is_root_admin,
      uh.handle as primary_handle
    from users u
    left join user_handles uh
      on uh.user_id = u.user_id and uh.kind = 'primary'
    where ($1 = '%' or uh.handle ilike $1)
    order by uh.handle nulls last, u.user_id
    limit 50
    `,
    [q]
  );
  return rows || [];
}

/* ------------------------------------------------------------------
   Routes
------------------------------------------------------------------ */

// POST /v1/admin/users { primaryHandle, role?, isActive? }
router.post(
  "/v1/admin/users",
  requireSession,
  requireRootAdmin,
  requireEntitlement("admin:users:write"),
  async (req, res) => {
    try {
      const rawHandle = requireJsonField(req, res, "primaryHandle");
      if (!rawHandle) return;

      const primaryHandle = normalizeHandle(rawHandle);
      if (!isValidPrimaryHandle(primaryHandle)) {
        return res.status(400).json({ error: "invalid primaryHandle" });
      }

      // Optional knobs; default to student + active.
      const roleRaw = req.body?.role;
      const isActiveRaw = req.body?.isActive;

      const role = roleRaw !== undefined && roleRaw !== null ? String(roleRaw).trim() : "student";
      if (!["student", "teacher", "approver"].includes(role)) {
        return res.status(400).json({ error: "invalid role" });
      }

      const isActive = isActiveRaw !== undefined && isActiveRaw !== null ? Boolean(isActiveRaw) : true;

      const created = await createUserWithPrimaryHandle({ primaryHandle, role, isActive });
      if (created?.error === "handle_taken") {
        return res.status(409).json({ error: "handle already taken" });
      }

      logger.info("[admin] user created", {
        rid: req._rid,
        actorUserID: req.user.userID,
        primaryHandle,
        role,
        isActive
      });

      return res.json({ user: created.user });
    } catch (err) {
      logger.error("/v1/admin/users (POST) failed", { rid: req._rid, err: err?.message || String(err) });
      return res.status(500).json({ error: "admin create user failed" });
    }
  }
);

// GET /v1/admin/users?search=<handle-substring-or-uuid>
router.get(
  "/v1/admin/users",
  requireSession,
  requireRootAdmin,
  requireEntitlement("admin:users:read"),
  async (req, res) => {
    try {
      const search = String(req.query?.search || "").trim();
      const users = await findUsersForAdmin({ search });
      return res.json({ users });
    } catch (err) {
      logger.error("/v1/admin/users failed", { rid: req._rid, err: err?.message || String(err) });
      return res.status(500).json({ error: "admin users failed" });
    }
  }
);

// PATCH /v1/admin/users/:userID { role?, isActive? }
router.patch(
  "/v1/admin/users/:userID",
  requireSession,
  requireRootAdmin,
  requireEntitlement("admin:users:write"),
  async (req, res) => {
    try {
      const targetUserID = String(req.params.userID || "").trim();
      if (!looksLikeUUID(targetUserID)) {
        return res.status(400).json({ error: "invalid userID" });
      }

      const roleRaw = req.body?.role;
      const isActiveRaw = req.body?.isActive;

      const updates = [];
      const params = [targetUserID];
      let idx = 2;

      if (roleRaw !== undefined && roleRaw !== null) {
        const role = String(roleRaw).trim();
        if (!["student", "teacher", "approver"].includes(role)) {
          return res.status(400).json({ error: "invalid role" });
        }
        updates.push(`role = $${idx++}`);
        params.push(role);
      }

      if (isActiveRaw !== undefined && isActiveRaw !== null) {
        const isActive = Boolean(isActiveRaw);
        updates.push(`is_active = $${idx++}`);
        params.push(isActive);
      }

      if (!updates.length) {
        return res.status(400).json({ error: "no updates" });
      }

      // Never allow demotion of pinned root admins (safety invariant)
      if (isPinnedRootAdmin(targetUserID)) {
        // Prevent disabling pinned root admin by accident
        if (updates.some((u) => u.startsWith("is_active")) && Boolean(isActiveRaw) === false) {
          return res.status(403).json({ error: "cannot deactivate pinned root admin" });
        }
      }

      const q = `
      update users
      set ${updates.join(", ")}
      where user_id = $1
      returning user_id, role, is_active, is_admin, is_root_admin
    `;

      const { rows } = await pool.query(q, params);
      if (!rows || !rows.length) {
        return res.status(404).json({ error: "user not found" });
      }

      logger.info("[admin] user updated", {
        rid: req._rid,
        actorUserID: req.user.userID,
        targetUserID,
        changed: updates
      });

      return res.json({ user: rows[0] });
    } catch (err) {
      logger.error("/v1/admin/users/:userID failed", { rid: req._rid, err: err?.message || String(err) });
      return res.status(500).json({ error: "admin update failed" });
    }
  }
);

/* ------------------------------------------------------------------
   Linked Profiles (profile switching for root admins)
------------------------------------------------------------------ */

// Helper: resolve the Apple sub for the current user
async function resolveAppleSub(userID) {
  const { rows } = await pool.query(
    `SELECT subject FROM auth_identities WHERE user_id = $1 AND provider = 'apple' LIMIT 1`,
    [userID]
  );
  return rows?.[0]?.subject || null;
}

// POST /v1/admin/profiles/link { targetUserID, label? }
router.post(
  "/v1/admin/profiles/link",
  requireSession,
  requireRootAdmin,
  requireEntitlement("admin:users:write"),
  async (req, res) => {
    try {
      const targetUserID = requireJsonField(req, res, "targetUserID");
      if (!targetUserID) return;
      if (!looksLikeUUID(targetUserID)) {
        return res.status(400).json({ error: "invalid targetUserID" });
      }

      const label = req.body?.label ? String(req.body.label).trim() : null;

      const appleSub = await resolveAppleSub(req.user.userID);
      if (!appleSub) {
        return res.status(400).json({ error: "no Apple identity found for current user" });
      }

      // Target must exist and be active.
      const { rows: targetRows } = await pool.query(
        `SELECT user_id, is_active FROM users WHERE user_id = $1 LIMIT 1`,
        [targetUserID]
      );
      if (!targetRows?.length) {
        return res.status(404).json({ error: "target user not found" });
      }
      if (!Boolean(targetRows[0].is_active)) {
        return res.status(400).json({ error: "target user is not active" });
      }

      await pool.query(
        `INSERT INTO linked_profiles (apple_sub, user_id, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (apple_sub, user_id) DO UPDATE SET label = EXCLUDED.label`,
        [appleSub, targetUserID, label]
      );

      logger.info("[admin] profile linked", {
        rid: req._rid,
        actorUserID: req.user.userID,
        targetUserID,
        label
      });

      return res.json({ ok: true, linked: { appleSub, userID: targetUserID, label } });
    } catch (err) {
      logger.error("/v1/admin/profiles/link failed", { rid: req._rid, err: err?.message || String(err) });
      return res.status(500).json({ error: "link profile failed" });
    }
  }
);

// DELETE /v1/admin/profiles/link/:userID
router.delete(
  "/v1/admin/profiles/link/:userID",
  requireSession,
  requireRootAdmin,
  async (req, res) => {
    try {
      const targetUserID = String(req.params.userID || "").trim();
      if (!looksLikeUUID(targetUserID)) {
        return res.status(400).json({ error: "invalid userID" });
      }

      const appleSub = await resolveAppleSub(req.user.userID);
      if (!appleSub) {
        return res.status(400).json({ error: "no Apple identity found for current user" });
      }

      // Cannot unlink the primary account (the one in auth_identities).
      const { rows: primary } = await pool.query(
        `SELECT user_id FROM auth_identities WHERE provider = 'apple' AND subject = $1 AND user_id = $2 LIMIT 1`,
        [appleSub, targetUserID]
      );
      if (primary?.length) {
        return res.status(400).json({ error: "cannot unlink primary account" });
      }

      const { rowCount } = await pool.query(
        `DELETE FROM linked_profiles WHERE apple_sub = $1 AND user_id = $2`,
        [appleSub, targetUserID]
      );

      if (!rowCount) {
        return res.status(404).json({ error: "link not found" });
      }

      logger.info("[admin] profile unlinked", {
        rid: req._rid,
        actorUserID: req.user.userID,
        targetUserID
      });

      return res.json({ ok: true });
    } catch (err) {
      logger.error("/v1/admin/profiles/link/:userID (DELETE) failed", {
        rid: req._rid,
        err: err?.message || String(err)
      });
      return res.status(500).json({ error: "unlink profile failed" });
    }
  }
);

// GET /v1/admin/profiles
router.get(
  "/v1/admin/profiles",
  requireSession,
  requireRootAdmin,
  async (req, res) => {
    try {
      const appleSub = await resolveAppleSub(req.user.userID);
      if (!appleSub) {
        return res.status(400).json({ error: "no Apple identity found for current user" });
      }

      // Primary account from auth_identities
      const { rows: primaryRows } = await pool.query(
        `SELECT ai.user_id, u.role, u.is_active, uh.handle AS primary_handle
         FROM auth_identities ai
         JOIN users u ON u.user_id = ai.user_id
         LEFT JOIN user_handles uh ON uh.user_id = ai.user_id AND uh.kind = 'primary'
         WHERE ai.provider = 'apple' AND ai.subject = $1`,
        [appleSub]
      );

      // Linked profiles
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
      logger.error("/v1/admin/profiles failed", { rid: req._rid, err: err?.message || String(err) });
      return res.status(500).json({ error: "list profiles failed" });
    }
  }
);

module.exports = router;