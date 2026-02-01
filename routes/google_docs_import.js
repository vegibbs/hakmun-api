// FILE: hakmun-api/routes/google_docs_import.js
// PURPOSE: D2.3 — Import Google Doc by link (export -> asset -> document -> parse_run -> job enqueue)

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

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
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
  if (!resp.ok) {
    throw new Error(`google_refresh_failed:${JSON.stringify(json).slice(0, 500)}`);
  }

  return {
    access_token: json.access_token,
    expires_in: Number(json.expires_in || 0),
    scope: json.scope || null
  };
}

// IMPORTANT: supportsAllDrives=true so Shared Drives work
async function googleDriveGetMeta(fileId, accessToken) {
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?fields=id,name,modifiedTime,mimeType&supportsAllDrives=true`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Keep detail in logs; return a stable error to client.
    logger.error("[google-import][files.get] failed", {
      fileId,
      status: resp.status,
      body: JSON.stringify(json).slice(0, 500)
    });
    throw new Error("google_files_get_failed");
  }
  return json;
}

// IMPORTANT: supportsAllDrives=true so Shared Drives work
async function googleDriveExportDocx(fileId, accessToken) {
  const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const url =
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export` +
    `?mimeType=${encodeURIComponent(mime)}&supportsAllDrives=true`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    logger.error("[google-import][export] failed", {
      fileId,
      status: resp.status,
      body: txt.slice(0, 500)
    });
    throw new Error("google_export_failed");
  }

  const ab = await resp.arrayBuffer();
  const buf = Buffer.from(ab);
  return { buffer: buf, mime_type: mime, size_bytes: buf.length };
}

router.post("/v1/documents/google/import-link", requireSession, async (req, res) => {
  try {
    if (!storageConfigured()) {
      return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_NOT_CONFIGURED" });
    }

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const googleDocUrl = typeof req.body?.google_doc_url === "string" ? req.body.google_doc_url.trim() : "";
    if (!googleDocUrl) return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });

    const fileId = extractGoogleDocFileId(googleDocUrl);
    if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_GOOGLE_DOC_LINK" });

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
    if (!conn?.refresh_token) {
      return res.status(400).json({ ok: false, error: "GOOGLE_NOT_CONNECTED" });
    }

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

    const meta = await googleDriveGetMeta(fileId, accessToken);

    const title =
      (typeof req.body?.title === "string" && req.body.title.trim())
        ? String(req.body.title).trim().slice(0, 140)
        : String(meta?.name || "Google Doc").slice(0, 140);

    const exported = await googleDriveExportDocx(fileId, accessToken);

    const MAX_DOCX_BYTES = 200 * 1024 * 1024;
    if (exported.size_bytes > MAX_DOCX_BYTES) {
      return res.status(413).json({
        ok: false,
        error: "DOC_TOO_LARGE",
        size_bytes: exported.size_bytes,
        max_bytes: MAX_DOCX_BYTES
      });
    }

    const assetId = crypto.randomUUID();
    const objectKey = `users/${userId}/assets/${assetId}.docx`;

    logger.info("[google-import][start]", { rid: req._rid, userId, fileId, assetId, size_bytes: exported.size_bytes });

    const s3 = makeS3Client();
    await withTimeout(
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: exported.buffer,
          ContentType: exported.mime_type,
          CacheControl: "no-store"
        })
      ),
      30000,
      "s3-put-google-docx"
    );

    await withTimeout(
      pool.query(
        `
        INSERT INTO media_assets (
          asset_id, owner_user_id, object_key, mime_type, size_bytes, title
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [assetId, userId, objectKey, exported.mime_type, exported.size_bytes, title]
      ),
      8000,
      "db-insert-asset"
    );

    const documentId = crypto.randomUUID();
    await withTimeout(
      pool.query(
        `
        INSERT INTO documents (
          document_id, owner_user_id, asset_id, source_kind, source_uri, title, ingest_status
        )
        VALUES ($1,$2,$3,'google_doc',$4,$5,'pending')
        `,
        [documentId, userId, assetId, googleDocUrl, title]
      ),
      8000,
      "db-insert-document"
    );

    const parseRunId = crypto.randomUUID();
    const parserVersion = "docparse-0.1";
    await withTimeout(
      pool.query(
        `
        INSERT INTO document_parse_runs (parse_run_id, document_id, parser_version, status)
        VALUES ($1,$2,$3,'running')
        `,
        [parseRunId, documentId, parserVersion]
      ),
      8000,
      "db-insert-parse-run"
    );

    const jobId = crypto.randomUUID();
    const payload = {
      import_as: "all",
      scope: { mode: "whole" },
      budgets: { max_words: 3000, max_sentences: 1000, max_patterns: 1000, max_chars: 500000 },
      source: { kind: "google_doc", file_id: fileId }
    };

    await withTimeout(
      pool.query(
        `
        INSERT INTO docparse_jobs (job_id, parse_run_id, document_id, status, payload, available_at)
        VALUES ($1,$2,$3,'queued',$4::jsonb, now())
        `,
        [jobId, parseRunId, documentId, JSON.stringify(payload)]
      ),
      8000,
      "db-insert-docparse-job"
    );

    logger.info("[google-import][ok]", { rid: req._rid, userId, documentId, parseRunId, jobId, assetId });

    return res.status(201).json({
      ok: true,
      document_id: documentId,
      asset_id: assetId,
      parse_run_id: parseRunId,
      job_id: jobId,
      title
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[google-import] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put-google-docx")) return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_TIMEOUT" });
    if (msg.startsWith("timeout:db-")) return res.status(503).json({ ok: false, error: "DB_TIMEOUT" });
    if (msg.startsWith("google_refresh_failed:")) return res.status(401).json({ ok: false, error: "GOOGLE_REFRESH_FAILED" });

    if (msg === "google_files_get_failed") return res.status(403).json({ ok: false, error: "GOOGLE_FILES_GET_FAILED" });
    if (msg === "google_export_failed") return res.status(403).json({ ok: false, error: "GOOGLE_EXPORT_FAILED" });

    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;