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
app.use(require("./routes/profile_update"));
app.use(require("./routes/assets"));
app.use(require("./routes/handles"));

app.use(require("./routes/admin"));
app.use(require("./routes/library"));

// Canonical content item API (replaces reading-owned objects)
app.use(require("./routes/content_items"));

app.use(require("./routes/generate"));
app.use(require("./routes/dictionary_pins"));
app.use(require("./routes/dictionary_pins_write"));
app.use(require("./routes/dictionary_pins_delete"));
app.use(require("./routes/my_vocab"));
app.use(require("./routes/dictionary_sets"));
app.use(require("./routes/nikl_search"));
app.use(require("./routes/nikl_api_search"));
app.use(require("./routes/nikl_fetch_on_demand"));
app.use(require("./routes/krdict_search"));
app.use(require("./routes/teaching_vocab_admin"));
app.use(require("./routes/google_docs"));
app.use(require("./routes/google_oauth"));
app.use(require("./routes/google_docs_import"));
app.use(require("./routes/google_docs_view"));
app.use(require("./routes/google_docs_ingest"));
// Generic chunked text ingest (highlight / large selections)
app.use(require("./routes/ingest_text_chunked"));
app.use(require("./routes/document_sources"));
app.use(require("./routes/google_docs_snapshot"));
app.use(require("./routes/google_docs_commit"));
app.use(require("./routes/practice_events"));
app.use(require("./routes/practice_completions"));
app.use(require("./routes/lists"));
app.use(require("./routes/practice_lists"));
app.use(require("./routes/document_fragments"));
app.use(require("./routes/hakdoc"));
app.use(require("./routes/classes"));
app.use(require("./routes/grammar_patterns_admin"));
app.use(require("./routes/unmatched_vocab_admin"));
app.use(require("./routes/vocab_builder"));
app.use(require("./routes/vocab_images"));

// ------------------------------------------------------------------
// Export app + boot-time A0 validation hook (used by server.js)
// ------------------------------------------------------------------
const { ensureAtLeastOneRootAdminNonFatal } = require("./auth/session");

module.exports = {
  app,
  ensureAtLeastOneRootAdminNonFatal
};