// auth/session.js — HakMun API (v0.12)
// JWT + requireSession + A0 admin safety invariants

const crypto = require("crypto");
const { jwtVerify, SignJWT } = require("jose");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");

// Env (fail-fast parity)
const SESSION_JWT_SECRET = process.env.SESSION_JWT_SECRET;
if (!SESSION_JWT_SECRET || String(SESSION_JWT_SECRET).trim() === "") {
  throw new Error("Missing required environment variable: SESSION_JWT_SECRET");
}

const NODE_ENV = process.env.NODE_ENV || "<unset>";

// ROOT_ADMIN_USER_IDS parsing logic must match original semantics
function parseCsvEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ROOT_ADMIN_USER_IDS =
  NODE_ENV === "production"
    ? parseCsvEnv("ROOT_ADMIN_USER_IDS").length
      ? parseCsvEnv("ROOT_ADMIN_USER_IDS")
      : (() => {
          const v = process.env.ROOT_ADMIN_USER_IDS;
          if (!v || String(v).trim() === "") {
            throw new Error("Missing required environment variable: ROOT_ADMIN_USER_IDS");
          }
          return parseCsvEnv("ROOT_ADMIN_USER_IDS");
        })()
    : parseCsvEnv("ROOT_ADMIN_USER_IDS");

// Session token lifetimes (seconds) — constants as in original
const SESSION_ACCESS_TTL_SEC = 60 * 30; // 30 minutes
const SESSION_REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

// Session JWT claims
const SESSION_ISSUER = "hakmun-api";
const SESSION_AUDIENCE = "hakmun-client";

/* ------------------------------------------------------------------
   EPIC A0 — Admin Safety Invariants
------------------------------------------------------------------ */
let _adminSafetyNextCheckAtMs = 0;

function isPinnedRootAdmin(userID) {
  return ROOT_ADMIN_USER_IDS.includes(String(userID));
}

async function promoteToRootAdminNonFatal(userID, reason) {
  try {
    const { rows } = await pool.query(
      `
      select is_admin, is_root_admin
      from users
      where user_id = $1
      limit 1
      `,
      [userID]
    );

    const current = rows?.[0];
    if (!current) return;

    const needsAdmin = !Boolean(current.is_admin);
    const needsRoot = !Boolean(current.is_root_admin);
    if (!needsAdmin && !needsRoot) return;

    await pool.query(
      `
      update users
      set is_root_admin = true,
          is_admin = true
      where user_id = $1
      `,
      [userID]
    );

    logger.info("[admin-safety] promoted root admin", { userID, reason });
  } catch (err) {
    logger.error("[admin-safety] failed to promote root admin", {
      code: err?.code,
      err: err?.detail || err?.message || String(err)
    });
  }
}

async function ensurePinnedRootAdminsNonFatal() {
  if (!ROOT_ADMIN_USER_IDS.length) return;
  for (const uid of ROOT_ADMIN_USER_IDS) {
    await promoteToRootAdminNonFatal(uid, "pinned-self-heal");
  }
}

async function ensureAtLeastOneRootAdminNonFatal(trigger) {
  const now = Date.now();
  if (now < _adminSafetyNextCheckAtMs) return;
  _adminSafetyNextCheckAtMs = now + 30_000;

  try {
    const { rows } = await pool.query(
      `
      select count(*)::int as c
      from users
      where is_root_admin = true and is_active = true
      `
    );

    const c = rows?.[0]?.c ?? 0;
    if (c > 0) {
      await ensurePinnedRootAdminsNonFatal();
      return;
    }

    logger.error("[admin-safety] ZERO active root admins detected", { trigger });

    if (ROOT_ADMIN_USER_IDS.length) {
      await ensurePinnedRootAdminsNonFatal();

      const after = await pool.query(
        `
        select count(*)::int as c
        from users
        where is_root_admin = true and is_active = true
        `
      );

      const c2 = after.rows?.[0]?.c ?? 0;
      if (c2 > 0) return;
    }

    logger.error(
      "[admin-safety] CRITICAL: cannot restore root admin in production without pinned IDs"
    );
  } catch (err) {
    logger.error("[admin-safety] ensureAtLeastOneRootAdminNonFatal failed", {
      code: err?.code,
      err: err?.detail || err?.message || String(err)
    });
  }
}

/* ------------------------------------------------------------------
   Touch last_seen_at
------------------------------------------------------------------ */
async function touchLastSeen(userID) {
  // NOTE: This is a known hot-row write. If it becomes a contention source again,
  // move to an event log table (future hardening epic).
  await pool.query(
    `
    update users
    set last_seen_at = now()
    where user_id = $1
    `,
    [userID]
  );
}

/* ------------------------------------------------------------------
   EPIC 3.2 — Entitlements (server-authoritative)
   - Clients MUST NOT infer capabilities.
------------------------------------------------------------------ */
function computeEntitlementsFromUser(user) {
  const role = String(user?.role || "student");
  const isActive = Boolean(user?.isActive);
  const isRootAdmin = Boolean(user?.isRootAdmin);
  const isAdmin = Boolean(user?.isAdmin);

  // Fail-closed: inactive users have no entitlements.
  if (!isActive) {
    return {
      entitlements: [],
      capabilities: {
        canUseApp: false,
        canAccessTeacherTools: false,
        canApproveContent: false,
        canAdminUsers: false,
        canManageRoles: false,
        canManageActivation: false
      }
    };
  }

  const canAccessTeacherTools = role === "teacher" || role === "approver";
  const canApproveContent = role === "approver";
  const adminAllowed = isRootAdmin;

  const entitlements = [];

  // Baseline capability: the user can use the app if they are active.
  entitlements.push("app:use");

  if (canAccessTeacherTools) entitlements.push("teacher:tools");
  if (canApproveContent) entitlements.push("approver:content");

  if (adminAllowed) {
    entitlements.push("admin:users:read");
    entitlements.push("admin:users:write");
  }

  if (isAdmin) entitlements.push("flag:is_admin");
  if (isRootAdmin) entitlements.push("flag:is_root_admin");

  const capabilities = {
    canUseApp: true,
    canAccessTeacherTools,
    canApproveContent,
    canAdminUsers: adminAllowed,
    canManageRoles: adminAllowed,
    canManageActivation: adminAllowed
  };

  return { entitlements, capabilities };
}

function requireEntitlement(entitlement) {
  return function (req, res, next) {
    const ents = req.user?.entitlements || [];
    if (!Array.isArray(ents) || !ents.includes(entitlement)) {
      return res.status(403).json({ error: "insufficient entitlement" });
    }
    return next();
  };
}

function requireRole(...roles) {
  return function (req, res, next) {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: "insufficient role", required: roles });
    }
    return next();
  };
}

/* ------------------------------------------------------------------
   User state (role/admin flags)
------------------------------------------------------------------ */
async function getUserState(userID) {
  await ensureAtLeastOneRootAdminNonFatal("getUserState");

  if (isPinnedRootAdmin(userID)) {
    await promoteToRootAdminNonFatal(userID, "pinned-read-path");
  }

  const { rows } = await pool.query(
    `
    select role, is_admin, is_root_admin, is_active, display_name,
           primary_language, gloss_language,
           customize_learning, share_progress_default, allow_teacher_adjust_default,
           location_city, location_country, share_city, share_country,
           cefr_current, cefr_target
    from users
    where user_id = $1
    limit 1
    `,
    [userID]
  );

  return (
    rows?.[0] || {
      role: "student",
      is_admin: false,
      is_root_admin: false,
      is_active: true
    }
  );
}

/* ------------------------------------------------------------------
   HakMun session tokens (JWT)
------------------------------------------------------------------ */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

async function issueSessionTokens({ userID }) {
  const iat = nowSeconds();

  const accessToken = await new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(String(userID))
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_ACCESS_TTL_SEC)
    .sign(Buffer.from(SESSION_JWT_SECRET));

  const refreshToken = await new SignJWT({ typ: "refresh" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(String(userID))
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_REFRESH_TTL_SEC)
    .sign(Buffer.from(SESSION_JWT_SECRET));

  return {
    accessToken,
    expiresIn: SESSION_ACCESS_TTL_SEC,
    refreshToken,
    refreshExpiresIn: SESSION_REFRESH_TTL_SEC
  };
}

async function verifySessionJWT(token) {
  const { payload } = await jwtVerify(token, Buffer.from(SESSION_JWT_SECRET), {
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE
  });

  const userID = payload.sub;
  if (!userID) throw new Error("session token missing sub");

  const typ = payload.typ;
  if (typ !== "access" && typ !== "refresh") {
    throw new Error(`invalid session token typ: ${String(typ)}`);
  }

  return { userID: String(userID), typ };
}

async function requireSession(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) return res.status(401).json({ error: "missing session token" });

    const decoded = await verifySessionJWT(token);
    if (decoded.typ !== "access") {
      return res.status(401).json({ error: "access token required" });
    }

    const state = await getUserState(decoded.userID);
    const isActive = Boolean(state.is_active);
    if (!isActive) return res.status(403).json({ error: "account disabled" });

    const user = {
      userID: decoded.userID,
      role: state.role,
      isAdmin: Boolean(state.is_admin),
      isRootAdmin: Boolean(state.is_root_admin),
      isActive,
      isTeacher: String(state.role || "student") === "teacher",
      displayName: state.display_name || null,
      // Preferences
      primaryLanguage: state.primary_language || "en",
      glossLanguage: state.gloss_language || "en",
      customizeLearning: Boolean(state.customize_learning),
      shareProgressDefault: Boolean(state.share_progress_default),
      allowTeacherAdjustDefault: Boolean(state.allow_teacher_adjust_default),
      locationCity: state.location_city || null,
      locationCountry: state.location_country || null,
      shareCity: Boolean(state.share_city),
      shareCountry: Boolean(state.share_country),
      cefrCurrent: state.cefr_current || "A1",
      cefrTarget: state.cefr_target || null
    };

    const { entitlements, capabilities } = computeEntitlementsFromUser(user);

    req.user = {
      ...user,
      entitlements,
      capabilities
    };

    return next();
  } catch (err) {
    logger.error("[session] Session auth error", { rid: req._rid, err: err?.message || String(err) });
    return res.status(401).json({ error: "invalid session" });
  }
}

module.exports = {
  // middleware
  requireSession,

  // jwt helpers
  extractBearerToken,
  verifySessionJWT,
  issueSessionTokens,

  // state + entitlements
  getUserState,
  computeEntitlementsFromUser,
  requireEntitlement,
  requireRole,

  // admin safety
  ensureAtLeastOneRootAdminNonFatal,
  isPinnedRootAdmin,

  // misc helpers used by auth/apple flow
  touchLastSeen,

  // constants (exported only if route modules want them later; no behavior change)
  SESSION_ISSUER,
  SESSION_AUDIENCE,
  SESSION_ACCESS_TTL_SEC,
  SESSION_REFRESH_TTL_SEC
};