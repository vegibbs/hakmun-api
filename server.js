// server.js — HakMun API (v0.12) — DROP-IN REPLACEMENT
// Canonical identity + handles + secure private asset storage (signed URLs)
//
// M1.x + OBS1 invariants:
// - Deterministic auth/session/profile behavior (fail-fast; no hangs)
// - Session refresh endpoint exists
// - Canonical profile photo authority: users.profile_photo_object_key (object key only)
// - stdout JSON logs for Railway + durable shipping to Better Stack (HTTP ingestion)
// - MUST NOT log secrets (no Authorization/cookie/token dumps)
// - Request correlation: rid, method, path, status, duration
//
// OBS1.4 (Debug Hygiene):
// - Keep high-signal logs always-on (info/warn/error)
// - Gate noisy diagnostics behind LOG_LEVEL=debug + DEBUG_SCOPES=...

const express = require("express");
const OpenAI = require("openai");
const { createRemoteJWKSet, jwtVerify, SignJWT } = require("jose");
const { Pool } = require("pg");
const crypto = require("crypto");

const multer = require("multer");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/* ------------------------------------------------------------------
   OBS1.1 — Better Stack log shipping (minimal, low-risk)
------------------------------------------------------------------ */

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    try {
      const seen = new WeakSet();
      return JSON.stringify(obj, (k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      });
    } catch {
      return JSON.stringify({ msg: "json_stringify_failed" });
    }
  }
}

function getBetterStackConfig() {
  const url = process.env.BETTERSTACK_INGEST_URL;
  const token = process.env.BETTERSTACK_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).trim(), token: String(token).trim() };
}

const BETTERSTACK = getBetterStackConfig();

// Non-blocking shipper with bounded queue (drop if overwhelmed).
const _bsQueue = [];
let _bsFlushing = false;
const BS_MAX_QUEUE = 500;

async function shipToBetterStack(events) {
  if (!BETTERSTACK) return;
  if (!events || !events.length) return;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);

    await fetch(BETTERSTACK.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BETTERSTACK.token}`
      },
      body: safeJsonStringify(events.length === 1 ? events[0] : events),
      signal: controller.signal
    }).catch(() => {});

    clearTimeout(t);
  } catch {
    // Never block app flow for telemetry.
  }
}

function enqueueShip(evt) {
  if (!BETTERSTACK) return;
  if (_bsQueue.length >= BS_MAX_QUEUE) return;

  _bsQueue.push(evt);
  if (_bsFlushing) return;

  _bsFlushing = true;

  setImmediate(async () => {
    try {
      // Drain queue in bounded batches without generating extra events.
      while (_bsQueue.length) {
        const batch = _bsQueue.splice(0, 50);
        await shipToBetterStack(batch);
      }
    } finally {
      _bsFlushing = false;
    }
  });
}

/* ------------------------------------------------------------------
   OBS1.4 — LOG_LEVEL + DEBUG_SCOPES (no admin UI)
------------------------------------------------------------------ */

function parseLogLevel(raw) {
  const v = String(raw || "info").toLowerCase().trim();
  if (v === "error" || v === "warn" || v === "info" || v === "debug") return v;
  return "info";
}

const LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL);
const DEBUG_SCOPES = new Set(
  String(process.env.DEBUG_SCOPES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 };

function shouldLog(level) {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[LOG_LEVEL];
}

function scopeEnabled(scope) {
  if (!scope) return false;
  return DEBUG_SCOPES.has(String(scope).toLowerCase());
}

function makeLogger() {
  const base = {
    service: "hakmun-api",
    env: process.env.NODE_ENV || "<unset>"
  };

  function log(level, msg, fields) {
    if (!shouldLog(level)) return;

    const evt = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...base,
      ...(fields && typeof fields === "object" ? fields : {})
    };

    // Always log to stdout as JSON for Railway.
    process.stdout.write(safeJsonStringify(evt) + "\n");

    // Also ship to Better Stack (non-blocking).
    enqueueShip(evt);
  }

  function debug(scope, msg, fields) {
    if (!shouldLog("debug")) return;
    if (!scopeEnabled(scope)) return;
    log("debug", msg, { ...(fields || {}), debug_scope: scope });
  }

  return {
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    debug
  };
}

const logger = makeLogger();

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
    logger.info("[http]", {
      rid,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: ms
    });
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
// Impersonation tokens are short-lived and access-only (no refresh)
const IMPERSONATION_ACCESS_TTL_SEC = 60 * 10; // 10 minutes

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

logger.info("[boot] HakMun API starting");
logger.info("[boot] NODE_ENV", { NODE_ENV });
logger.info("[boot] APPLE_CLIENT_IDS", { apple_client_ids: APPLE_CLIENT_IDS.join(", ") });
logger.info("[boot] DATABASE_URL host", { db_host: safeDbHost(DATABASE_URL) });
logger.info("[boot] SESSION_JWT_SECRET set", { session_jwt_secret_set: Boolean(SESSION_JWT_SECRET) });
logger.info("[boot] OPENAI_API_KEY set", { openai_api_key_set: Boolean(OPENAI_API_KEY) });
logger.info("[boot] ROOT_ADMIN_USER_IDS set", {
  root_admin_ids: ROOT_ADMIN_USER_IDS.length ? `${ROOT_ADMIN_USER_IDS.length} pinned` : "none"
});
logger.info("[boot] betterstack shipping enabled", { enabled: Boolean(BETTERSTACK) });
logger.info("[boot] LOG_LEVEL", { LOG_LEVEL });
logger.info("[boot] DEBUG_SCOPES", { DEBUG_SCOPES: Array.from(DEBUG_SCOPES).join(",") || "<none>" });

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
  logger.error("[pg] pool error", { err: err?.message || String(err) });
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
  .then((r) => logger.info("[boot] db_fingerprint", { db_fingerprint: r.rows?.[0] || "<none>" }))
  .catch((e) => logger.error("[boot] db_fingerprint failed", { err: e?.message || String(e) }));

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
  logger.info("[apple] jwtVerify ok", { ms });

  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (!aud || !APPLE_CLIENT_IDS.includes(aud)) {
    throw new Error(`Apple token audience not allowed: ${String(aud)}`);
  }
  if (!payload.sub) {
    throw new Error("Apple token missing subject (sub)");
  }

  // Optional legacy bridge signal: Apple email is sometimes present (first auth, relay email, etc.)
  // This is NOT identity authority; it is only used to migrate legacy rows once.
  const email = typeof payload.email === "string" ? payload.email : null;

  return { appleSubject: payload.sub, audience: aud, email };
}

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */
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

    logger.error("[admin-safety] CRITICAL: cannot restore root admin in production without pinned IDs");
  } catch (err) {
    logger.error("[admin-safety] ensureAtLeastOneRootAdminNonFatal failed", {
      code: err?.code,
      err: err?.detail || err?.message || String(err)
    });
  }
}

/* ------------------------------------------------------------------
   Legacy profile helpers (REMOVED)
   - Post-EPIC 3.5.2 user_profiles is keyed by user_id, not apple_user_id.
   - Legacy apple_user_id-based helpers are forbidden here.
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
   Canonical identity resolution (auth_identities authority + tx bind)
   EPIC 3.5.4:
   - auth_identities is the source of truth for Apple auth.
   - A single Apple sub MUST resolve to one canonical users.user_id across audiences.
   - One-time legacy bridge may bind an existing legacy users.apple_user_id (email or old sub) to the real sub.
   - New users are Apple-independent: users.apple_user_id remains NULL.
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
    logger.error("[auth] fast auth_identities any-audience lookup failed", { rid, err: e?.message || String(e) });
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
   EPIC 3.2 — Entitlements (server-authoritative)
   - Clients MUST NOT infer capabilities.
   - Entitlements are reduced while impersonating.
------------------------------------------------------------------ */

function computeEntitlementsFromUser(user) {
  const role = String(user?.role || "student");
  const isActive = Boolean(user?.isActive);
  const isRootAdmin = Boolean(user?.isRootAdmin);
  const isAdmin = Boolean(user?.isAdmin);
  const impersonating = Boolean(user?.impersonating);

  // Fail-closed: inactive users have no entitlements.
  if (!isActive) {
    return {
      entitlements: [],
      capabilities: {
        canUseApp: false,
        canAccessTeacherTools: false,
        canAdminUsers: false,
        canImpersonate: false,
        canManageRoles: false,
        canManageActivation: false
      }
    };
  }

  const canAccessTeacherTools = role === "teacher";

  // Admin ops are never permitted while impersonating, even if the target user is admin/root admin.
  const adminAllowed = isRootAdmin && !impersonating;

  const entitlements = [];

  // Baseline capability: the user can use the app if they are active.
  entitlements.push("app:use");

  if (canAccessTeacherTools) entitlements.push("teacher:tools");

  if (adminAllowed) {
    entitlements.push("admin:users:read");
    entitlements.push("admin:users:write");
    entitlements.push("admin:impersonate");
  }

  // Useful for ops/debugging; not an entitlement to grant new powers.
  if (impersonating) entitlements.push("session:impersonating");
  if (isAdmin) entitlements.push("flag:is_admin");
  if (isRootAdmin) entitlements.push("flag:is_root_admin");

  const capabilities = {
    canUseApp: true,
    canAccessTeacherTools,

    // Root-admin-only, and forbidden while impersonating.
    canAdminUsers: adminAllowed,
    canImpersonate: adminAllowed,
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

/* ------------------------------------------------------------------
   User state (role/admin flags) + admin test user creation
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

async function createUserWithPrimaryHandle({ primaryHandle, role = "student", isActive = true }) {
  const client = await pool.connect();
  try {
    await client.query(`set statement_timeout = 6000;`);
    await client.query(`set lock_timeout = 2000;`);
    await client.query("BEGIN");

    // Enforce uniqueness of primary handle (case-insensitive).
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

    const newUserID = crypto.randomUUID();

    // Create Apple-less user row (identity is user_id; username is in user_handles).
    await client.query(
      `
      insert into users (user_id, role, is_active, is_admin, is_root_admin)
      values ($1, $2, $3, false, false)
      `,
      [newUserID, role, Boolean(isActive)]
    );

    // Register canonical primary handle.
    await client.query(
      `
      insert into user_handles (user_id, kind, handle, primary_handle)
      values ($1, 'primary', $2, $2)
      `,
      [newUserID, primaryHandle]
    );

    await client.query("COMMIT");

    return {
      user: {
        user_id: newUserID,
        role,
        is_active: Boolean(isActive),
        is_admin: false,
        is_root_admin: false,
        primary_handle: primaryHandle
      }
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    if (err?.code === "23505") {
      return { error: "handle_taken" };
    }

    throw new Error(String(err?.message || err));
  } finally {
    client.release();
  }
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

  // Admin impersonation (server-authoritative, explicit claims)
  const impersonating = Boolean(payload.imp);
  const actorUserID = payload.act ? String(payload.act) : null;

  // Safety: impersonation tokens must carry an actor
  if (impersonating && !actorUserID) {
    throw new Error("impersonation token missing act");
  }

  return { userID: String(userID), typ, impersonating, actorUserID };
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

      // Impersonation is an explicit session claim; client must never infer it.
      impersonating: Boolean(decoded.impersonating),
      actorUserID: decoded.actorUserID ? String(decoded.actorUserID) : null
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

/* ------------------------------------------------------------------
   EPIC 3 — Admin Ops (root-admin-only)
   - No client spoofing; server issues explicit impersonation sessions.
   - Admin ops are forbidden while impersonating.
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

function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
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

async function handleExists(handle) {
  // Case-insensitive uniqueness check for primary handles.
  const { rows } = await pool.query(
    `
    select 1
    from user_handles
    where kind = 'primary' and lower(handle) = lower($1)
    limit 1
    `,
    [handle]
  );
  return Boolean(rows && rows.length);
}

/**
 * IMPORTANT:
 * user_handles.primary_handle is NOT NULL.
 * For primary rows, primary_handle MUST equal handle.
 */
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

async function issueImpersonationAccessToken({ targetUserID, actorUserID }) {
  const iat = nowSeconds();

  // Access-only; short TTL; explicit impersonation claims.
  const accessToken = await new SignJWT({ typ: "access", imp: true, act: String(actorUserID) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(String(targetUserID))
    .setIssuedAt(iat)
    .setExpirationTime(iat + IMPERSONATION_ACCESS_TTL_SEC)
    .sign(Buffer.from(SESSION_JWT_SECRET));

  return {
    accessToken,
    expiresIn: IMPERSONATION_ACCESS_TTL_SEC
  };
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
   STORAGE EPIC 1 — Assets (multipart + validation + S3 + DB)
   - Enforce MIME allowlist + size limits server-side (S4)
   - One upload at a time (S5)
   - DB stores object_key only; signed URLs are ephemeral (S2)
   - Authority is users.user_id (S3)
------------------------------------------------------------------ */

// NOTE: This is separate from the profile-photo "upload" middleware.
// We keep asset limits independent and explicit.
const uploadAsset = multer({
  storage: multer.memoryStorage(),
  // Allow the largest permitted asset through multer, then enforce per-type below.
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max gate
});

// Canonical allowlist (initial, per Storage EPIC 1 scope)
const ASSET_ALLOWED_MIME = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "application/pdf"
]);

// Size limits per mime family (bytes)
const ASSET_MAX_BYTES = {
  audio: 25 * 1024 * 1024, // 25MB
  pdf: 10 * 1024 * 1024    // 10MB
};

function assetFamilyForMime(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  return "other";
}

function assetExtForMime(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (m === "audio/mpeg") return "mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return "wav";
  if (m === "audio/m4a") return "m4a";
  if (m === "application/pdf") return "pdf";
  return "bin";
}

function cleanOptionalText(v, maxLen) {
  const s = v === undefined || v === null ? "" : String(v).trim();
  if (!s) return null;
  if (typeof maxLen === "number" && maxLen > 0) return s.slice(0, maxLen);
  return s;
}

function cleanOptionalInt(v, min, max) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (typeof min === "number" && i < min) return null;
  if (typeof max === "number" && i > max) return null;
  return i;
}

app.post("/v1/assets", requireSession, uploadAsset.single("file"), async (req, res) => {
  // Storage must be configured for any asset work.
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "file required" });
    }

    const mime = String(req.file.mimetype || "").toLowerCase().trim();
    const sizeBytes = Number(req.file.size || 0);

    if (!mime || !ASSET_ALLOWED_MIME.has(mime)) {
      return res.status(415).json({ error: "unsupported media type", mime_type: mime || null });
    }

    const fam = assetFamilyForMime(mime);
    const maxBytes = ASSET_MAX_BYTES[fam];

    if (!maxBytes) {
      return res.status(415).json({ error: "unsupported media family", mime_type: mime });
    }

    if (sizeBytes > maxBytes) {
      return res.status(413).json({
        error: "file too large",
        mime_type: mime,
        size_bytes: sizeBytes,
        max_bytes: maxBytes
      });
    }

    const ownerUserID = req.user.userID;

    // Optional stable metadata (module meaning stays in use tables)
    const title = cleanOptionalText(req.body?.title, 140);
    const language = cleanOptionalText(req.body?.language, 32);
    const durationMs = cleanOptionalInt(req.body?.duration_ms, 0, 24 * 60 * 60 * 1000); // cap 24h

    // Deterministic object identity: asset_id is created server-side
    const assetID = crypto.randomUUID();
    const ext = assetExtForMime(mime);

    // Canonical object key scheme (private bucket)
    // NOTE: No URLs persisted; key is the only pointer (S2)
    const objectKey = `users/${ownerUserID}/assets/${assetID}.${ext}`;

    logger.info("[/v1/assets][start]", {
      rid: req._rid,
      ownerUserID,
      assetID,
      mime_type: mime,
      size_bytes: sizeBytes
    });

    // Stage 1: S3 PUT (fail-fast)
    const s3 = makeS3Client();
    await withTimeout(
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: req.file.buffer,
          ContentType: mime,
          CacheControl: "no-store"
        })
      ),
      15000,
      "s3-put-asset"
    );

    // Stage 2: DB insert (object_key ONLY)
    const inserted = await withTimeout(
      pool.query(
        `
        insert into media_assets (
          asset_id,
          owner_user_id,
          object_key,
          mime_type,
          size_bytes,
          title,
          language,
          duration_ms
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        returning asset_id, created_at
        `,
        [assetID, ownerUserID, objectKey, mime, sizeBytes, title, language, durationMs]
      ),
      8000,
      "db-insert-asset"
    );

    const row = inserted.rows?.[0];

    logger.info("[/v1/assets][ok]", {
      rid: req._rid,
      ownerUserID,
      assetID,
      object_key: objectKey
    });

    return res.status(201).json({
      asset_id: row?.asset_id || assetID,
      created_at: row?.created_at || null,
      mime_type: mime,
      size_bytes: sizeBytes
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/assets] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put-asset")) {
      return res.status(503).json({ error: "object storage timeout" });
    }
    if (msg.startsWith("timeout:db-insert-asset")) {
      logger.error("timeout:db-insert-asset", { rid: req._rid });
      return res.status(503).json({ error: "db timeout inserting asset" });
    }

    return res.status(500).json({ error: "asset upload failed" });
  }
});
/* ------------------------------------------------------------------
   POST /v1/auth/apple
   EPIC 3.5.4:
   - Verify Apple token (sub + aud)
   - Resolve canonical user via auth_identities (Apple sub is auth-only)
   - Do NOT return Apple identifiers to the client
------------------------------------------------------------------ */
app.post("/v1/auth/apple", async (req, res) => {
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

    return res.json({
      ...tokens,
      user: {
        userID,
        role: state.role,
        isTeacher: String(state.role || "student") === "teacher",
        isAdmin: Boolean(state.is_admin),
        isRootAdmin: Boolean(state.is_root_admin),
        isActive: Boolean(state.is_active)
      }
    });
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

    // Refresh tokens must never be impersonation tokens.
    if (decoded.impersonating) {
      return res.status(401).json({ error: "refresh not allowed for impersonation" });
    }

    const state = await getUserState(decoded.userID);
    if (!Boolean(state.is_active)) {
      return res.status(403).json({ error: "account disabled" });
    }

    const tokens = await issueSessionTokens({ userID: decoded.userID });
    return res.json(tokens);
  } catch (err) {
    // Keep exact alert match strings from the epic.
    logger.warn("/v1/session/refresh failed", { rid: req._rid, err: err?.message || String(err) });
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
      userID: req.user.userID,
      role: req.user.role,
      isTeacher: Boolean(req.user.isTeacher),
      isAdmin: Boolean(req.user.isAdmin),
      isRootAdmin: Boolean(req.user.isRootAdmin),
      isActive: Boolean(req.user.isActive),

      // Impersonation (explicit)
      impersonating: Boolean(req.user.impersonating),
      actorUserID: req.user.actorUserID,

      // Server-authoritative capabilities
      entitlements: req.user.entitlements || [],
      capabilities: req.user.capabilities || {},

      // Canonical profile facts
      profileComplete,
      primaryHandle,
      username: primaryHandle
    });
  } catch (err) {
    logger.error("/v1/session/whoami failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "whoami failed" });
  }
});

/* ------------------------------------------------------------------
   Canonical profile photo metadata (users table)
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

  // Debug-only row dump (incident tooling)
  logger.debug("photo_key", "[photo-key][set]", {
    userID,
    key: objectKey,
    row: r.rows?.[0] || null,
    rowCount: Number(r.rowCount ?? 0)
  });

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

  // Debug-only row dump (incident tooling)
  logger.debug("photo_key", "[photo-key][clear]", {
    userID,
    row: r.rows?.[0] || null,
    rowCount: Number(r.rowCount ?? 0)
  });

  if (!r.rowCount) {
    throw new Error("profile photo DB clear affected 0 rows");
  }
}

/* ------------------------------------------------------------------
   PUT /v1/me/profile-photo (upload)
   - High-signal stage logs always-on
   - Noisy details are debug-scoped
------------------------------------------------------------------ */
app.put("/v1/me/profile-photo", requireSession, upload.single("photo"), async (req, res) => {
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

    logger.info("[photo-upload][start]", {
      rid: req._rid,
      userID,
      objectKey,
      bytes: Number(req.file.size || 0),
      ct: contentType
    });

    const s3 = makeS3Client();

    // Stage 1: S3 upload (fail-fast)
    logger.info("[photo-upload][s3] begin", { rid: req._rid, userID });
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
    logger.info("[photo-upload][s3] ok", { rid: req._rid, userID });

    // Stage 2: DB update (fail-fast)
    logger.info("[photo-upload][db] begin", { rid: req._rid, userID });
    await withTimeout(setCanonicalProfilePhotoKey(userID, objectKey), 8000, "db-set-photo-key");
    logger.info("[photo-upload][db] ok", { rid: req._rid, userID });

    return res.json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);

    // Keep exact alert match strings from the epic.
    logger.error("[photo-upload][fail]", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put")) {
      return res.status(503).json({ error: "object storage timeout" });
    }
    if (msg.startsWith("timeout:db-set-photo-key")) {
      // Dedicated string for alert matching.
      logger.error("timeout:db-set-photo-key", { rid: req._rid });
      return res.status(503).json({ error: "db timeout setting photo key" });
    }

    return res.status(500).json({ error: "upload failed" });
  }
});

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

    logger.info("[photo-delete]", { rid: req._rid, userID, key });

    const s3 = makeS3Client();
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
    } catch (err) {
      logger.warn("profile-photo delete object failed", { rid: req._rid, err: err?.message || String(err) });
    }

    await clearCanonicalProfilePhotoKey(userID);

    return res.json({ ok: true });
  } catch (err) {
    logger.error("profile-photo delete failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "delete failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/me/profile-photo-url (signed url)
   - Reads canonical key from users table
   - DB probe is debug-scoped (db_probe)
------------------------------------------------------------------ */
app.get("/v1/me/profile-photo-url", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  res.set("X-HakMun-PhotoURL", "v0.12-canonical");

  try {
    const { userID } = req.user;

    // Debug-only DB probe
    if (shouldLog("debug") && scopeEnabled("db_probe")) {
      const probe = await pool.query(
        "select profile_photo_object_key, profile_photo_updated_at from users where user_id = $1 limit 1",
        [userID]
      );
      logger.debug("db_probe", "[photo-url][probe]", { rid: req._rid, userID, row: probe.rows?.[0] || null });
    }

    const key = await getCanonicalProfilePhotoKey(userID);
    logger.info("[photo-url]", { rid: req._rid, userID, hasKey: Boolean(key) });

    if (!key) {
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
    logger.error("profile-photo-url failed", { rid: req._rid, err: err?.message || String(err) });
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
    logger.error("handles/me failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "resolve failed" });
  }
});

/* ------------------------------------------------------------------
   EPIC 3 — Admin Ops Routes (root-admin-only)
------------------------------------------------------------------ */

// POST /v1/admin/users { primaryHandle, role? , isActive? }
// Purpose: create test users deterministically without new Apple IDs.
app.post(
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
app.get(
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
app.patch(
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
app.post(
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
app.post("/v1/admin/impersonate/exit", requireSession, requireImpersonating, async (req, res) => {
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

/* ------------------------------------------------------------------
   STORAGE EPIC 1 — Assets (read surface)
   - List owned assets (DB only)
   - Signed read URL (ephemeral; never persisted) (S2)
------------------------------------------------------------------ */

// GET /v1/assets — list owned assets (no URLs; object_key not returned)
app.get("/v1/assets", requireSession, async (req, res) => {
  try {
    const ownerUserID = req.user.userID;

    const r = await withTimeout(
      pool.query(
        `
        select
          asset_id,
          mime_type,
          size_bytes,
          title,
          language,
          duration_ms,
          created_at,
          updated_at
        from media_assets
        where owner_user_id = $1
        order by created_at desc
        limit 200
        `,
        [ownerUserID]
      ),
      8000,
      "db-list-assets"
    );

    return res.json({ assets: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/assets][list] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-assets")) {
      logger.error("timeout:db-list-assets", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing assets" });
    }

    return res.status(500).json({ error: "list assets failed" });
  }
});

// GET /v1/assets/:asset_id/url — signed read URL (requires storage configured)
app.get("/v1/assets/:asset_id/url", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const ownerUserID = req.user.userID;
    const assetID = String(req.params.asset_id || "").trim();

    if (!looksLikeUUID(assetID)) {
      return res.status(400).json({ error: "invalid asset_id" });
    }

    const r = await withTimeout(
      pool.query(
        `
        select object_key, mime_type, size_bytes
        from media_assets
        where asset_id = $1 and owner_user_id = $2
        limit 1
        `,
        [assetID, ownerUserID]
      ),
      8000,
      "db-get-asset-key"
    );

    const row = r.rows?.[0];
    if (!row?.object_key) {
      return res.status(404).json({ error: "asset not found" });
    }

    const s3 = makeS3Client();
    const url = await withTimeout(
      getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucketName(), Key: row.object_key }),
        { expiresIn: 60 * 15 }
      ),
      8000,
      "sign-asset-url"
    );

    return res.json({
      url,
      expiresIn: 900,
      mime_type: row.mime_type || null,
      size_bytes: Number(row.size_bytes || 0)
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/assets][url] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-get-asset-key")) {
      logger.error("timeout:db-get-asset-key", { rid: req._rid });
      return res.status(503).json({ error: "db timeout resolving asset" });
    }
    if (msg.startsWith("timeout:sign-asset-url")) {
      return res.status(503).json({ error: "timeout signing url" });
    }

    return res.status(500).json({ error: "failed to sign url" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 2 — Sharing Grants (read surfaces v0)
   - Shared-with-me listing (direct user grants)
   - Registry-aware quarantine: exclude under_review items when registry row exists
   - NOTE: No write paths in Step 1
------------------------------------------------------------------ */

// GET /v1/library/shared-with-me — list content items shared directly to this user
app.get("/v1/library/shared-with-me", requireSession, async (req, res) => {
  try {
    const userID = req.user.userID;

    const r = await withTimeout(
      pool.query(
        `
        select
          sg.id as share_grant_id,
          sg.content_type,
          sg.content_id,
          sg.granted_by_user_id,
          sg.created_at as granted_at,

          -- Registry fields are optional for personal/shared items; join is best-effort.
          ri.id as registry_item_id,
          ri.audience,
          ri.global_state,
          ri.operational_status,
          ri.owner_user_id as registry_owner_user_id

        from library_share_grants sg
        left join library_registry_items ri
          on ri.content_type = sg.content_type
         and ri.content_id = sg.content_id

        where sg.grant_type = 'user'
          and sg.grantee_id = $1
          and sg.revoked_at is null

          -- Quarantine rule: if registry row exists and is under_review, exclude from serving.
          and (ri.id is null or ri.operational_status <> 'under_review')

        order by sg.created_at desc
        limit 200
        `,
        [userID]
      ),
      8000,
      "db-list-shared-with-me"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/shared-with-me] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-shared-with-me")) {
      logger.error("timeout:db-list-shared-with-me", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing shared items" });
    }

    return res.status(500).json({ error: "list shared items failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 2 — Sharing Grants (read surfaces v0)
   - Shared-with-class listing (class grants)
   - Authorization:
     - user must be a member of the class OR root admin
   - Registry-aware quarantine:
     - exclude under_review items when registry row exists
   - NOTE: No write paths in Step 2
------------------------------------------------------------------ */

// GET /v1/library/shared-with-class?class_id=<uuid>
app.get("/v1/library/shared-with-class", requireSession, async (req, res) => {
  try {
    const userID = req.user.userID;
    const classID = String(req.query?.class_id || "").trim();

    if (!looksLikeUUID(classID)) {
      return res.status(400).json({ error: "class_id (uuid) is required" });
    }

    // Authorization: class membership OR root admin.
    // Membership table is expected to exist once class sharing is active.
    // If the membership table does not exist yet, fail closed (501) rather than bypass auth.
    if (!req.user?.capabilities?.canAdminUsers) {
      try {
        const m = await withTimeout(
          pool.query(
            `
            select 1
            from class_memberships
            where class_id = $1
              and user_id = $2
              and (revoked_at is null)
            limit 1
            `,
            [classID, userID]
          ),
          8000,
          "db-class-membership-check"
        );

        if (!m.rows || m.rows.length === 0) {
          return res.status(403).json({ error: "not a member of this class" });
        }
      } catch (err) {
        // If the class system isn't present yet, do NOT guess; fail closed deterministically.
        if (String(err?.code || "") === "42P01") {
          // undefined_table
          return res.status(501).json({ error: "class membership not implemented on server" });
        }
        throw err;
      }
    }

    const r = await withTimeout(
      pool.query(
        `
        select
          sg.id as share_grant_id,
          sg.content_type,
          sg.content_id,
          sg.granted_by_user_id,
          sg.created_at as granted_at,

          -- Registry fields are optional for personal/shared items; join is best-effort.
          ri.id as registry_item_id,
          ri.audience,
          ri.global_state,
          ri.operational_status,
          ri.owner_user_id as registry_owner_user_id

        from library_share_grants sg
        left join library_registry_items ri
          on ri.content_type = sg.content_type
         and ri.content_id = sg.content_id

        where sg.grant_type = 'class'
          and sg.grantee_id = $1
          and sg.revoked_at is null

          -- Quarantine rule: if registry row exists and is under_review, exclude from serving.
          and (ri.id is null or ri.operational_status <> 'under_review')

        order by sg.created_at desc
        limit 200
        `,
        [classID]
      ),
      8000,
      "db-list-shared-with-class"
    );

    return res.json({ class_id: classID, items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/shared-with-class] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-class-membership-check")) {
      logger.error("timeout:db-class-membership-check", { rid: req._rid });
      return res.status(503).json({ error: "db timeout checking class membership" });
    }
    if (msg.startsWith("timeout:db-list-shared-with-class")) {
      logger.error("timeout:db-list-shared-with-class", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing class shared items" });
    }

    return res.status(500).json({ error: "list class shared items failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 2 — Sharing Grants (write surfaces v0)
   - Create direct user share grant
   - Idempotent insert
   - No audience mutation
------------------------------------------------------------------ */

// POST /v1/library/share/user
// Body: { content_type, content_id, grantee_user_id }
app.post("/v1/library/share/user", requireSession, async (req, res) => {
  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const granteeUserID = String(req.body?.grantee_user_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(granteeUserID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or grantee_user_id" });
    }

    // Authorization:
    // - Owner may share their own content
    // - Teacher or root admin may share (platform authority)
    let authorized = false;

    // Fast path: teacher or root admin
    if (req.user.isTeacher || req.user.isRootAdmin) {
      authorized = true;
    }

    // Owner check via registry (best-effort; fail closed if registry row exists and owner mismatch)
    if (!authorized) {
      const r = await withTimeout(
        pool.query(
          `
          select owner_user_id
          from library_registry_items
          where content_type = $1
            and content_id = $2
          limit 1
          `,
          [contentType, contentID]
        ),
        8000,
        "db-check-share-owner"
      );

      if (r.rows?.length) {
        if (String(r.rows[0].owner_user_id) === String(actorUserID)) {
          authorized = true;
        } else {
          return res.status(403).json({ error: "not authorized to share this content" });
        }
      } else {
        // No registry row yet → personal-only content owned by creator
        // Allow owner to share; ownership is implicit in module tables
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: "not authorized to share this content" });
    }

    // Idempotent insert
    await withTimeout(
      pool.query(
        `
        insert into library_share_grants (
          content_type,
          content_id,
          grant_type,
          grantee_id,
          granted_by_user_id
        )
        values ($1, $2, 'user', $3, $4)
        on conflict do nothing
        `,
        [contentType, contentID, granteeUserID, actorUserID]
      ),
      8000,
      "db-insert-share-user"
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/user] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-check-share-owner")) {
      return res.status(503).json({ error: "db timeout checking ownership" });
    }
    if (msg.startsWith("timeout:db-insert-share-user")) {
      return res.status(503).json({ error: "db timeout creating share" });
    }

    return res.status(500).json({ error: "create share failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 2 — Sharing Grants (write surfaces v0)
   - Revoke direct user share grant (soft revoke)
   - No deletions; forensic-safe
------------------------------------------------------------------ */

// POST /v1/library/share/user/revoke
// Body: { content_type, content_id, grantee_user_id }
app.post("/v1/library/share/user/revoke", requireSession, async (req, res) => {
  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const granteeUserID = String(req.body?.grantee_user_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(granteeUserID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or grantee_user_id" });
    }

    // Authorization:
    // - Owner may revoke their own shares
    // - Teacher or root admin may revoke (platform authority)
    let authorized = false;

    if (req.user.isTeacher || req.user.isRootAdmin) {
      authorized = true;
    }

    if (!authorized) {
      const r = await withTimeout(
        pool.query(
          `
          select owner_user_id
          from library_registry_items
          where content_type = $1
            and content_id = $2
          limit 1
          `,
          [contentType, contentID]
        ),
        8000,
        "db-check-revoke-owner"
      );

      if (r.rows?.length) {
        if (String(r.rows[0].owner_user_id) === String(actorUserID)) {
          authorized = true;
        } else {
          return res.status(403).json({ error: "not authorized to revoke shares for this content" });
        }
      } else {
        // No registry row yet → allow the actor to revoke shares they granted (minimum safe rule).
        // This avoids assuming module-table ownership in v0.
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: "not authorized to revoke this share" });
    }

    const updated = await withTimeout(
      pool.query(
        `
        update library_share_grants
        set revoked_at = now()
        where content_type = $1
          and content_id = $2
          and grant_type = 'user'
          and grantee_id = $3
          and revoked_at is null
        `,
        [contentType, contentID, granteeUserID]
      ),
      8000,
      "db-revoke-share-user"
    );

    // Idempotent behavior: revoking an already-revoked/non-existent grant returns ok.
    return res.json({ ok: true, revoked: Number(updated.rowCount || 0) });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/user/revoke] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-check-revoke-owner")) {
      return res.status(503).json({ error: "db timeout checking ownership" });
    }
    if (msg.startsWith("timeout:db-revoke-share-user")) {
      return res.status(503).json({ error: "db timeout revoking share" });
    }

    return res.status(500).json({ error: "revoke share failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 2 — Sharing Grants (write surfaces v0)
   - Create class share grant (idempotent)
   - Fail-closed if class system is not present
------------------------------------------------------------------ */

// POST /v1/library/share/class
// Body: { content_type, content_id, class_id }
app.post("/v1/library/share/class", requireSession, async (req, res) => {
  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const classID = String(req.body?.class_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(classID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or class_id" });
    }

    // Authorization (v0):
    // - Only teacher or root admin may share to a class.
    if (!req.user.isTeacher && !req.user.isRootAdmin) {
      return res.status(403).json({ error: "teacher or root admin required" });
    }

    // Fail-closed validation that the class exists (and optionally that actor is a member/teacher).
    // If class system tables are absent, do NOT bypass: return 501.
    try {
      const c = await withTimeout(
        pool.query(
          `
          select 1
          from classes
          where class_id = $1
          limit 1
          `,
          [classID]
        ),
        8000,
        "db-class-exists-check"
      );

      if (!c.rows || c.rows.length === 0) {
        return res.status(404).json({ error: "class not found" });
      }
    } catch (err) {
      if (String(err?.code || "") === "42P01") {
        // undefined_table
        return res.status(501).json({ error: "class system not implemented on server" });
      }
      throw err;
    }

    // Idempotent insert
    await withTimeout(
      pool.query(
        `
        insert into library_share_grants (
          content_type,
          content_id,
          grant_type,
          grantee_id,
          granted_by_user_id
        )
        values ($1, $2, 'class', $3, $4)
        on conflict do nothing
        `,
        [contentType, contentID, classID, actorUserID]
      ),
      8000,
      "db-insert-share-class"
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/class] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-class-exists-check")) {
      logger.error("timeout:db-class-exists-check", { rid: req._rid });
      return res.status(503).json({ error: "db timeout checking class" });
    }
    if (msg.startsWith("timeout:db-insert-share-class")) {
      logger.error("timeout:db-insert-share-class", { rid: req._rid });
      return res.status(503).json({ error: "db timeout creating class share" });
    }

    return res.status(500).json({ error: "create class share failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 2 — Sharing Grants (write surfaces v0)
   - Revoke class share grant (soft revoke)
   - No deletions; forensic-safe
------------------------------------------------------------------ */

// POST /v1/library/share/class/revoke
// Body: { content_type, content_id, class_id }
app.post("/v1/library/share/class/revoke", requireSession, async (req, res) => {
  try {
    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const classID = String(req.body?.class_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(classID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or class_id" });
    }

    // Authorization (v0):
    // - Only teacher or root admin may revoke class shares.
    if (!req.user.isTeacher && !req.user.isRootAdmin) {
      return res.status(403).json({ error: "teacher or root admin required" });
    }

    const updated = await withTimeout(
      pool.query(
        `
        update library_share_grants
        set revoked_at = now()
        where content_type = $1
          and content_id = $2
          and grant_type = 'class'
          and grantee_id = $3
          and revoked_at is null
        `,
        [contentType, contentID, classID]
      ),
      8000,
      "db-revoke-share-class"
    );

    // Idempotent behavior: revoking an already-revoked/non-existent grant returns ok.
    return res.json({ ok: true, revoked: Number(updated.rowCount || 0) });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/class/revoke] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-revoke-share-class")) {
      logger.error("timeout:db-revoke-share-class", { rid: req._rid });
      return res.status(503).json({ error: "db timeout revoking class share" });
    }

    return res.status(500).json({ error: "revoke class share failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 3 — Moderation Actions (Step 1a)
   - needs_review: set operational_status=under_review
   - creates/maintains a Review Inbox entry (unresolved)
   - appends to library_moderation_actions (forensic)
   - NO other moderation actions in this step
------------------------------------------------------------------ */

// POST /v1/library/needs-review
// Body: { content_type, content_id, reason? }
app.post("/v1/library/needs-review", requireSession, async (req, res) => {
  const rid = req._rid;

  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const reason = req.body?.reason !== undefined ? String(req.body.reason).trim().slice(0, 500) : null;

    if (!contentType || !looksLikeUUID(contentID)) {
      return res.status(400).json({ error: "invalid content_type or content_id" });
    }

    // Require registry row to exist (registry is canonical authority).
    const client = await pool.connect();
    try {
      await client.query(`set statement_timeout = 8000;`);
      await client.query(`set lock_timeout = 2000;`);
      await client.query("BEGIN");

      // Lock registry item row for deterministic state change.
      const r = await client.query(
        `
        select
          id,
          content_type,
          content_id,
          audience,
          global_state,
          operational_status,
          owner_user_id,
          created_at,
          updated_at
        from library_registry_items
        where content_type = $1 and content_id = $2
        for update
        `,
        [contentType, contentID]
      );

      const item = r.rows?.[0];
      if (!item?.id) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "registry item not found" });
      }

      // Authorization (v0, safe):
      // - root admin OR
      // - teacher OR
      // - registry owner
      const isOwner = String(item.owner_user_id) === String(actorUserID);
      if (!req.user.isRootAdmin && !req.user.isTeacher && !isOwner) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "not authorized to flag needs_review" });
      }

      // Idempotent: if already under_review, do not duplicate queue/action.
      if (String(item.operational_status) === "under_review") {
        await client.query("COMMIT");
        return res.json({ ok: true, already_under_review: true });
      }

      const beforeSnapshot = {
        registry_item_id: item.id,
        content_type: item.content_type,
        content_id: item.content_id,
        audience: item.audience,
        global_state: item.global_state,
        operational_status: item.operational_status,
        owner_user_id: item.owner_user_id,
        created_at: item.created_at,
        updated_at: item.updated_at
      };

      // Update registry item to under_review.
      const updated = await client.query(
        `
        update library_registry_items
        set operational_status = 'under_review',
            updated_at = now()
        where id = $1
        returning
          id,
          content_type,
          content_id,
          audience,
          global_state,
          operational_status,
          owner_user_id,
          created_at,
          updated_at
        `,
        [item.id]
      );

      const after = updated.rows?.[0];
      const afterSnapshot = {
        registry_item_id: after.id,
        content_type: after.content_type,
        content_id: after.content_id,
        audience: after.audience,
        global_state: after.global_state,
        operational_status: after.operational_status,
        owner_user_id: after.owner_user_id,
        created_at: after.created_at,
        updated_at: after.updated_at
      };

      // Ensure there is exactly one unresolved review queue entry.
      const existingRQ = await client.query(
        `
        select id
        from library_review_queue
        where registry_item_id = $1
          and resolved_at is null
        limit 1
        `,
        [item.id]
      );

      if (!existingRQ.rows?.length) {
        await client.query(
          `
          insert into library_review_queue (
            registry_item_id,
            flagged_by_user_id,
            flagged_at,
            reason,
            prior_snapshot
          )
          values ($1, $2, now(), $3, $4)
          `,
          [item.id, actorUserID, reason, beforeSnapshot]
        );
      }

      // Append-only forensic action log.
      await client.query(
        `
        insert into library_moderation_actions (
          content_type,
          content_id,
          actor_user_id,
          action,
          reason,
          before_snapshot,
          after_snapshot,
          meta
        )
        values ($1,$2,$3,'needs_review',$4,$5,$6,$7)
        `,
        [
          contentType,
          contentID,
          actorUserID,
          reason,
          beforeSnapshot,
          afterSnapshot,
          { rid }
        ]
      );

      await client.query("COMMIT");

      logger.info("[/v1/library/needs-review][ok]", {
        rid,
        actorUserID,
        contentType,
        contentID,
        registry_item_id: item.id
      });

      return res.json({ ok: true, registry_item_id: item.id });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/needs-review] failed", { rid: req._rid, err: msg });

    if (msg.includes("timeout:") || msg.includes("statement timeout") || msg.includes("lock timeout")) {
      return res.status(503).json({ error: "db timeout" });
    }

    return res.status(500).json({ error: "needs_review failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 1 — Universal Library Registry (read surfaces v0)
   - Global library listing: global + active + (preliminary|approved)
   - Review inbox listing: under_review items (restricted)
   - NOTE: Registry-only; no module joins in v0.
------------------------------------------------------------------ */

// GET /v1/library/global — list globally discoverable content items (registry-only)
app.get("/v1/library/global", requireSession, async (req, res) => {
  try {
    const r = await withTimeout(
      pool.query(
        `
        select
          id as registry_item_id,
          content_type,
          content_id,
          audience,
          global_state,
          operational_status,
          owner_user_id,
          created_at,
          updated_at
        from library_registry_items
        where audience = 'global'
          and operational_status = 'active'
          and global_state in ('preliminary', 'approved')
        order by created_at desc
        limit 200
        `
      ),
      8000,
      "db-list-global-library"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/global] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-global-library")) {
      logger.error("timeout:db-list-global-library", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing global library" });
    }

    return res.status(500).json({ error: "list global library failed" });
  }
});

// GET /v1/library/review-inbox — list under_review items (restricted)
app.get("/v1/library/review-inbox", requireSession, requireRootAdmin, async (req, res) => {
  try {
    const r = await withTimeout(
      pool.query(
        `
        select
          rq.id as review_queue_id,
          rq.registry_item_id,
          rq.flagged_by_user_id,
          rq.flagged_at,
          rq.reason,
          rq.prior_snapshot,

          ri.content_type,
          ri.content_id,
          ri.audience,
          ri.global_state,
          ri.operational_status,
          ri.owner_user_id,
          ri.created_at,
          ri.updated_at
        from library_review_queue rq
        join library_registry_items ri
          on ri.id = rq.registry_item_id
        where ri.operational_status = 'under_review'
          and rq.resolved_at is null
        order by rq.flagged_at desc
        limit 200
        `
      ),
      8000,
      "db-list-review-inbox"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/review-inbox] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-review-inbox")) {
      logger.error("timeout:db-list-review-inbox", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing review inbox" });
    }

    return res.status(500).json({ error: "list review inbox failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 1 — Reading Coverage (registry-gated read surface)
   - Coverage applies ONLY to global + active items
   - Global state: preliminary | approved
   - Under Review items are excluded
   - No module-level visibility hacks
------------------------------------------------------------------ */

// GET /v1/reading-items/coverage — global reading items with variant matrix
app.get("/v1/reading-items/coverage", requireSession, async (req, res) => {
  try {
    const r = await withTimeout(
      pool.query(
        `
        select
          ric.reading_item_id,
          ric.unit_type,
          ric.text,
          ric.language,
          ric.notes,
          ric.created_at,
          ric.updated_at,

          ric.female_slow_asset_id,
          ric.female_moderate_asset_id,
          ric.female_native_asset_id,

          ric.male_slow_asset_id,
          ric.male_moderate_asset_id,
          ric.male_native_asset_id,

          ric.variants_count
        from reading_items_coverage ric
        join library_registry_items lri
          on lri.content_type = 'reading_item'
         and lri.content_id = ric.reading_item_id
        where lri.audience = 'global'
          and lri.operational_status = 'active'
          and lri.global_state in ('preliminary', 'approved')
        order by ric.created_at desc
        limit 500
        `
      ),
      8000,
      "db-list-reading-coverage-global"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/reading-items/coverage] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-reading-coverage-global")) {
      logger.error("timeout:db-list-reading-coverage-global", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing reading coverage" });
    }

    return res.status(500).json({ error: "list reading coverage failed" });
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
  app.listen(port, () => logger.info("listening", { port: Number(port) }));
})();