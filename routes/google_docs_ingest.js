// FILE: hakmun-api/routes/google_docs_ingest.js
// PURPOSE: D2.3b — Ingest a selected Google Doc block range (store actual text; enqueue parse job)
// ENDPOINT:
//   POST /v1/documents/google/ingest
//
// Body:
// {
//   "google_doc_url": "...",
//   "start_block_index": 0,
//   "end_block_index": 50,
//   "import_as": "all" | "vocab" | "sentences" | "patterns",
//   "title": "optional override"
// }
//
// Behavior:
// - Uses Google Docs API to fetch doc structure
// - Extracts blocks in the requested range
// - Stores selection text as a text asset in bucket + media_assets
// - Creates documents row pointing to that asset (source_kind=google_doc)
// - Creates parse_run + docparse_job with payload INCLUDING the extracted text
// - No DOCX export, avoids exportSizeLimitExceeded

const express = require("express");
const crypto = require("crypto");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

const { analyzeTextForImport } = require("../util/openai");

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
    logger.error("[google-ingest] docs api failed", { fileId, status: resp.status, body: JSON.stringify(json).slice(0, 500) });
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

router.post("/v1/documents/google/ingest", requireSession, async (req, res) => {
  try {
    if (!storageConfigured()) return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_NOT_CONFIGURED" });

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const googleDocUrl = typeof req.body?.google_doc_url === "string" ? req.body.google_doc_url.trim() : "";
    if (!googleDocUrl) return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });

    const fileId = extractGoogleDocFileId(googleDocUrl);
    if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_GOOGLE_DOC_LINK" });

    const importAsRaw = typeof req.body?.import_as === "string" ? req.body.import_as.trim() : "all";
    const importAs = ["all", "vocab", "sentences", "patterns"].includes(importAsRaw) ? importAsRaw : "all";

    const scopeModeRaw = req.body?.scope?.mode;
    const scopeMode = (typeof scopeModeRaw === "string" && scopeModeRaw.trim()) ? scopeModeRaw.trim() : "blocks";

    // Common selection output
    const MAX_SELECTION_CHARS = 500000; // same order as parse budget
    let selectionTextBounded = "";
    let docTitle = "Google Doc";
    let blocksTotal = null;
    let s = null;
    let endClamped = null;
    let scopeObj = { mode: scopeMode };

    if (scopeMode === "highlight") {
      const selectedText = (typeof req.body?.selected_text === "string") ? req.body.selected_text.trim() : "";
      if (!selectedText) {
        return res.status(400).json({ ok: false, error: "SELECTION_REQUIRED" });
      }

      selectionTextBounded = selectedText.length > MAX_SELECTION_CHARS
        ? selectedText.slice(0, MAX_SELECTION_CHARS)
        : selectedText;

      scopeObj = { mode: "highlight" };

      // -----------------------------
      // SYNCHRONOUS HIGHLIGHT IMPORT
      // -----------------------------

      // Analyze text immediately via OpenAI using doc_import profile (preview-only, no DB writes)
      const analysis = await analyzeTextForImport({
        text: selectionTextBounded,
        importAs,
        profile: "doc_import",
        glossLang: null
      });

      return res.status(200).json({
        ok: true,
        scope: scopeObj,
        selection_chars: selectionTextBounded.length,
        preview: {
          vocabulary: analysis.vocabulary || [],
          sentences: analysis.sentences || [],
          patterns: analysis.patterns || [],
          fragments: analysis.fragments || [],
          gloss_lang: analysis.gloss_lang || null
        }
      });
    } else {
      const startIdx = Number(req.body?.start_block_index);
      const endIdx = Number(req.body?.end_block_index);

      if (!Number.isFinite(startIdx) || !Number.isFinite(endIdx)) {
        return res.status(400).json({ ok: false, error: "BLOCK_RANGE_REQUIRED" });
      }
      s = Math.max(0, Math.floor(startIdx));
      const e = Math.max(0, Math.floor(endIdx));
      if (e < s) return res.status(400).json({ ok: false, error: "INVALID_BLOCK_RANGE" });

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
      const fetched = await fetchDocBlocks(fileId, accessToken);
      docTitle = fetched.title;
      const blocks = fetched.blocks;
      blocksTotal = blocks.length;

      if (s >= blocks.length) {
        return res.status(400).json({ ok: false, error: "START_OUT_OF_RANGE", blocks: blocks.length });
      }
      endClamped = Math.min(e, blocks.length - 1);

      const slice = blocks.slice(s, endClamped + 1);
      const selectionText = slice.map(b => b.text).join("\n").trim();

      if (!selectionText) {
        return res.status(400).json({ ok: false, error: "EMPTY_SELECTION" });
      }

      selectionTextBounded = selectionText.length > MAX_SELECTION_CHARS
        ? selectionText.slice(0, MAX_SELECTION_CHARS)
        : selectionText;

      scopeObj = { mode: "blocks", start_block_index: s, end_block_index: endClamped };
    }

    // Store selection text as evidence asset (text/plain)
    const assetId = crypto.randomUUID();
    const objectKey = `users/${userId}/assets/${assetId}.txt`;
    const mimeType = "text/plain";
    const bytes = Buffer.from(selectionTextBounded, "utf8");
    const sizeBytes = bytes.length;

    const s3 = makeS3Client();
    await withTimeout(
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: bytes,
          ContentType: mimeType,
          CacheControl: "no-store"
        })
      ),
      15000,
      "s3-put-selection-text"
    );

    const title =
      (typeof req.body?.title === "string" && req.body.title.trim())
        ? String(req.body.title).trim().slice(0, 140)
        : (scopeMode === "highlight"
            ? `${docTitle} [highlight]`
            : `${docTitle} [blocks ${s}-${endClamped}]`
          ).slice(0, 140);

    await withTimeout(
      pool.query(
        `INSERT INTO media_assets (asset_id, owner_user_id, object_key, mime_type, size_bytes, title)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [assetId, userId, objectKey, mimeType, sizeBytes, title]
      ),
      8000,
      "db-insert-asset"
    );

    // Create HakMun document pointing at this selection snapshot
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

    // Create parse run + job
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
      scope: scopeObj,
      source: { kind: "google_doc", file_id: fileId, google_doc_url: googleDocUrl, title: docTitle },
      text: selectionTextBounded,
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

    const resp = {
      ok: true,
      document_id: documentId,
      asset_id: assetId,
      parse_run_id: parseRunId,
      job_id: jobId,
      selection_chars: selectionTextBounded.length,
      scope: scopeObj
    };

    if (scopeMode !== "highlight") {
      resp.blocks_total = blocksTotal;
      resp.start_block_index = s;
      resp.end_block_index = endClamped;
    }

    return res.status(201).json(resp);
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[google-ingest] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put-selection-text")) return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_TIMEOUT" });
    if (msg.startsWith("timeout:db-")) return res.status(503).json({ ok: false, error: "DB_TIMEOUT" });
    if (msg.startsWith("google_refresh_failed:")) return res.status(401).json({ ok: false, error: "GOOGLE_REFRESH_FAILED" });
    if (msg === "google_docs_get_failed") return res.status(403).json({ ok: false, error: "GOOGLE_DOCS_GET_FAILED" });

    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;