// FILE: hakmun-api/routes/document_sources.js
// PURPOSE: Persist per-user “Saved Document Sources” for Documents sidebar (cross-device).
//
// ENDPOINTS:
//   GET  /v1/documents/sources
//   POST /v1/documents/sources   { source_kind: "google_doc", google_doc_url: "..." }
//
// NOTES:
// - Sidebar list persistence ONLY. No ingest snapshots, no parse jobs.
// - Viewer remains live: /v1/documents/google/view pulls live from Google per click.

const express = require("express");
const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

// Copied/consistent with google_docs_view.js patterns (NO DRIFT)

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

async function getValidGoogleAccessToken({ userId }) {
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
    const err = new Error("GOOGLE_NOT_CONNECTED");
    err.code = "GOOGLE_NOT_CONNECTED";
    throw err;
  }

  let accessToken = conn.access_token || null;
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
  const now = Date.now();
  const stillValid = accessToken && expiresAt && (expiresAt - now > 60_000);

  if (stillValid) return accessToken;

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

  return accessToken;
}

async function fetchGoogleDocTitle({ accessToken, fileId }) {
  const docsUrl = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`;
  const docsResp = await fetch(docsUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const docsJson = await docsResp.json().catch(() => ({}));
  if (!docsResp.ok) {
    logger.error("[document-sources] docs api failed", {
      fileId,
      status: docsResp.status,
      body: JSON.stringify(docsJson).slice(0, 500)
    });
    const err = new Error("GOOGLE_DOCS_GET_FAILED");
    err.code = "GOOGLE_DOCS_GET_FAILED";
    throw err;
  }

  return docsJson?.title || "Google Doc";
}

// GET /v1/documents/sources
router.get("/v1/documents/sources", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(
        `SELECT saved_source_id, owner_user_id, source_kind, source_key, source_uri, title, created_at, updated_at
           FROM saved_document_sources
          WHERE owner_user_id = $1::uuid
          ORDER BY updated_at DESC, created_at DESC`,
        [userId]
      ),
      8000,
      "db-list-saved-sources"
    );

    return res.json({ ok: true, sources: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[document-sources] list failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/documents/sources
router.post("/v1/documents/sources", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const sourceKind = typeof req.body?.source_kind === "string" ? req.body.source_kind.trim() : "google_doc";
    if (sourceKind !== "google_doc") {
      return res.status(400).json({ ok: false, error: "UNSUPPORTED_SOURCE_KIND" });
    }

    const url = typeof req.body?.google_doc_url === "string" ? req.body.google_doc_url.trim() : "";
    if (!url) return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });

    const fileId = extractGoogleDocFileId(url);
    if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_GOOGLE_DOC_LINK" });

    let accessToken;
    try {
      accessToken = await getValidGoogleAccessToken({ userId });
    } catch (e) {
      if (e?.code === "GOOGLE_NOT_CONNECTED" || String(e?.message || "").includes("GOOGLE_NOT_CONNECTED")) {
        return res.status(400).json({ ok: false, error: "GOOGLE_NOT_CONNECTED" });
      }
      throw e;
    }

    // Fetch title live (metadata only)
    const title = await fetchGoogleDocTitle({ accessToken, fileId });

    const upsertR = await withTimeout(
      pool.query(
        `INSERT INTO saved_document_sources (owner_user_id, source_kind, source_key, source_uri, title)
         VALUES ($1::uuid, 'google_doc', $2, $3, $4)
         ON CONFLICT (owner_user_id, source_kind, source_key)
         DO UPDATE SET
           source_uri = EXCLUDED.source_uri,
           title = EXCLUDED.title,
           updated_at = now()
         RETURNING saved_source_id, owner_user_id, source_kind, source_key, source_uri, title, created_at, updated_at`,
        [userId, fileId, url, title]
      ),
      8000,
      "db-upsert-saved-source"
    );

    return res.json({ ok: true, source: upsertR.rows?.[0] || null });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[document-sources] upsert failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;