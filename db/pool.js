// db/pool.js — HakMun API (v0.12)
// Postgres pool (Railway) + db fingerprint logging

const { Pool } = require("pg");
const { logger } = require("../util/log");

const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || "<unset>";

if (!DATABASE_URL || String(DATABASE_URL).trim() === "") {
  // Fail-fast parity with original server.js requireEnv guardrails
  throw new Error("Missing required environment variable: DATABASE_URL");
}

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

module.exports = { pool };