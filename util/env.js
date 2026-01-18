/* ------------------------------------------------------------------
   Environment helpers + boot-time env logging
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

function safeDbHost(url) {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

function logBootEnv(logger, env) {
  const {
    NODE_ENV,
    APPLE_CLIENT_IDS,
    DATABASE_URL,
    SESSION_JWT_SECRET,
    OPENAI_API_KEY,
    ROOT_ADMIN_USER_IDS,
    BETTERSTACK_ENABLED,
    LOG_LEVEL,
    DEBUG_SCOPES
  } = env;

  logger.info("[boot] HakMun API starting");
  logger.info("[boot] NODE_ENV", { NODE_ENV });
  logger.info("[boot] APPLE_CLIENT_IDS", {
    apple_client_ids: APPLE_CLIENT_IDS.join(", ")
  });
  logger.info("[boot] DATABASE_URL host", {
    db_host: safeDbHost(DATABASE_URL)
  });
  logger.info("[boot] SESSION_JWT_SECRET set", {
    session_jwt_secret_set: Boolean(SESSION_JWT_SECRET)
  });
  logger.info("[boot] OPENAI_API_KEY set", {
    openai_api_key_set: Boolean(OPENAI_API_KEY)
  });
  logger.info("[boot] ROOT_ADMIN_USER_IDS set", {
    root_admin_ids: ROOT_ADMIN_USER_IDS.length
      ? `${ROOT_ADMIN_USER_IDS.length} pinned`
      : "none"
  });
  logger.info("[boot] betterstack shipping enabled", {
    enabled: Boolean(BETTERSTACK_ENABLED)
  });
  logger.info("[boot] LOG_LEVEL", { LOG_LEVEL });
  logger.info("[boot] DEBUG_SCOPES", {
    DEBUG_SCOPES: Array.from(DEBUG_SCOPES).join(",") || "<none>"
  });
}

module.exports = {
  requireEnv,
  parseCsvEnv,
  safeDbHost,
  logBootEnv
};