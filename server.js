// server.js — HakMun API (BOOT ONLY)
// - Imports assembled app from app.js
// - Runs boot checks
// - Starts listener
// NO routes, NO business logic here.

const { app, bootChecks, logger } = require("./app");

(async () => {
  await bootChecks();

  const port = process.env.PORT || 8080;
  app.listen(port, () => logger.info("listening", { port: Number(port) }));
})().catch((err) => {
  try {
    const msg = err?.message || String(err);
    if (logger?.error) logger.error("[boot] fatal", { err: msg });
    else process.stderr.write(`[boot] fatal: ${msg}\n`);
  } finally {
    process.exit(1);
  }
});