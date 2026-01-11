// server.js — HakMun API (v0.11)
// Canonical identity + handles + secure private asset storage (signed URLs)
//
// Identity:
// - Canonical user key: users.user_id (UUID)
// - auth_identities maps (provider, subject, audience) -> user_id
// - Apple `sub` is auth identity (subject), not a data key.
//
// Handles:
// - user_handles is keyed by user_id
// - handle globally unique (CITEXT PK)
// - aliases resolve to primary_handle
//
// Legacy:
// - user_profiles is still keyed by apple_user_id (legacy).
// - Legacy profile writes are best-effort and MUST NOT break auth.
//
// Secure assets:
// - Store profile photos privately in Railway bucket
// - Expose read access via signed URLs (time-limited)
//
// EPIC A0 — ADMIN SAFETY INVARIANTS (MANDATORY):
// - At least one ROOT ADMIN MUST always exist.
// - Root admin identity is pinned by users.user_id.
// - Server MUST self-heal admin flags on session validation / whoami.
// - It MUST be impossible to lose all admin access under any circumstance.

const express = require("express");
const OpenAI = require("openai");
const { createRemoteJWKSet, jwtVerify, SignJWT } = require("jose");
const { Pool } = require("pg");

// Secure object storage (S3-compatible)
const multer = require("multer");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.use(express.json());

/* ------------------------------------------------------------------
   Hard config guardrails (fail fast)
------------------------------------------------------------------ */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function parseCsvEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const APPLE_CLIENT_IDS = requireEnv("APPLE_CLIENT_IDS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DATABASE_URL = requireEnv("DATABASE_URL");

const SESSION_JWT_SECRET = requireEnv("SESSION_JWT_SECRET");

// EPIC A0: Root admin must be pinned by user_id in production.
const NODE_ENV = process.env.NODE_ENV || "<unset>";
const ROOT_ADMIN_USER_IDS =
  NODE_ENV === "production"
    ? parseCsvEnv("ROOT_ADMIN_USER_IDS").length
      ? parseCsvEnv("ROOT_ADMIN_USER_IDS")
      : (() => {
          // Fail-fast: do not allow production to boot without a pinned root admin set.
          requireEnv("ROOT_ADMIN_USER_IDS");
          return parseCsvEnv("ROOT_ADMIN_USER_IDS");
        })()
    : parseCsvEnv("ROOT_ADMIN_USER_IDS");

// Session token lifetimes (seconds)
const SESSION_ACCESS_TTL_SEC = 60 * 30; // 30 minutes
const SESSION_REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

// Session JWT claims
const SESSION_ISSUER = "hakmun-api";
const SESSION_AUDIENCE = "hakmun-client";

// OPENAI is optional unless you call generation endpoints.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ------------------------------------------------------------------
   Safe boot logging (no secrets)
------------------------------------------------------------------ */
function safeDbHost(url) {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

console.log("[boot] HakMun API starting");
console.log("[boot] NODE_ENV =", NODE_ENV);
console.log("[boot] APPLE_CLIENT_IDS =", APPLE_CLIENT_IDS.join(", "));
console.log("[boot] DATABASE_URL host =", safeDbHost(DATABASE_URL));
console.log("[boot] SESSION_JWT_SECRET set =", Boolean(SESSION_JWT_SECRET));
console.log("[boot] OPENAI_API_KEY set =", Boolean(OPENAI_API_KEY));
console.log(
  "[boot] ROOT_ADMIN_USER_IDS set =",
  ROOT_ADMIN_USER_IDS.length ? `${ROOT_ADMIN_USER_IDS.length} pinned` : "none"
);

/* ------------------------------------------------------------------
   OpenAI (server-side only)
------------------------------------------------------------------ */
const openai =
  OPENAI_API_KEY && String(OPENAI_API_KEY).trim()
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

/* ------------------------------------------------------------------
   Postgres (Railway)
------------------------------------------------------------------ */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

/* ------------------------------------------------------------------
   Apple Sign In verification
------------------------------------------------------------------ */
const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

async function verifyAppleToken(identityToken) {
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: "https://appleid.apple.com",
    audience: APPLE_CLIENT_IDS
  });

  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (!aud || !APPLE_CLIENT_IDS.includes(aud)) {
    throw new Error(`Apple token audience not allowed: ${String(aud)}`);
  }
  if (!payload.sub) {
    throw new Error("Apple token missing subject (sub)");
  }

  return { appleSubject: payload.sub, audience: aud };
}

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */
function normalizeHandle(handle) {
  return String(handle || "").trim();
}

function isValidHandle(handle) {
  // 2–24 chars: letters, numbers, underscore, dot, hyphen, Hangul
  return /^[\w.\-가-힣]{2,24}$/.test(handle);
}

function safeMimeType(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (!m) return "image/jpeg";
  if (m === "image/jpeg" || m === "image/jpg") return "image/jpeg";
  if (m === "image/png") return "image/png";
  if (m === "image/webp") return "image/webp";
  if (m === "image/heic" || m === "image/heif") return "image/heic";
  // Default to jpeg to avoid weird content-types.
  return "image/jpeg";
}

/* ------------------------------------------------------------------
   EPIC A0 — Admin Safety Invariants
------------------------------------------------------------------ */

// Small in-memory guard to avoid excessive global checks under load.
let _adminSafetyNextCheckAtMs = 0;

function isPinnedRootAdmin(userID) {
  return ROOT_ADMIN_USER_IDS.includes(String(userID));
}

// Idempotent promotion:
// - Only updates if flags are not already correct
// - Only logs when it actually changed something
async function promoteToRootAdminNonFatal(userID, reason) {
  try {
    // 1) Read current flags
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

    // 2) If already correct, do nothing (prevents log spam)
    if (!needsAdmin && !needsRoot) return;

    // 3) Fix flags
    await pool.query(
      `
      update users
      set is_root_admin = true,
          is_admin = true
      where user_id = $1
      `,
      [userID]
    );

    console.log(
      `[admin-safety] promoted root admin user_id=${userID} reason=${reason}`
    );
  } catch (err) {
    console.error(
      "[admin-safety] failed to promote root admin:",
      err?.code,
      err?.detail || err?.message
    );
  }
}

async function ensurePinnedRootAdminsNonFatal() {
  if (!ROOT_ADMIN_USER_IDS.length) return;

  // Ensure every pinned root admin is at least admin+root_admin (idempotent).
  for (const uid of ROOT_ADMIN_USER_IDS) {
    await promoteToRootAdminNonFatal(uid, "pinned-self-heal");
  }
}

async function ensureAtLeastOneRootAdminNonFatal(trigger) {
  // Throttle global scan to at most once per 30 seconds.
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
      // Still ensure pinned root admins are never accidentally demoted.
      await ensurePinnedRootAdminsNonFatal();
      return;
    }

    console.error(
      `[admin-safety] ZERO active root admins detected (trigger=${trigger}). Initiating self-heal.`
    );

    // Primary self-heal path: pinned list.
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

      console.error(
        "[admin-safety] pinned self-heal did not restore a root admin (pinned IDs may not exist in users table)."
      );
    }

    // NON-PRODUCTION fallback only: deterministically promote a user to avoid total lockout.
    if (NODE_ENV !== "production") {
      // Prefer earliest created_at if available; fall back to user_id ordering.
      let candidate = null;

      try {
        const r1 = await pool.query(
          `
          select user_id
          from users
          where is_active = true
          order by created_at asc nulls last, user_id asc
          limit 1
          `
        );
        candidate = r1.rows?.[0]?.user_id || null;
      } catch {
        const r2 = await pool.query(
          `
          select user_id
          from users
          where is_active = true
          order by user_id asc
          limit 1
          `
        );
        candidate = r2.rows?.[0]?.user_id || null;
      }

      if (candidate) {
        await promoteToRootAdminNonFatal(candidate, "dev-fallback-zero-root");
        return;
      }

      console.error(
        "[admin-safety] dev fallback failed: no active users to promote."
      );
    }

    // Production must never reach here because ROOT_ADMIN_USER_IDS is required.
    console.error(
      "[admin-safety] CRITICAL: cannot restore root admin in production without pinned IDs."
    );
  } catch (err) {
    console.error(
      "[admin-safety] ensureAtLeastOneRootAdminNonFatal failed:",
      err?.code,
      err?.detail || err?.message
    );
  }
}

/* ------------------------------------------------------------------
   Legacy profile helpers (NON-FATAL)
------------------------------------------------------------------ */
async function ensureLegacyUserProfileNonFatal(appleUserID) {
  // Legacy storage: user_profiles keyed by apple_user_id.
  // IMPORTANT: This must NEVER block auth (FK constraints may exist).
  try {
    await pool.query(
      `
      insert into user_profiles (apple_user_id, schema_version, settings_json)
      values ($1, 1, '{}'::jsonb)
      on conflict (apple_user_id) do nothing
      `,
      [appleUserID]
    );
  } catch (err) {
    console.warn(
      "[warn] ensureLegacyUserProfileNonFatal failed (continuing):",
      err?.code,
      err?.detail || err?.message
    );
  }
}

async function touchLastSeen(userID) {
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
   Canonical identity resolution
------------------------------------------------------------------ */
async function resolveUserIDFromIdentity({ provider, subject, audience }) {
  const { rows } = await pool.query(
    `
    select user_id
    from auth_identities
    where provider = $1 and subject = $2 and audience = $3
    limit 1
    `,
    [provider, subject, audience]
  );
  return rows && rows.length ? rows[0].user_id : null;
}

async function ensureCanonicalUser({ appleSubject, audience }) {
  // 1) Resolve via auth_identities
  const userID = await resolveUserIDFromIdentity({
    provider: "apple",
    subject: appleSubject,
    audience
  });

  if (userID) {
    await ensureLegacyUserProfileNonFatal(appleSubject);
    await touchLastSeen(userID);
    return userID;
  }

  // 2) Not found -> reuse users row by apple_user_id OR create one, then bind identity
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `
      select user_id
      from users
      where apple_user_id = $1
      limit 1
      `,
      [appleSubject]
    );

    let canonicalUserID;
    if (existing.rows && existing.rows.length) {
      canonicalUserID = existing.rows[0].user_id;
    } else {
      const created = await client.query(
        `
        insert into users (user_id, apple_user_id, last_seen_at)
        values (gen_random_uuid(), $1, now())
        returning user_id
        `,
        [appleSubject]
      );
      canonicalUserID = created.rows[0].user_id;
    }

    await client.query(
      `
      insert into auth_identities (provider, subject, audience, user_id)
      values ('apple', $1, $2, $3)
      on conflict do nothing
      `,
      [appleSubject, audience, canonicalUserID]
    );

    // Best-effort legacy profile insert (same transaction)
    try {
      await client.query(
        `
        insert into user_profiles (apple_user_id, schema_version, settings_json)
        values ($1, 1, '{}'::jsonb)
        on conflict (apple_user_id) do nothing
        `,
        [appleSubject]
      );
    } catch (err) {
      console.warn(
        "[warn] (tx) legacy user_profiles insert failed (continuing):",
        err?.code,
        err?.detail || err?.message
      );
    }

    await client.query("COMMIT");
    await touchLastSeen(canonicalUserID);
    return canonicalUserID;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------
   User state (role/admin flags) — server authoritative + admin safety self-heal
------------------------------------------------------------------ */
async function getUserState(userID) {
  // EPIC A0: global self-heal guardrails (throttled).
  await ensureAtLeastOneRootAdminNonFatal("getUserState");

  // EPIC A0: pinned root admin must always remain admin/root_admin.
  if (isPinnedRootAdmin(userID)) {
    await promoteToRootAdminNonFatal(userID, "pinned-read-path");
  }

  const { rows } = await pool.query(
    `
    select role, is_admin, is_root_admin, is_active
    from users
    where user_id = $1
    limit 1
    `,
    [userID]
  );

  // Be defensive: should always exist
  return rows?.[0] || {
    role: "student",
    is_admin: false,
    is_root_admin: false,
    is_active: true
  };
}

/* ------------------------------------------------------------------
   Canonical profile facts (v2)
   - NO local profile.
   - Username/handle is server-authoritative.
------------------------------------------------------------------ */
async function getPrimaryHandleForUser(userID) {
  const { rows } = await pool.query(
    `
    select handle
    from user_handles
    where user_id = $1 and kind = 'primary'
    limit 1
    `,
    [userID]
  );
  return rows?.[0]?.handle || null;
}

/* ------------------------------------------------------------------
   HakMun session tokens (JWT)
   - Apple identityToken is verified ONLY during exchange.
   - Steady-state requests verify HakMun session JWTs.
   - Session tokens do NOT depend on Apple claims.
------------------------------------------------------------------ */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function requireJsonField(req, res, fieldName) {
  const v = req.body?.[fieldName];
  if (!v || String(v).trim() === "") {
    res.status(400).json({ error: `${fieldName} is required` });
    return null;
  }
  return String(v);
}

async function issueSessionTokens({ userID }) {
  const iat = nowSeconds();

  const accessToken = await new SignJWT({
    typ: "access"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(String(userID))
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_ACCESS_TTL_SEC)
    .sign(Buffer.from(SESSION_JWT_SECRET));

  const refreshToken = await new SignJWT({
    typ: "refresh"
  })
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
  // Session JWTs are signed (HS256). No JWKS / Apple verification here.
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

  return { userID, typ };
}

async function requireSession(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "missing session token" });
    }

    const decoded = await verifySessionJWT(token);
    if (decoded.typ !== "access") {
      return res.status(401).json({ error: "access token required" });
    }

    const state = await getUserState(decoded.userID);
    const isActive = Boolean(state.is_active);
    if (!isActive) {
      return res.status(403).json({ error: "account disabled" });
    }

    req.user = {
      userID: decoded.userID,
      role: state.role,
      isAdmin: Boolean(state.is_admin),
      isRootAdmin: Boolean(state.is_root_admin),
      isActive
    };

    return next();
  } catch (err) {
    console.error("Session auth error:", err);
    return res.status(401).json({ error: "invalid session" });
  }
}

/* ------------------------------------------------------------------
   Auth middleware (LEGACY: Apple identityToken per request)
------------------------------------------------------------------ */
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "missing authorization token" });
    }

    const token = header.slice("Bearer ".length);
    const { appleSubject, audience } = await verifyAppleToken(token);

    const userID = await ensureCanonicalUser({ appleSubject, audience });

    // Read user state flags (now includes EPIC A0 self-heal)
    const state = await getUserState(userID);

    req.user = {
      userID,
      appleUserID: appleSubject,
      audience,

      role: state.role,
      isAdmin: Boolean(state.is_admin),
      isRootAdmin: Boolean(state.is_root_admin),
      isActive: Boolean(state.is_active)
    };

    return next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "authentication failed" });
  }
}

/* ------------------------------------------------------------------
   Auth middleware (HYBRID)
   Accept either:
   - HakMun session access token (preferred steady-state)
   - Apple identityToken (legacy/back-compat only)
------------------------------------------------------------------ */
async function requireSessionOrApple(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "missing authorization token" });
    }

    const token = header.slice("Bearer ".length);

    // 1) Try HakMun session first
    try {
      const decoded = await verifySessionJWT(token);
      if (decoded.typ !== "access") {
        return res.status(401).json({ error: "access token required" });
      }

      const state = await getUserState(decoded.userID);
      const isActive = Boolean(state.is_active);
      if (!isActive) {
        return res.status(403).json({ error: "account disabled" });
      }

      req.user = {
        userID: decoded.userID,
        role: state.role,
        isAdmin: Boolean(state.is_admin),
        isRootAdmin: Boolean(state.is_root_admin),
        isActive
      };

      return next();
    } catch {
      // fall through to Apple
    }

    // 2) Fall back to Apple identity token (legacy only)
    const { appleSubject, audience } = await verifyAppleToken(token);
    const userID = await ensureCanonicalUser({ appleSubject, audience });
    const state = await getUserState(userID);

    req.user = {
      userID,
      appleUserID: appleSubject,
      audience,

      role: state.role,
      isAdmin: Boolean(state.is_admin),
      isRootAdmin: Boolean(state.is_root_admin),
      isActive: Boolean(state.is_active)
    };

    return next();
  } catch (err) {
    console.error("Hybrid auth error:", err);
    return res.status(401).json({ error: "authentication failed" });
  }
}

/* ------------------------------------------------------------------
   Secure object storage (Railway bucket, S3-compatible)
------------------------------------------------------------------ */
function storageConfigured() {
  return Boolean(
    process.env.OBJECT_STORAGE_ENDPOINT &&
      process.env.OBJECT_STORAGE_BUCKET &&
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

function requireStorageOr503(res) {
  if (!storageConfigured()) {
    return res.status(503).json({ error: "object storage not configured" });
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT, // e.g. https://storage.railway.app
    region: process.env.OBJECT_STORAGE_REGION || "auto",
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
    },
    forcePathStyle: true
  });
}

function bucketName() {
  return process.env.OBJECT_STORAGE_BUCKET;
}

/* ------------------------------------------------------------------
   Health check
------------------------------------------------------------------ */
app.get("/", (req, res) => res.send("hakmun-api up"));

/* ------------------------------------------------------------------
   GET /v1/auth/whoami  (LEGACY)
------------------------------------------------------------------ */
app.get("/v1/auth/whoami", requireUser, async (req, res) => {
  return res.json(req.user);
});

/* ------------------------------------------------------------------
   POST /v1/auth/apple
   Exchange Apple identityToken for HakMun session tokens.
------------------------------------------------------------------ */
app.post("/v1/auth/apple", async (req, res) => {
  try {
    const identityToken = requireJsonField(req, res, "identityToken");
    if (!identityToken) return;

    const { appleSubject, audience } = await verifyAppleToken(identityToken);
    const userID = await ensureCanonicalUser({ appleSubject, audience });

    const state = await getUserState(userID);
    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    const tokens = await issueSessionTokens({ userID });

    return res.json({
      ...tokens,
      user: {
        userID,
        appleUserID: appleSubject,
        audience,
        role: state.role,
        isAdmin: Boolean(state.is_admin),
        isRootAdmin: Boolean(state.is_root_admin),
        isActive: Boolean(state.is_active)
      }
    });
  } catch (err) {
    console.error("/v1/auth/apple failed:", err);
    return res.status(401).json({ error: "authentication failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/session/refresh
   Exchange refresh token for a new access token (and rotated refresh).
------------------------------------------------------------------ */
app.post("/v1/session/refresh", async (req, res) => {
  try {
    const refreshToken = requireJsonField(req, res, "refreshToken");
    if (!refreshToken) return;

    const decoded = await verifySessionJWT(refreshToken);
    if (decoded.typ !== "refresh") {
      return res.status(401).json({ error: "refresh token required" });
    }

    const state = await getUserState(decoded.userID);
    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    // Rotate refresh token to reduce replay window.
    const tokens = await issueSessionTokens({ userID: decoded.userID });
    return res.json(tokens);
  } catch (err) {
    console.error("/v1/session/refresh failed:", err);
    return res.status(401).json({ error: "refresh failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/session/whoami
   Steady-state whoami (requires HakMun session access token).
   Includes canonical profile facts to support client gating.
------------------------------------------------------------------ */
app.get("/v1/session/whoami", requireSession, async (req, res) => {
  try {
    // EPIC A0: self-heal on whoami explicitly (even though requireSession already hit getUserState)
    await ensureAtLeastOneRootAdminNonFatal("whoami");

    const primaryHandle = await getPrimaryHandleForUser(req.user.userID);
    const profileComplete = Boolean(primaryHandle && String(primaryHandle).trim());

    // Canonical keys:
    // - profileComplete
    // - primaryHandle
    //
    // Back-compat alias:
    // - username (deprecated; mirrors primaryHandle)
    return res.json({
      ...req.user,
      profileComplete,
      primaryHandle,
      username: primaryHandle
    });
  } catch (err) {
    console.error("/v1/session/whoami failed:", err);
    return res.status(500).json({ error: "whoami failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/profile  (v2, canonical)
   Requires HakMun session access token.
   Server-authoritative profile facts only (no local profile).
------------------------------------------------------------------ */
app.get("/v1/profile", requireSession, async (req, res) => {
  try {
    const primaryHandle = await getPrimaryHandleForUser(req.user.userID);
    const profileComplete = Boolean(primaryHandle && String(primaryHandle).trim());

    return res.json({
      user: req.user,
      profile: {
        primaryHandle,
        profileComplete,
        username: primaryHandle // deprecated alias
      }
    });
  } catch (err) {
    console.error("/v1/profile failed:", err);
    return res.status(500).json({ error: "profile failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/me
   (legacy profile storage still keyed by apple_user_id)
------------------------------------------------------------------ */
app.get("/v1/me", requireUser, async (req, res) => {
  const { appleUserID, userID } = req.user;

  const result = await pool.query(
    `
    select apple_user_id, schema_version, settings_json, updated_at
    from user_profiles
    where apple_user_id = $1
    `,
    [appleUserID]
  );

  return res.json({
    userID,
    appleUserID,
    profile: result.rows[0] || null
  });
});

/* ------------------------------------------------------------------
   PUT /v1/me/profile
------------------------------------------------------------------ */
app.put("/v1/me/profile", requireUser, async (req, res) => {
  const { appleUserID } = req.user;
  const updates = req.body || {};

  await pool.query(
    `
    update user_profiles
    set settings_json = $2,
        updated_at = now()
    where apple_user_id = $1
    `,
    [appleUserID, updates]
  );

  return res.json({ ok: true });
});

/* ------------------------------------------------------------------
   EPIC M1 — Canonical profile photo metadata (users table)
   - Runtime authority is users.profile_photo_object_key (keyed by users.user_id)
   - Legacy user_profiles.settings_json profilePhotoKey is migration-only
------------------------------------------------------------------ */
async function getCanonicalProfilePhotoKey(userID) {
  const { rows } = await pool.query(
    `
    select profile_photo_object_key as key
    from users
    where user_id = $1
    limit 1
    `,
    [userID]
  );
  return rows?.[0]?.key || null;
}

async function setCanonicalProfilePhotoKey(userID, objectKey) {
  await pool.query(
    `
    update users
    set profile_photo_object_key = $2,
        profile_photo_updated_at = now()
    where user_id = $1
    `,
    [userID, objectKey]
  );
}

async function clearCanonicalProfilePhotoKey(userID) {
  await pool.query(
    `
    update users
    set profile_photo_object_key = null,
        profile_photo_updated_at = now()
    where user_id = $1
    `,
    [userID]
  );
}

/* ------------------------------------------------------------------
   PUT /v1/me/profile-photo  (PRIVATE object upload)
   multipart/form-data field: photo
   Canonical storage:
     users.profile_photo_object_key
     users.profile_photo_updated_at
------------------------------------------------------------------ */
app.put(
  "/v1/me/profile-photo",
  requireUser,
  upload.single("photo"),
  async (req, res) => {
    const maybe = requireStorageOr503(res);
    if (maybe) return;

    try {
      if (!req.file) {
        return res.status(400).json({ error: "photo file required" });
      }

      const { userID } = req.user;

      // Stable base key (user-scoped). Overwrites are ok.
      const keyBase = `users/${userID}/profile`;

      // Choose extension based on content-type where possible.
      const contentType = safeMimeType(req.file.mimetype);
      const ext =
        contentType === "image/png"
          ? "png"
          : contentType === "image/webp"
          ? "webp"
          : contentType === "image/heic"
          ? "heic"
          : "jpg";

      const objectKey = `${keyBase}.${ext}`;

      const s3 = makeS3Client();

      // Upload/overwrite object. No separate delete needed.
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: req.file.buffer,
          ContentType: contentType,
          CacheControl: "no-store"
        })
      );

      // EPIC M1: store key ONLY in canonical users table (NO legacy writes)
      await setCanonicalProfilePhotoKey(userID, objectKey);

      return res.json({ ok: true });
    } catch (err) {
      console.error("profile-photo upload failed:", err);
      return res.status(500).json({ error: "upload failed" });
    }
  }
);

/* ------------------------------------------------------------------
   DELETE /v1/me/profile-photo  (PRIVATE object delete + DB clear)
   Canonical storage:
     users.profile_photo_object_key
     users.profile_photo_updated_at
------------------------------------------------------------------ */
app.delete("/v1/me/profile-photo", requireUser, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const { userID } = req.user;

    // 1) Fetch current canonical key
    const key = await getCanonicalProfilePhotoKey(userID);
    if (!key) {
      // Nothing to delete (already removed)
      return res.json({ ok: true });
    }

    // 2) Delete from bucket (ignore if missing)
    const s3 = makeS3Client();
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketName(),
          Key: key
        })
      );
    } catch (err) {
      // If object delete fails, still clear DB so UI is consistent;
      // log for investigation.
      console.error("profile-photo delete object failed:", err);
    }

    // 3) Clear canonical fields (NO legacy writes)
    await clearCanonicalProfilePhotoKey(userID);

    return res.json({ ok: true });
  } catch (err) {
    console.error("profile-photo delete failed:", err);
    return res.status(500).json({ error: "delete failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/me/profile-photo-url  (SIGNED URL)
   Returns time-limited URL to the private object.
   Canonical storage:
     users.profile_photo_object_key
     users.profile_photo_updated_at
------------------------------------------------------------------ */
app.get("/v1/me/profile-photo-url", requireUser, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const { userID } = req.user;

    const key = await getCanonicalProfilePhotoKey(userID);
    if (!key) {
      return res.status(404).json({ error: "no profile photo" });
    }

    const s3 = makeS3Client();
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: key
      }),
      { expiresIn: 60 * 15 } // 15 minutes
    );

    return res.json({ url, expiresIn: 900 });
  } catch (err) {
    console.error("profile-photo-url failed:", err);
    return res.status(500).json({ error: "failed to sign url" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/handles/me
   NOTE: supports HakMun session (steady-state) and Apple (legacy).
------------------------------------------------------------------ */
app.get("/v1/handles/me", requireSessionOrApple, async (req, res) => {
  const { userID } = req.user;

  try {
    const { rows } = await pool.query(
      `
      select handle, kind, primary_handle, created_at
      from user_handles
      where user_id = $1 and kind = 'primary'
      limit 1
      `,
      [userID]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "no username set" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("handles/me failed:", err);
    return res.status(500).json({ error: "resolve failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/handles/reserve
   NOTE: supports HakMun session (steady-state) and Apple (legacy).
------------------------------------------------------------------ */
app.post("/v1/handles/reserve", requireSessionOrApple, async (req, res) => {
  const { userID } = req.user;

  const handle = normalizeHandle(req.body?.handle ?? req.body?.username);

  if (!handle) {
    return res.status(400).json({ error: "handle is required" });
  }
  if (!isValidHandle(handle)) {
    return res.status(400).json({
      error:
        "Invalid username. Use 2–24 characters: letters, numbers, underscore, dot, hyphen, or Hangul."
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
      insert into user_handles (handle, user_id, kind, primary_handle)
      values ($1, $2, 'primary', $1)
      `,
      [handle, userID]
    );

    await client.query("COMMIT");

    return res.json({
      handle,
      kind: "primary",
      primary_handle: handle
    });
  } catch (err) {
    await client.query("ROLLBACK");

    if (err && err.code === "23505") {
      return res.status(409).json({ error: "username already taken" });
    }

    console.error("reserve handle failed:", err);
    return res.status(500).json({ error: "reserve failed" });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------
   GET /v1/handles/resolve?handle=vernon
   NOTE: supports HakMun session (steady-state) and Apple (legacy).
------------------------------------------------------------------ */
app.get("/v1/handles/resolve", requireSessionOrApple, async (req, res) => {
  const handle = normalizeHandle(req.query?.handle);

  if (!handle) {
    return res.status(400).json({ error: "handle is required" });
  }

  try {
    const { rows } = await pool.query(
      `
      select handle, kind, primary_handle
      from user_handles
      where handle = $1
      `,
      [handle]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "username not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("resolve handle failed:", err);
    return res.status(500).json({ error: "resolve failed" });
  }
});

/* ------------------------------------------------------------------
   Sentence validation (stub)
------------------------------------------------------------------ */
app.post("/v1/validate/sentence", requireUser, (req, res) => {
  const { sentenceID, text } = req.body || {};

  if (!sentenceID || !text) {
    return res.status(400).json({
      verdict: "NEEDS_REVIEW",
      reason: "missing sentenceID or text"
    });
  }

  return res.json({
    verdict: "OK",
    reason: ""
  });
});

/* ------------------------------------------------------------------
   Sentence generation (global worker for now)
------------------------------------------------------------------ */
app.post("/v1/generate/sentences", requireUser, async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({ error: "OpenAI is not configured" });
    }

    const { tier, count } = req.body || {};

    if (!count || typeof count !== "number" || count < 1 || count > 30) {
      return res.status(400).json({
        error: "count must be a number between 1 and 30"
      });
    }

    const safeTier =
      tier === "intermediate" || tier === "advanced" ? tier : "beginner";

    const prompt = `
You generate Korean typing practice sentences for a language-learning app.

Return ONLY valid JSON. Do not include explanations or markdown.

The JSON MUST have this shape:

{
  "generatorVersion": "string",
  "sentences": [
    {
      "id": "string",
      "ko": "string",
      "literal": "string | null",
      "natural": "string | null",
      "naturalnessScore": number (0 to 1)
    }
  ]
}

Rules:
- Generate exactly ${count} unique sentences.
- Tier: ${safeTier}.
- Sentences must be natural, realistic Korean.
- Each sentence must be complete and properly punctuated.
- Avoid unsafe content.
- Use stable IDs like GEN_A1B2C3D4.
- naturalnessScore is your self-evaluation (higher = more natural)
`.trim();

    const r = await openai.responses.create({
      model: "gpt-5.2",
      input: prompt,
      text: { format: { type: "json_object" } }
    });

    const payload = JSON.parse(r.output_text);
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "generation failed" });
  }
});

/* ------------------------------------------------------------------
   Boot-time EPIC A0 validation + Start server (Railway)
------------------------------------------------------------------ */
(async () => {
  // EPIC A0: enforce invariants as early as possible.
  await ensureAtLeastOneRootAdminNonFatal("boot");

  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log(`listening on ${port}`));
})();