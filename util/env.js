// util/env.js — HakMun API (v0.12)
// Env parsing + boot logging (fail fast)

const { logger } = require("./log");

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

/**
 * initEnv()
 * - Parses env vars (fail-fast)
 * - Stores parsed values back onto process.env-derived config object
 * - Emits boot logs (order-sensitive)
 *
 * NOTE: This module intentionally does NOT reach into DB or other modules.
 */
function initEnv() {
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

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  // Session token lifetimes (seconds)
  const SESSION_ACCESS_TTL_SEC = 60 * 30; // 30 minutes
  const SESSION_REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
  // Impersonation tokens are short-lived and access-only (no refresh)
  const IMPERSONATION_ACCESS_TTL_SEC = 60 * 10; // 10 minutes

  // Session JWT claims
  const SESSION_ISSUER = "hakmun-api";
  const SESSION_AUDIENCE = "hakmun-client";

  // Expose parsed config as a single object (explicit imports elsewhere)
  const config = {
    APPLE_CLIENT_IDS,
    DATABASE_URL,
    SESSION_JWT_SECRET,
    NODE_ENV,
    ROOT_ADMIN_USER_IDS,

    OPENAI_API_KEY,

    SESSION_ACCESS_TTL_SEC,
    SESSION_REFRESH_TTL_SEC,
    IMPERSONATION_ACCESS_TTL_SEC,

    SESSION_ISSUER,
    SESSION_AUDIENCE
  };

  // Safe boot logs (no secrets)
  logger.info("[boot] HakMun API starting");
  logger.info("[boot] NODE_ENV", { NODE_ENV: config.NODE_ENV });
  logger.info("[boot] APPLE_CLIENT_IDS", { apple_client_ids: config.APPLE_CLIENT_IDS.join(", ") });
  logger.info("[boot] DATABASE_URL host", { db_host: safeDbHost(config.DATABASE_URL) });
  logger.info("[boot] SESSION_JWT_SECRET set", {
    session_jwt_secret_set: Boolean(config.SESSION_JWT_SECRET)
  });
  logger.info("[boot] OPENAI_API_KEY set", { openai_api_key_set: Boolean(config.OPENAI_API_KEY) });
  logger.info("[boot] ROOT_ADMIN_USER_IDS set", {
    root_admin_ids: config.ROOT_ADMIN_USER_IDS.length
      ? `${config.ROOT_ADMIN_USER_IDS.length} pinned`
      : "none"
  });

  // Logging config echoed (matches original intent)
  logger.info("[boot] betterstack shipping enabled", {
    enabled: Boolean(require("./log").BETTERSTACK)
  });
  logger.info("[boot] LOG_LEVEL", { LOG_LEVEL: logger.LOG_LEVEL });
  logger.info("[boot] DEBUG_SCOPES", {
    DEBUG_SCOPES: Array.from(logger.DEBUG_SCOPES).join(",") || "<none>"
  });

  return config;
}

module.exports = {
  requireEnv,
  parseCsvEnv,
  safeDbHost,
  initEnv
};