// server.js — HakMun API (v0.11) — FULL REWRITE (DROP-IN REPLACEMENT)
// Canonical identity + handles + secure private asset storage (signed URLs)
//
// PURPOSE (M1.3):
// - Stop “black box” behavior by making both sides observable.
// - Auth must be deterministic (fail-fast, no hangs).
// - Session refresh endpoint MUST exist.
// - Profile photo must be canonical (users.profile_photo_object_key).
//
// DEBUG INCLUDED (ONE SHOT):
// - Per-request request-id + method/path/status timing.
// - Boot DB fingerprint.
// - /v1/auth/apple stage logs + timeouts.
// - /v1/me/profile-photo-url: probe DB row on-request + helper result.
// - Photo key writes: log set/clear operations.
//
// SECURITY:
// - No secrets logged.
// - No auth headers logged.
// - Signed URLs returned only to authenticated user.

const express = require("express");
const OpenAI = require("openai");
const { createRemoteJWKSet, jwtVerify, SignJWT } = require("jose");
const { Pool } = require("pg");

const multer = require("multer");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/* ------------------------------------------------------------------
   App + JSON
------------------------------------------------------------------ */
const app = express();
app.set("etag", false); // Determinism: never 304 on API routes.
app.use(express.json({ limit: "1mb" }));

/* ------------------------------------------------------------------
   Request ID + safe request logging (NO secrets)
------------------------------------------------------------------ */
function makeReqID() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

app.use((req, res, next) => {
  const rid = makeReqID();
  req._rid = rid;
  res.setHeader("X-HakMun-Request-Id", rid);

  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`[http] rid=${rid} ${req.method} ${req.path} -> ${res.statusCode} ${ms}ms`);
  });

  next();
});

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

const NODE_ENV = process.env.NODE_ENV || "<unset>";
const ROOT_ADMIN_USER_IDS =
  NODE_ENV === "production"
    ? parseCsvEnv("ROOT_ADMIN_USER_IDS").length
      ? parseCsvEnv("ROOT_ADMIN_USER_IDS")
      : (() => {
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
  ssl: NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 30_000,
  max: 10
});

pool.on("error", (err) => {
  console.error("[pg] pool error:", err?.message || err);
});

// DB fingerprint (removes ambiguity)
pool
  .query(
    `
  select
    current_database() as db,
    current_schema() as schema,
    inet_server_addr() as addr,
    inet_server_port() as port,
    version() as version
`
  )
  .then((r) => console.log("[boot] db_fingerprint =", r.rows?.[0] || "<none>"))
  .catch((e) => console.error("[boot] db_fingerprint failed:", e?.message || e));

/* ------------------------------------------------------------------
   Deterministic timeouts (fail-fast)
------------------------------------------------------------------ */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
    )
  ]);
}

/* ------------------------------------------------------------------
   Apple Sign In verification (fail-fast)
------------------------------------------------------------------ */
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

async function verifyAppleToken(identityToken) {
  const t0 = Date.now();

  const { payload } = await withTimeout(
    jwtVerify(identityToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: APPLE_CLIENT_IDS
    }),
    6000,
    "apple-jwtVerify"
  );

  const ms = Date.now() - t0;
  console.log(`[apple] jwtVerify ok in ${ms}ms`);

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
  return "image/jpeg";
}

function requireJsonField(req, res, fieldName) {
  const v = req.body?.[fieldName];
  if (!v || String(v).trim() === "") {
    res.status(400).json({ error: `${fieldName} is required` });
    return null;
  }
  return String(v);
}

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

    console.log(`[admin-safety] promoted root admin user_id=${userID} reason=${reason}`);
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

    console.error(`[admin-safety] ZERO active root admins detected (trigger=${trigger}).`);

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

    console.error("[admin-safety] CRITICAL: cannot restore root admin in production without pinned IDs.");
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
   Canonical identity resolution (fast paths + tx slow path)
------------------------------------------------------------------ */
async function ensureCanonicalUser({ appleSubject, audience }, rid) {
  // FAST PATH 1: auth_identities
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
      ensureLegacyUserProfileNonFatal(appleSubject).catch(() => {});
      touchLastSeen(userID).catch(() => {});
      return userID;
    }
  } catch (e) {
    console.error(`[auth] rid=${rid} fast auth_identities lookup failed:`, e?.message || e);
  }

  // FAST PATH 2: users.apple_user_id
  try {
    const r = await withTimeout(
      pool.query(
        `
        select user_id
        from users
        where apple_user_id = $1
        limit 1
        `,
        [appleSubject]
      ),
      3000,
      "users-lookup"
    );

    const userID = r?.rows?.[0]?.user_id || null;
    if (userID) {
      // bind identity best-effort
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
          console.warn(`[warn] rid=${rid} auth_identities bind failed:`, err?.code, err?.detail || err?.message)
        );

      ensureLegacyUserProfileNonFatal(appleSubject).catch(() => {});
      touchLastSeen(userID).catch(() => {});
      return userID;
    }
  } catch (e) {
    console.error(`[auth] rid=${rid} fast users lookup failed:`, e?.message || e);
  }

  // SLOW PATH: tx create/bind (fail-fast on locks)
  const client = await pool.connect();
  try {
    await client.query(`set statement_timeout = 6000;`);
    await client.query(`set lock_timeout = 2000;`);
    await client.query("BEGIN");

    const rAuth = await client.query(
      `
      select user_id
      from auth_identities
      where provider = 'apple' and subject = $1 and audience = $2
      limit 1
      `,
      [appleSubject, audience]
    );

    let canonicalUserID = rAuth.rows?.[0]?.user_id || null;

    if (!canonicalUserID) {
      const rUser = await client.query(
        `
        select user_id
        from users
        where apple_user_id = $1
        limit 1
        `,
        [appleSubject]
      );

      canonicalUserID = rUser.rows?.[0]?.user_id || null;

      if (!canonicalUserID) {
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

      // best-effort legacy
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
    }

    await client.query("COMMIT");

    touchLastSeen(canonicalUserID).catch(() => {});
    return canonicalUserID;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error(`[auth] rid=${rid} ensureCanonicalUser TX FAILED:`, err?.message || err);
    throw err;
  } finally {
    client.release();
  }
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
    select role, is_admin, is_root_admin, is_active
    from users
    where user_id = $1
    limit 1
    `,
    [userID]
  );

  return rows?.[0] || {
    role: "student",
    is_admin: false,
    is_root_admin: false,
    is_active: true
  };
}

/* ------------------------------------------------------------------
   Canonical profile facts
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

  return { userID, typ };
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

    req.user = {
      userID: decoded.userID,
      role: state.role,
      isAdmin: Boolean(state.is_admin),
      isRootAdmin: Boolean(state.is_root_admin),
      isActive
    };

    return next();
  } catch (err) {
    console.error("Session auth error:", err?.message || err);
    return res.status(401).json({ error: "invalid session" });
  }
}

/* ------------------------------------------------------------------
   Secure object storage (S3-compatible)
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
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
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
   POST /v1/auth/apple
------------------------------------------------------------------ */
app.post("/v1/auth/apple", async (req, res) => {
  console.log(`[/v1/auth/apple] START rid=${req._rid}`);
  res.set("X-HakMun-AuthApple", "v0.11-debug");

  try {
    const identityToken = requireJsonField(req, res, "identityToken");
    if (!identityToken) return;

    const { appleSubject, audience } = await verifyAppleToken(identityToken);
    console.log(`[/v1/auth/apple] verified rid=${req._rid} appleSubject=${appleSubject}`);

    const userID = await withTimeout(
      ensureCanonicalUser({ appleSubject, audience }, req._rid),
      6000,
      "ensureCanonicalUser"
    );
    console.log(`[/v1/auth/apple] canonical rid=${req._rid} userID=${userID}`);

    const state = await withTimeout(getUserState(userID), 6000, "getUserState");
    console.log(`[/v1/auth/apple] state rid=${req._rid} active=${Boolean(state.is_active)}`);

    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    const tokens = await withTimeout(issueSessionTokens({ userID }), 3000, "issueSessionTokens");
    console.log(`[/v1/auth/apple] issued tokens rid=${req._rid}`);

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
    const msg = String(err?.message || err);
    console.error(`/v1/auth/apple failed rid=${req._rid}:`, msg);

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
   POST /v1/session/refresh
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

    const tokens = await issueSessionTokens({ userID: decoded.userID });
    return res.json(tokens);
  } catch (err) {
    console.error("/v1/session/refresh failed:", err?.message || err);
    return res.status(401).json({ error: "refresh failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/session/whoami
------------------------------------------------------------------ */
app.get("/v1/session/whoami", requireSession, async (req, res) => {
  try {
    await ensureAtLeastOneRootAdminNonFatal("whoami");

    const primaryHandle = await getPrimaryHandleForUser(req.user.userID);
    const profileComplete = Boolean(primaryHandle && String(primaryHandle).trim());

    return res.json({
      ...req.user,
      profileComplete,
      primaryHandle,
      username: primaryHandle
    });
  } catch (err) {
    console.error("/v1/session/whoami failed:", err?.message || err);
    return res.status(500).json({ error: "whoami failed" });
  }
});

/* ------------------------------------------------------------------
   Canonical profile photo metadata (users table) + logging
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
  const r = await pool.query(
    `
    update users
    set profile_photo_object_key = $2,
        profile_photo_updated_at = now()
    where user_id = $1
    returning profile_photo_object_key, profile_photo_updated_at
    `,
    [userID, objectKey]
  );

  const row = r.rows?.[0] || null;
  console.log(
    "[photo-key][set] userID=" +
      userID +
      " key=" +
      objectKey +
      " row=" +
      JSON.stringify(row) +
      " rowCount=" +
      String(r.rowCount ?? 0)
  );

  if (!r.rowCount) {
    throw new Error("profile photo DB update affected 0 rows");
  }
}

async function clearCanonicalProfilePhotoKey(userID) {
  const r = await pool.query(
    `
    update users
    set profile_photo_object_key = null,
        profile_photo_updated_at = now()
    where user_id = $1
    returning profile_photo_object_key, profile_photo_updated_at
    `,
    [userID]
  );

  console.log(
    "[photo-key][clear] userID=" +
      userID +
      " row=" +
      JSON.stringify(r.rows?.[0] || null) +
      " rowCount=" +
      String(r.rowCount ?? 0)
  );

  if (!r.rowCount) {
    throw new Error("profile photo DB clear affected 0 rows");
  }
}

/* ------------------------------------------------------------------
   PUT /v1/me/profile-photo (upload)
   - Stage logs + fail-fast timeouts to isolate hangs (S3 vs DB)
------------------------------------------------------------------ */
app.put(
  "/v1/me/profile-photo",
  requireSession,
  upload.single("photo"),
  async (req, res) => {
    const maybe = requireStorageOr503(res);
    if (maybe) return;

    try {
      if (!req.file) {
        return res.status(400).json({ error: "photo file required" });
      }

      const { userID } = req.user;

      const contentType = safeMimeType(req.file.mimetype);
      const ext =
        contentType === "image/png"
          ? "png"
          : contentType === "image/webp"
          ? "webp"
          : contentType === "image/heic"
          ? "heic"
          : "jpg";

      const objectKey = `users/${userID}/profile.${ext}`;

      console.log(
        "[photo-upload][start] rid=" +
          req._rid +
          " userID=" +
          userID +
          " objectKey=" +
          objectKey +
          " bytes=" +
          String(req.file.size) +
          " ct=" +
          contentType
      );

      const s3 = makeS3Client();

      // Stage 1: S3 upload (fail-fast)
      console.log("[photo-upload][s3] rid=" + req._rid + " begin");
      await withTimeout(
        s3.send(
          new PutObjectCommand({
            Bucket: bucketName(),
            Key: objectKey,
            Body: req.file.buffer,
            ContentType: contentType,
            CacheControl: "no-store"
          })
        ),
        15000,
        "s3-put"
      );
      console.log("[photo-upload][s3] rid=" + req._rid + " ok");

      // Stage 2: DB update (fail-fast)
      console.log("[photo-upload][db] rid=" + req._rid + " begin");
      await withTimeout(
        setCanonicalProfilePhotoKey(userID, objectKey),
        8000,
        "db-set-photo-key"
      );
      console.log("[photo-upload][db] rid=" + req._rid + " ok");

      return res.json({ ok: true });
    } catch (err) {
      const msg = String(err?.message || err);
      console.error("[photo-upload][fail] rid=" + req._rid + " err=" + msg);

      if (msg.startsWith("timeout:s3-put")) {
        return res.status(503).json({ error: "object storage timeout" });
      }
      if (msg.startsWith("timeout:db-set-photo-key")) {
        return res.status(503).json({ error: "db timeout setting photo key" });
      }

      return res.status(500).json({ error: "upload failed" });
    }
  }
);

/* ------------------------------------------------------------------
   DELETE /v1/me/profile-photo (delete)
------------------------------------------------------------------ */
app.delete("/v1/me/profile-photo", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const { userID } = req.user;

    const key = await getCanonicalProfilePhotoKey(userID);
    if (!key) return res.json({ ok: true });

    console.log("[photo-delete] rid=" + req._rid + " userID=" + userID + " key=" + key);

    const s3 = makeS3Client();
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
    } catch (err) {
      console.error("profile-photo delete object failed:", err?.message || err);
    }

    await clearCanonicalProfilePhotoKey(userID);

    return res.json({ ok: true });
  } catch (err) {
    console.error("profile-photo delete failed:", err?.message || err);
    return res.status(500).json({ error: "delete failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/me/profile-photo-url (signed url)
   - Reads canonical key from users table
   - Probes DB row on-request
------------------------------------------------------------------ */
app.get("/v1/me/profile-photo-url", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  res.set("X-HakMun-PhotoURL", "v0.11-canonical");

  try {
    const { userID } = req.user;

    // On-request DB probe: what does Postgres say RIGHT NOW?
    const probe = await pool.query(
      "select profile_photo_object_key, profile_photo_updated_at from users where user_id = $1 limit 1",
      [userID]
    );
    console.log("[photo-url][probe] rid=" + req._rid + " row=" + JSON.stringify(probe.rows?.[0] || null));

    const key = await getCanonicalProfilePhotoKey(userID);
    console.log("[photo-url] rid=" + req._rid + " userID=" + userID + " key=" + (key || "<null>"));

    if (!key) {
      console.error("[photo-url] rid=" + req._rid + " no key -> 404");
      return res.status(404).json({ error: "no profile photo" });
    }

    const s3 = makeS3Client();
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucketName(), Key: key }),
      { expiresIn: 60 * 15 }
    );

    return res.json({ url, expiresIn: 900 });
  } catch (err) {
    console.error("profile-photo-url failed:", err?.message || err);
    return res.status(500).json({ error: "failed to sign url" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/handles/me
------------------------------------------------------------------ */
app.get("/v1/handles/me", requireSession, async (req, res) => {
  const { userID } = req.user;

  try {
    const { rows } = await pool.query(
      `
      select handle
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
    console.error("handles/me failed:", err?.message || err);
    return res.status(500).json({ error: "resolve failed" });
  }
});

/* ------------------------------------------------------------------
   Sentence generation (optional)
------------------------------------------------------------------ */
app.post("/v1/generate/sentences", (req, res) => {
  return res.status(501).json({ error: "not enabled in this build" });
});

/* ------------------------------------------------------------------
   Boot-time A0 validation + Start server
------------------------------------------------------------------ */
(async () => {
  await ensureAtLeastOneRootAdminNonFatal("boot");
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log(`listening on ${port}`));
})();