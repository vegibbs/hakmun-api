// app.js — HakMun API (v0.12)
// Express app creation + middleware + routes (NO listen())

const express = require("express");

// Boot-time env parsing + invariant logging (order-sensitive; must run early)
const { initEnv } = require("./util/env");
initEnv();

const { logger } = require("./util/log");

// ------------------------------------------------------------------
// App + JSON
// ------------------------------------------------------------------
const app = express();
app.set("etag", false); // Determinism: never 304 on API routes.
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------------------
// Request ID + safe request logging (NO secrets)
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// Routes (mounted as-is; route modules own their full paths)
// ------------------------------------------------------------------
app.use(require("./routes/health"));
app.use(require("./routes/dev"));

app.use(require("./routes/auth_apple"));
app.use(require("./routes/session"));

app.use(require("./routes/profile_photo"));
app.use(require("./routes/assets"));
app.use(require("./routes/handles"));

app.use(require("./routes/admin"));
app.use(require("./routes/library"));
app.use(require("./routes/reading"));
app.use(require("./routes/generate"));
app.use(require("./routes/dictionary_pins"));
app.use(require("./routes/dictionary_pins_write"));
app.use(require("./routes/dictionary_pins_delete"));
app.use(require("./routes/my_vocab"));

// ------------------------------------------------------------------
// Export app + boot-time A0 validation hook (used by server.js)
// ------------------------------------------------------------------
const { ensureAtLeastOneRootAdminNonFatal } = require("./auth/session");

module.exports = {
  app,
  ensureAtLeastOneRootAdminNonFatal
};