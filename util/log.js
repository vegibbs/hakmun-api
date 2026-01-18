// util/log.js — HakMun API (v0.12)
// Logger + Better Stack shipping (minimal, low-risk)

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

/* ------------------------------------------------------------------
   OBS1.1 — Better Stack log shipping (minimal, low-risk)
------------------------------------------------------------------ */

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
   OBS1.4 — LOG_LEVEL + DEBUG_SCOPES
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
    debug,

    // Exported for callers that need gating logic
    shouldLog,
    scopeEnabled,

    // Exported for boot logging
    LOG_LEVEL,
    DEBUG_SCOPES
  };
}

const logger = makeLogger();

module.exports = {
  logger,
  safeJsonStringify,

  // Better Stack exports kept for parity / potential diagnostics
  BETTERSTACK,
  shipToBetterStack,
  enqueueShip
};