/* ------------------------------------------------------------------
   Postgres (Railway)
   - Pool init + pool error handler
   - DB fingerprint logging (removes ambiguity)
------------------------------------------------------------------ */

const { Pool } = require("pg");

function createPool({ DATABASE_URL, NODE_ENV, logger }) {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required to create pg pool");
  }

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30_000,
    max: 10
  });

  pool.on("error", (err) => {
    if (logger && typeof logger.error === "function") {
      logger.error("[pg] pool error", {
        err: err?.message || String(err)
      });
    }
  });

  return pool;
}

module.exports = { createPool };