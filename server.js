// server.js — HakMun API (v0.12)
// Process startup only: boot-time validation + listen()

const { app, ensureAtLeastOneRootAdminNonFatal } = require("./app");
const { logger } = require("./util/log");

(async () => {
  // Boot-time A0 validation (order-sensitive)
  await ensureAtLeastOneRootAdminNonFatal("boot");

  const port = process.env.PORT || 8080;

  app.listen(port, () => {
    logger.info("listening", { port: Number(port) });
  });
})();