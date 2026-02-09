// FILE: hakmun-api/routes/google_docs_snapshot.js
// PURPOSE: D2.x — Export Google Doc as HTML snapshot (Drive API) + store as asset + signed viewer URL
// ENDPOINT:
//   POST /v1/documents/google/snapshot
//
// Behavior:
// - Requires user session (Bearer)
// - Uses per-user google_oauth_connections
// - Refreshes access token as needed
// - Exports doc as HTML via Drive API (files.export)
// - Stores HTML in object storage (private bucket)
// - Inserts media_assets row (mime_type=text/html)
// - Returns signed viewer_url for WKWebView

const express = require("express");
const crypto = require("crypto");

const { PutObjectCommand, GetObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

/* -------------------- storage helpers (copied from routes/assets.js) -------------------- */

function storageConfigured() {
  return Boolean(
    process.env.OBJECT_STORAGE_ENDPOINT &&
      process.env.OBJECT_STORAGE_BUCKET &&
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

function requireStorageOr503(res) {
  if (!storageConfigured()) {
    return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_NOT_CONFIGURED" });
  }
  return null;
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

/* -------------------- google helpers (copied from google_docs_view.js) -------------------- */

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
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

/* -------------------- route -------------------- */

router.post("/v1/documents/google/snapshot", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const url = typeof req.body?.google_doc_url === "string" ? req.body.google_doc_url.trim() : "";
    if (!url) return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });

    const fileId = extractGoogleDocFileId(url);
    if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_GOOGLE_DOC_LINK" });

    // Load OAuth connection
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

    // Access token validity check
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

    // Export via Drive API (HTML)
    const exportUrl =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export` +
      `?mimeType=${encodeURIComponent("text/html")}&supportsAllDrives=true`;

    const driveResp = await withTimeout(
      fetch(exportUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` }
      }),
      15000,
      "google-drive-export"
    );

    if (!driveResp.ok) {
      const errTxt = await driveResp.text().catch(() => "");
      logger.error("[google-snapshot] drive export failed", {
        fileId,
        status: driveResp.status,
        body: String(errTxt || "").slice(0, 500)
      });
      // If scope is missing or token invalid, treat as reconnect-required for UX.
      if (driveResp.status === 401 || driveResp.status === 403) {
        return res.status(401).json({
          ok: false,
          error: "GOOGLE_RECONNECT_REQUIRED",
          reconnect_hint: "/v1/auth/google/start"
        });
      }
      return res.status(403).json({ ok: false, error: "GOOGLE_DRIVE_EXPORT_FAILED" });
    }

    const ab = await withTimeout(driveResp.arrayBuffer(), 15000, "google-drive-export-body");
    const buf = Buffer.from(ab);
    const sizeBytes = buf.length;

    // Simple server-side guardrail (HTML snapshots should not be huge)
    const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10MB
    if (sizeBytes > MAX_HTML_BYTES) {
      return res.status(413).json({ ok: false, error: "SNAPSHOT_TOO_LARGE", size_bytes: sizeBytes });
    }

    // Write to object storage + insert media_assets
    const assetID = crypto.randomUUID();
    const objectKey = `users/${userId}/docs/google/${fileId}/${assetID}.html`;

    const s3 = makeS3Client();
    await withTimeout(
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: buf,
          ContentType: "text/html; charset=utf-8",
          CacheControl: "no-store"
        })
      ),
      15000,
      "s3-put-google-html"
    );

    await withTimeout(
      pool.query(
        `
        insert into media_assets (
          asset_id,
          owner_user_id,
          object_key,
          mime_type,
          size_bytes,
          title,
          language,
          duration_ms
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [assetID, userId, objectKey, "text/html", sizeBytes, "Google Doc Snapshot", null, null]
      ),
      8000,
      "db-insert-google-html-asset"
    );

    const viewerUrl = await withTimeout(
      getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucketName(), Key: objectKey }),
        { expiresIn: 60 * 15 }
      ),
      8000,
      "sign-google-html-url"
    );

    return res.status(201).json({
      ok: true,
      file_id: fileId,
      google_doc_url: url,
      asset_id: assetID,
      viewer_url: viewerUrl,
      expiresIn: 900
    });
  } catch (err) {
    const msg = String(err?.message || err);

    if (msg.startsWith("google_refresh_failed:")) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_RECONNECT_REQUIRED",
        reconnect_hint: "/v1/auth/google/start"
      });
    }
    if (msg.startsWith("timeout:google-drive-export") || msg.startsWith("timeout:google-drive-export-body")) {
      return res.status(503).json({ ok: false, error: "GOOGLE_DRIVE_TIMEOUT" });
    }

    if (msg.startsWith("timeout:s3-put-google-html")) {
      return res.status(503).json({ ok: false, error: "OBJECT_STORAGE_TIMEOUT" });
    }
    if (msg.startsWith("timeout:db-insert-google-html-asset")) {
      return res.status(503).json({ ok: false, error: "DB_TIMEOUT_INSERTING_ASSET" });
    }
    if (msg.startsWith("timeout:sign-google-html-url")) {
      return res.status(503).json({ ok: false, error: "TIMEOUT_SIGNING_URL" });
    }

    logger.error("[google-snapshot] failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;