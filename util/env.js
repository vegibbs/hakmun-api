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
  // Fail-safe: boot logging must never crash the server.
  // If logger is missing, fall back to stdout JSON lines.
  const fallback = {
    info: (msg, fields) => {
      try {
        process.stdout.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "info",
            msg,
            ...(fields && typeof fields === "object" ? fields : {})
          }) + "\n"
        );
      } catch {}
    }
  };

  const L = logger && typeof logger.info === "function" ? logger : fallback;

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

  L.info("[boot] HakMun API starting");
  L.info("[boot] NODE_ENV", { NODE_ENV });
  L.info("[boot] APPLE_CLIENT_IDS", {
    apple_client_ids: APPLE_CLIENT_IDS.join(", ")
  });
  L.info("[boot] DATABASE_URL host", {
    db_host: safeDbHost(DATABASE_URL)
  });
  L.info("[boot] SESSION_JWT_SECRET set", {
    session_jwt_secret_set: Boolean(SESSION_JWT_SECRET)
  });
  L.info("[boot] OPENAI_API_KEY set", {
    openai_api_key_set: Boolean(OPENAI_API_KEY)
  });
  L.info("[boot] ROOT_ADMIN_USER_IDS set", {
    root_admin_ids: ROOT_ADMIN_USER_IDS.length
      ? `${ROOT_ADMIN_USER_IDS.length} pinned`
      : "none"
  });
  L.info("[boot] betterstack shipping enabled", {
    enabled: Boolean(BETTERSTACK_ENABLED)
  });
  L.info("[boot] LOG_LEVEL", { LOG_LEVEL });
   const debugScopesText =
    DEBUG_SCOPES && typeof DEBUG_SCOPES[Symbol.iterator] === "function"
      ? (Array.from(DEBUG_SCOPES).join(",") || "<none>")
      : "<none>";

  L.info("[boot] DEBUG_SCOPES", { DEBUG_SCOPES: debugScopesText });
}

module.exports = {
  requireEnv,
  parseCsvEnv,
  safeDbHost,
  logBootEnv
};