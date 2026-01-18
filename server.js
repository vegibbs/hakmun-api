// server.js — HakMun API (BOOT ONLY)
//
// Purpose:
// - Import the assembled Express app from app.js
// - Run boot checks
// - Start listening
//
// Hard invariants:
// - NO routes or business logic here
// - Boot must NOT crash due to missing logger
// - Fail-fast on bootChecks errors

const { app, bootChecks, logger } = require("./app");

const port = process.env.PORT || 8080;

(async () => {
  await bootChecks();

  app.listen(port, () => {
    try {
      if (logger && typeof logger.info === "function") {
        logger.info("listening", { port: Number(port) });
      } else {
        // Fallback: never fail boot due to missing logger
        process.stdout.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "info",
            msg: "listening",
            port: Number(port)
          }) + "\n"
        );
      }
    } catch {
      // Never allow logging issues to crash boot.
    }
  });
})().catch((err) => {
  try {
    const msg = err?.message || String(err);

    if (logger && typeof logger.error === "function") {
      logger.error("[boot] fatal", { err: msg });
    } else {
      process.stderr.write(`[boot] fatal: ${msg}\n`);
    }
  } finally {
    process.exit(1);
  }
});