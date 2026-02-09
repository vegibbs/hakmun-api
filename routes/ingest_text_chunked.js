// FILE: hakmun-api/routes/ingest_text_chunked.js
// PURPOSE: Generic chunked ingest for large text selections (store actual text; enqueue parse jobs)
// ENDPOINT:
//   POST /v1/documents/ingest-text-chunked
//
// Body:
// {
//   "source_kind": "google_doc" | "pdf" | "docx" | "text" | "manual" | "other",
//   "source_uri": "...",                 // required (e.g., Google Doc URL, filename, etc.)
//   "title": "optional override",
//   "import_as": "all" | "vocab" | "sentences" | "patterns",
//   "scope": { "mode": "highlight" | "sessions" | "blocks" | "whole_doc" | "text" },
//   "selected_text": "...",              // required; will be chunked
//   "chunk_max_chars": 200000              // optional (default 200k; clamp 20k..450k)
// }
//
// Behavior:
// - Splits selected_text into chunks by character budget
// - For each chunk:
//   - Stores chunk text snapshot as text/plain asset
//   - Creates documents row (source_kind/source_uri)
//   - Creates parse_run + docparse_job with payload INCLUDING chunk text
// - Returns a compact summary of enqueued chunks

const express = require("express");
const crypto = require("crypto");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function storageConfigured() {
  return Boolean(
    process.env.OBJECT_STORAGE_ENDPOINT &&
      process.env.OBJECT_STORAGE_BUCKET &&
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION || "auto",
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
    },
    forcePathStyle: true
  });
}

function bucketName() {
  return process.env.OBJECT_STORAGE_BUCKET;
}

function clampInt(n, defVal) {
  const x = Number(n);
  if (!Number.isFinite(x)) return defVal;
  return Math.floor(x);
}

function normalizeImportAs(v) {
  const s = typeof v === "string" ? v.trim() : "all";
  return ["all", "vocab", "sentences", "patterns"].includes(s) ? s : "all";
}

function makeTextChunksByChars(text, chunkMaxChars) {
  const t = typeof text === "string" ? text : "";
  const s = t.trim();
  if (!s) return [];

  const out = [];
  let i = 0;

  while (i < s.length) {
    let end = Math.min(s.length, i + chunkMaxChars);

    // Prefer to break on a newline or whitespace within the last ~2k chars of the window.
    const windowStart = Math.max(i, end - 2000);
    const window = s.slice(windowStart, end);

    let breakAt = -1;
    const nl = window.lastIndexOf("\n");
    if (nl !== -1) breakAt = windowStart + nl;
    else {
      const wsMatch = window.match(/\s+(?!.*\s)/);
      // fallback: find last whitespace by scanning backwards if regex fails
      if (wsMatch && wsMatch.index !== undefined) {
        breakAt = windowStart + wsMatch.index;
      } else {
        for (let j = end - 1; j > windowStart; j--) {
          if (/\s/.test(s[j])) { breakAt = j; break; }
        }
      }
    }

    // If we found a good break and it advances, use it; otherwise hard cut.
    if (breakAt > i + 1000) {
      end = breakAt;
    }

    const chunk = s.slice(i, end).trim();
    if (chunk) out.push(chunk);

    // Advance; skip any leading whitespace/newlines.
    i = end;
    while (i < s.length && /\s/.test(s[i])) i++;
  }

  return out;
}

async function enqueueChunk({
  userId,
  sourceKind,
  sourceUri,
  sourceMeta,
  titleOverride,
  importAs,
  chunkText,
  chunkIndex,
  chunkCount,
  s3
}) {
  const selectionText = (typeof chunkText === "string" ? chunkText : "").trim();
  if (!selectionText) return null;

  // Hard safety cap for DB/job payload + storage.
  const HARD_MAX_SELECTION_CHARS = 450000;
  const bounded = selectionText.length > HARD_MAX_SELECTION_CHARS
    ? selectionText.slice(0, HARD_MAX_SELECTION_CHARS)
    : selectionText;

  // Store snapshot text as evidence asset
  const assetId = crypto.randomUUID();
  const objectKey = `users/${userId}/assets/${assetId}.txt`;
  const mimeType = "text/plain";
  const bytes = Buffer.from(bounded, "utf8");
  const sizeBytes = bytes.length;

  await withTimeout(
    s3.send(new PutObjectCommand({
      Bucket: bucketName(),
      Key: objectKey,
      Body: bytes,
      ContentType: mimeType,
      CacheControl: "no-store"
    })),
    15000,
    "s3-put-chunk-text"
  );

  const baseTitle = (typeof titleOverride === "string" && titleOverride.trim())
    ? String(titleOverride).trim()
    : "Imported text";

  const title = (chunkCount && chunkCount > 1)
    ? `${baseTitle} [chunk ${chunkIndex + 1}/${chunkCount}]`.slice(0, 140)
    : baseTitle.slice(0, 140);

  await withTimeout(
    pool.query(
      `INSERT INTO media_assets (asset_id, owner_user_id, object_key, mime_type, size_bytes, title)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [assetId, userId, objectKey, mimeType, sizeBytes, title]
    ),
    8000,
    "db-insert-asset"
  );

  const documentId = crypto.randomUUID();
  await withTimeout(
    pool.query(
      `INSERT INTO documents (document_id, owner_user_id, asset_id, source_kind, source_uri, title, ingest_status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [documentId, userId, assetId, sourceKind, sourceUri, title]
    ),
    8000,
    "db-insert-document"
  );

  const parseRunId = crypto.randomUUID();
  await withTimeout(
    pool.query(
      `INSERT INTO document_parse_runs (parse_run_id, document_id, parser_version, status)
       VALUES ($1,$2,$3,'running')`,
      [parseRunId, documentId, "docparse-0.1"]
    ),
    8000,
    "db-insert-parse-run"
  );

  const jobId = crypto.randomUUID();
  const payload = {
    import_as: importAs,
    scope: sourceMeta?.scope || { mode: "text" },
    source: {
      kind: sourceKind,
      source_uri: sourceUri,
      ...(sourceMeta?.source || {})
    },
    text: bounded,
    budgets: { max_words: 3000, max_sentences: 1000, max_patterns: 1000, max_chars: 500000 }
  };

  await withTimeout(
    pool.query(
      `INSERT INTO docparse_jobs (job_id, parse_run_id, document_id, status, payload, available_at)
       VALUES ($1,$2,$3,'queued',$4::jsonb, now())`,
      [jobId, parseRunId, documentId, JSON.stringify(payload)]
    ),
    8000,
    "db-insert-docparse-job"
  );

  return {
    chunk_index: chunkIndex,
    selection_chars: bounded.length,
    document_id: documentId,
    asset_id: assetId,
    parse_run_id: parseRunId,
    job_id: jobId
  };
}

router.post("/v1/documents/ingest-text-chunked", requireSession, async (req, res) => {
  try {
    if (!storageConfigured()) return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_NOT_CONFIGURED" });

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const sourceKindRaw = req.body?.source_kind;
    const sourceKind = (typeof sourceKindRaw === "string" && sourceKindRaw.trim()) ? sourceKindRaw.trim() : "text";

    const sourceUriRaw = req.body?.source_uri;
    const sourceUri = (typeof sourceUriRaw === "string") ? sourceUriRaw.trim() : "";
    if (!sourceUri) return res.status(400).json({ ok: false, error: "SOURCE_URI_REQUIRED" });

    const importAs = normalizeImportAs(req.body?.import_as);

    // chunk_max_chars defaults to 200k; clamp to [20k, 450k]
    const rawChunk = clampInt(req.body?.chunk_max_chars, 200000);
    const chunkMaxChars = Math.min(450000, Math.max(20000, rawChunk));

    const scopeModeRaw = req.body?.scope?.mode;
    const scopeMode = (typeof scopeModeRaw === "string" && scopeModeRaw.trim()) ? scopeModeRaw.trim() : "text";

    const selectedText = (typeof req.body?.selected_text === "string") ? req.body.selected_text.trim() : "";
    if (!selectedText) return res.status(400).json({ ok: false, error: "SELECTION_REQUIRED" });

    const titleOverride = req.body?.title;

    // Build chunk plan from provided text
    const chunks = makeTextChunksByChars(selectedText, chunkMaxChars);
    if (!chunks.length) return res.status(400).json({ ok: false, error: "EMPTY_SELECTION" });

    const sourceMeta = {
      scope: { mode: scopeMode },
      source: {}
    };

    const s3 = makeS3Client();

    // Enqueue chunks sequentially (deterministic; simpler failure semantics)
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      const r = await enqueueChunk({
        userId,
        sourceKind,
        sourceUri,
        sourceMeta,
        titleOverride,
        importAs,
        chunkText: chunks[i],
        chunkIndex: i,
        chunkCount: chunks.length,
        s3
      });
      if (r) results.push(r);
    }

    return res.status(201).json({
      ok: true,
      source_kind: sourceKind,
      source_uri: sourceUri,
      title: (typeof titleOverride === "string" && titleOverride.trim()) ? String(titleOverride).trim().slice(0, 140) : "Imported text",
      chunk_max_chars: chunkMaxChars,
      chunks_enqueued: results.length,
      scope: { mode: scopeMode },
      chunks: results.map(x => ({
        chunk_index: x.chunk_index,
        selection_chars: x.selection_chars,
        document_id: x.document_id,
        parse_run_id: x.parse_run_id,
        job_id: x.job_id
      }))
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[ingest-text-chunked] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put-chunk-text")) return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_TIMEOUT" });
    if (msg.startsWith("timeout:db-")) return res.status(503).json({ ok: false, error: "DB_TIMEOUT" });

    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;