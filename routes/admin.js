// routes/admin.js — HakMun API (v0.12)
// EPIC 3 — Admin Ops Routes (root-admin-only)

const express = require("express");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const {
  requireSession,
  requireEntitlement,
  getUserState,
  issueSessionTokens,
  issueImpersonationAccessToken,
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
  // Root-admin ops require explicit capability derived server-side.
  // This also guarantees admin ops are forbidden while impersonating.
  if (!req.user?.capabilities?.canAdminUsers) {
    return res.status(403).json({ error: "root admin required" });
  }
  return next();
}

function requireImpersonating(req, res, next) {
  if (!req.user?.impersonating) {
    return res.status(400).json({ error: "not impersonating" });
  }
  if (!req.user?.actorUserID) {
    return res.status(400).json({ error: "impersonation missing actor" });
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
      if (role !== "student" && role !== "teacher") {
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
        if (role !== "student" && role !== "teacher") {
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

// POST /v1/admin/impersonate { targetUserID }
router.post(
  "/v1/admin/impersonate",
  requireSession,
  requireRootAdmin,
  requireEntitlement("admin:impersonate"),
  async (req, res) => {
    try {
      const targetUserID = requireJsonField(req, res, "targetUserID");
      if (!targetUserID) return;
      if (!looksLikeUUID(targetUserID)) {
        return res.status(400).json({ error: "invalid targetUserID" });
      }

      // Target must exist + be active; no bypass.
      const state = await getUserState(targetUserID);
      if (!Boolean(state.is_active)) {
        return res.status(403).json({ error: "target account disabled" });
      }

      const tokens = await issueImpersonationAccessToken({
        targetUserID,
        actorUserID: req.user.userID
      });

      logger.info("[admin] impersonation started", {
        rid: req._rid,
        actorUserID: req.user.userID,
        targetUserID
      });

      return res.json({
        ...tokens,
        impersonating: true,
        actorUserID: req.user.userID,
        targetUserID
      });
    } catch (err) {
      logger.error("/v1/admin/impersonate failed", { rid: req._rid, err: err?.message || String(err) });
      return res.status(500).json({ error: "impersonate failed" });
    }
  }
);

// POST /v1/admin/impersonate/exit (must be called with an impersonation access token)
router.post("/v1/admin/impersonate/exit", requireSession, requireImpersonating, async (req, res) => {
  try {
    const actorUserID = req.user.actorUserID;

    // Issue normal session tokens for the actor.
    const tokens = await issueSessionTokens({ userID: actorUserID });

    logger.info("[admin] impersonation exited", {
      rid: req._rid,
      actorUserID,
      targetUserID: req.user.userID
    });

    return res.json({
      ...tokens,
      impersonating: false
    });
  } catch (err) {
    logger.error("/v1/admin/impersonate/exit failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "exit impersonation failed" });
  }
});

module.exports = router;