// FILE: hakmun-api/routes/google_docs_ingest_chunked.js
// PURPOSE: Chunked ingest for large Google Docs (no export; Docs API only)
// ENDPOINT:
//   POST /v1/documents/google/ingest-chunked
//
// Body:
// {
//   "google_doc_url": "...",
//   "import_as": "all" | "vocab" | "sentences" | "patterns",
//   "chunk_max_chars": 200000,        // optional (default 200k, hard-capped <= 450k)
//   "start_block_index": 0,           // optional (default 0)
//   "end_block_index": 999999,        // optional (default: end of doc)
//   "title": "optional override"
// }
//
// Behavior:
// - Fetches doc blocks via Google Docs API
// - Splits into chunks by character budget (safe for huge docs)
// - For each chunk:
//   - Stores chunk text snapshot as text/plain asset
//   - Creates documents row (source_kind=google_doc, source_uri=google_doc_url)
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

function extractGoogleDocFileId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m1 = s.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return m1[1];
  const m2 = s.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return m2[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

async function refreshAccessToken(refreshToken) {
  const clientId = mustEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`google_refresh_failed:${JSON.stringify(json).slice(0, 500)}`);

  return {
    access_token: json.access_token,
    expires_in: Number(json.expires_in || 0),
    scope: json.scope || null
  };
}

function paragraphText(paragraph) {
  const elems = paragraph?.elements || [];
  let out = "";
  for (const el of elems) {
    const tr = el?.textRun;
    const content = tr?.content;
    if (typeof content === "string") out += content;
  }
  return out;
}

async function fetchDocBlocks(fileId, accessToken) {
  const docsUrl = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`;
  const resp = await fetch(docsUrl, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    logger.error("[google-ingest-chunked] docs api failed", {
      fileId,
      status: resp.status,
      body: JSON.stringify(json).slice(0, 500)
    });
    const e = new Error("google_docs_get_failed");
    e._status = resp.status;
    e._body = json;
    throw e;
  }

  const title = json?.title || "Google Doc";
  const blocks = [];
  const body = json?.body?.content || [];

  for (const c of body) {
    const p = c?.paragraph;
    if (!p) continue;

    let text = paragraphText(p).replace(/\r/g, "");
    text = text.trimEnd();
    if (!text.trim()) continue;

    const style = p?.paragraphStyle?.namedStyleType || "NORMAL_TEXT";
    blocks.push({ block_index: blocks.length, style, text });
  }

  return { title, blocks };
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

function makeChunksByChars(blocks, startIdx, endIdx, chunkMaxChars) {
  const out = [];
  const s = Math.max(0, startIdx);
  const e = Math.min(endIdx, blocks.length - 1);
  if (blocks.length === 0 || s > e) return out;

  let curStart = s;
  let curChars = 0;
  let curEnd = s - 1;

  for (let i = s; i <= e; i++) {
    const t = blocks[i]?.text || "";
    // +1 for newline join
    const add = (curChars === 0 ? 0 : 1) + t.length;

    // If single block exceeds budget, still take it alone (bounded later).
    if (curChars > 0 && (curChars + add) > chunkMaxChars) {
      out.push({ start_block_index: curStart, end_block_index: curEnd });
      curStart = i;
      curChars = 0;
      curEnd = i - 1;
    }

    curChars += ((curChars === 0 ? 0 : 1) + t.length);
    curEnd = i;
  }

  if (curEnd >= curStart) {
    out.push({ start_block_index: curStart, end_block_index: curEnd });
  }

  return out;
}

async function enqueueChunk({
  userId,
  googleDocUrl,
  fileId,
  docTitle,
  titleOverride,
  importAs,
  blocks,
  startIdx,
  endIdx,
  s3
}) {
  const slice = blocks.slice(startIdx, endIdx + 1);
  const selectionText = slice.map(b => b.text).join("\n").trim();
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

  const title =
    (typeof titleOverride === "string" && titleOverride.trim())
      ? String(titleOverride).trim().slice(0, 140)
      : `${docTitle} [blocks ${startIdx}-${endIdx}]`.slice(0, 140);

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
       VALUES ($1,$2,$3,'google_doc',$4,$5,'pending')`,
      [documentId, userId, assetId, googleDocUrl, title]
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
    scope: { mode: "blocks", start_block_index: startIdx, end_block_index: endIdx },
    source: { kind: "google_doc", file_id: fileId, google_doc_url: googleDocUrl, title: docTitle },
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
    start_block_index: startIdx,
    end_block_index: endIdx,
    selection_chars: bounded.length,
    document_id: documentId,
    asset_id: assetId,
    parse_run_id: parseRunId,
    job_id: jobId
  };
}

router.post("/v1/documents/google/ingest-chunked", requireSession, async (req, res) => {
  try {
    if (!storageConfigured()) return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_NOT_CONFIGURED" });

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const googleDocUrl = typeof req.body?.google_doc_url === "string" ? req.body.google_doc_url.trim() : "";
    if (!googleDocUrl) return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });

    const fileId = extractGoogleDocFileId(googleDocUrl);
    if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_GOOGLE_DOC_LINK" });

    const importAs = normalizeImportAs(req.body?.import_as);

    // chunk_max_chars defaults to 200k; clamp to [20k, 450k]
    const rawChunk = clampInt(req.body?.chunk_max_chars, 200000);
    const chunkMaxChars = Math.min(450000, Math.max(20000, rawChunk));

    const startIdx = Math.max(0, clampInt(req.body?.start_block_index, 0));
    const endIdxReq = clampInt(req.body?.end_block_index, 999999999);

    const titleOverride = req.body?.title;

    // OAuth connection
    const connR = await withTimeout(
      pool.query(
        `SELECT refresh_token, access_token, access_token_expires_at, scopes
         FROM google_oauth_connections
         WHERE user_id = $1::uuid
         LIMIT 1`,
        [userId]
      ),
      8000,
      "db-get-google-conn"
    );
    const conn = connR.rows?.[0];
    if (!conn?.refresh_token) return res.status(400).json({ ok: false, error: "GOOGLE_NOT_CONNECTED" });

    // Ensure access token
    let accessToken = conn.access_token || null;
    const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
    const now = Date.now();
    const stillValid = accessToken && expiresAt && (expiresAt - now > 60_000);

    if (!stillValid) {
      const refreshed = await refreshAccessToken(conn.refresh_token);
      accessToken = refreshed.access_token;

      const expiresIso = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
      await withTimeout(
        pool.query(
          `UPDATE google_oauth_connections
             SET access_token = $2,
                 access_token_expires_at = $3::timestamptz,
                 scopes = COALESCE($4, scopes),
                 updated_at = now()
           WHERE user_id = $1::uuid`,
          [userId, accessToken, expiresIso, refreshed.scope]
        ),
        8000,
        "db-update-google-token"
      );
    }

    // Fetch blocks
    const { title: docTitle, blocks } = await fetchDocBlocks(fileId, accessToken);
    if (!blocks.length) return res.status(400).json({ ok: false, error: "EMPTY_DOC" });

    const endIdx = Math.min(endIdxReq, blocks.length - 1);
    if (startIdx > endIdx) return res.status(400).json({ ok: false, error: "INVALID_BLOCK_RANGE" });

    // Plan chunks
    const plan = makeChunksByChars(blocks, startIdx, endIdx, chunkMaxChars);
    if (!plan.length) return res.status(400).json({ ok: false, error: "EMPTY_SELECTION" });

    const s3 = makeS3Client();

    // Enqueue chunks sequentially (deterministic; simpler failure semantics)
    const results = [];
    for (const ch of plan) {
      const r = await enqueueChunk({
        userId,
        googleDocUrl,
        fileId,
        docTitle,
        titleOverride,
        importAs,
        blocks,
        startIdx: ch.start_block_index,
        endIdx: ch.end_block_index,
        s3
      });
      if (r) results.push(r);
    }

    return res.status(201).json({
      ok: true,
      file_id: fileId,
      google_doc_url: googleDocUrl,
      title: docTitle,
      chunk_max_chars: chunkMaxChars,
      start_block_index: startIdx,
      end_block_index: endIdx,
      chunks_enqueued: results.length,
      chunks: results.map(x => ({
        start_block_index: x.start_block_index,
        end_block_index: x.end_block_index,
        selection_chars: x.selection_chars,
        document_id: x.document_id,
        parse_run_id: x.parse_run_id,
        job_id: x.job_id
      }))
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[google-ingest-chunked] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put-chunk-text")) return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_TIMEOUT" });
    if (msg.startsWith("timeout:db-")) return res.status(503).json({ ok: false, error: "DB_TIMEOUT" });
    if (msg.startsWith("google_refresh_failed:")) return res.status(401).json({ ok: false, error: "GOOGLE_REFRESH_FAILED" });
    if (msg === "google_docs_get_failed") return res.status(403).json({ ok: false, error: "GOOGLE_DOCS_GET_FAILED" });

    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;