// FILE: hakmun-api/routes/google_docs_snapshot.js
// PURPOSE: D2.x — Google Doc HTML snapshot (Docs API -> last 90 days sessions -> store as asset -> signed viewer URL)
// ENDPOINT:
//   POST /v1/documents/google/snapshot
//
// Behavior:
// - Requires user session (Bearer)
// - Uses per-user google_oauth_connections
// - Refreshes access token as needed
// - Fetches doc via Google Docs API (bounded fields)
// - Builds sessions from HEADING_1 dated headers (YYYY.M.D or YYYY.MM.DD)
// - Includes only sessions in the last 90 days
// - Generates HTML from the included blocks and stores it
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

/* -------------------- helpers for session slicing and HTML -------------------- */

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

function zeroPad2(n) {
  const x = String(n || "").trim();
  return x.length === 1 ? `0${x}` : x;
}

function extractSessionDate(text) {
  // Accept YYYY.M.D or YYYY.MM.DD
  const m = String(text || "").trim().match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})\b/);
  if (!m) return null;
  const yyyy = m[1];
  const mm = zeroPad2(m[2]);
  const dd = zeroPad2(m[3]);
  return `${yyyy}-${mm}-${dd}`;
}

function isSessionHeading(style, text) {
  if (typeof style !== "string") return false;
  if (style !== "HEADING_1") return false;
  const t = String(text || "").trim();
  return /^\d{4}\.\d{1,2}\.\d{1,2}\b/.test(t);
}

function buildSessionsFromDocBody(bodyContent) {
  const sessionHeaders = [];
  let globalIdx = -1;

  for (const c of (Array.isArray(bodyContent) ? bodyContent : [])) {
    const p = c?.paragraph;
    if (!p) continue;

    let text = paragraphText(p).replace(/\r/g, "");
    text = text.trimEnd();
    if (!text.trim()) continue;

    globalIdx += 1;

    const style = p?.paragraphStyle?.namedStyleType || "NORMAL_TEXT";
    if (isSessionHeading(style, text)) {
      const headingText = String(text || "").trim();
      sessionHeaders.push({
        heading_block_index: globalIdx,
        heading_text: headingText.slice(0, 140),
        session_date: extractSessionDate(headingText)
      });
    }
  }

  const sessions = [];
  for (let i = 0; i < sessionHeaders.length; i++) {
    const cur = sessionHeaders[i];
    const next = sessionHeaders[i + 1] || null;

    const start = cur.heading_block_index;
    const end = next ? (next.heading_block_index - 1) : globalIdx;

    sessions.push({
      session_index: i,
      session_date: cur.session_date,
      heading_block_index: cur.heading_block_index,
      heading_text: cur.heading_text,
      start_block_index: start,
      end_block_index: Math.max(start, end)
    });
  }

  return sessions;
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(dateObj, days) {
  const ms = dateObj.getTime() + (days * 24 * 60 * 60 * 1000);
  return new Date(ms);
}

function filterSessionsLastNDays(sessions, days) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];
  const today = new Date();
  const todayUtcMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const cutoff = addDaysUtc(todayUtcMidnight, -Math.max(1, Number(days) || 90));
  const cutoffIso = toIsoDate(cutoff);
  return sessions.filter(s => (s.session_date || "") >= cutoffIso);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlForBlock(style, text, sessionDate) {
  const t = escapeHtml(String(text || "").replace(/\r/g, "").trimEnd());
  if (!t.trim()) return "";
  const withBr = t.replace(/\n/g, "<br/>");

  const s = String(style || "NORMAL_TEXT");
  if (s === "HEADING_1") {
    const attr = sessionDate ? ` data-session-date="${escapeHtml(sessionDate)}"` : "";
    return `<h1${attr}>${withBr}</h1>`;
  }
  if (s === "HEADING_2") return `<h2>${withBr}</h2>`;
  if (s === "HEADING_3") return `<h3>${withBr}</h3>`;
  if (s === "HEADING_4") return `<h4>${withBr}</h4>`;
  if (s === "HEADING_5") return `<h5>${withBr}</h5>`;
  if (s === "HEADING_6") return `<h6>${withBr}</h6>`;
  return `<div class=\"p\">${withBr}</div>`;
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

    // Fetch doc via Google Docs API (bounded fields)
    const fields = [
      "title",
      "body(content(paragraph(paragraphStyle(namedStyleType),elements(textRun(content)))))"
    ].join(",");

    const docsUrl =
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`;

    const docsResp = await withTimeout(
      fetch(docsUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` }
      }),
      20000,
      "google-docs-get"
    );

    const docsJson = await withTimeout(docsResp.json().catch(() => ({})), 20000, "google-docs-get-body");

    if (!docsResp.ok) {
      logger.error("[google-snapshot] docs api failed", {
        fileId,
        status: docsResp.status,
        body: JSON.stringify(docsJson).slice(0, 500)
      });

      if (docsResp.status === 401 || docsResp.status === 403) {
        return res.status(401).json({
          ok: false,
          error: "GOOGLE_RECONNECT_REQUIRED",
          reconnect_hint: "/v1/auth/google/start"
        });
      }

      return res.status(403).json({ ok: false, error: "GOOGLE_DOCS_GET_FAILED" });
    }

    const title = String(docsJson?.title || "Google Doc").slice(0, 140);
    const body = docsJson?.body?.content || [];

    // Sessions derived from full doc structure (HEADING_1 dated headers)
    const sessionsAll = buildSessionsFromDocBody(body);
    if (!Array.isArray(sessionsAll) || sessionsAll.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "GOOGLE_DOC_FORMAT_REQUIRED",
        detail: "No dated HEADING_1 sessions found (expected YYYY.M.D or YYYY.MM.DD)."
      });
    }

    // Keep only the last 90 days of sessions
    const sessions = filterSessionsLastNDays(sessionsAll, 90);
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "NO_RECENT_SESSIONS",
        detail: "No sessions found in the last 90 days."
      });
    }

    // Include ranges for the selected sessions
    const includeRanges = sessions.map(s => ({ start: s.start_block_index, end: s.end_block_index }));

    function inIncludedRanges(globalIdx) {
      for (const r of includeRanges) {
        if (globalIdx >= r.start && globalIdx <= r.end) return true;
      }
      return false;
    }

    // Build HTML from included blocks with a strict budget
    const MAX_CHARS = 1_200_000; // snapshot text budget for 90-day window
    const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10MB

    let globalIdx = -1;
    let chars = 0;
    const parts = [];

    for (const c of (Array.isArray(body) ? body : [])) {
      const p = c?.paragraph;
      if (!p) continue;

      let text = paragraphText(p).replace(/\r/g, "");
      text = text.trimEnd();
      if (!text.trim()) continue;

      globalIdx += 1;
      if (!inIncludedRanges(globalIdx)) continue;

      const style = p?.paragraphStyle?.namedStyleType || "NORMAL_TEXT";

      // Track session date for h1 headings
      let blockSessionDate = null;
      if (isSessionHeading(style, text)) {
        blockSessionDate = extractSessionDate(text.trim());
      }

      // Budget: limit by text chars
      if (chars + text.length > MAX_CHARS) {
        const remaining = MAX_CHARS - chars;
        if (remaining <= 0) break;
        text = text.slice(0, remaining);
      }

      const html = htmlForBlock(style, text, blockSessionDate);
      if (html) parts.push(html);
      chars += Math.min(text.length, Math.max(0, MAX_CHARS - chars));

      if (chars >= MAX_CHARS) break;
    }

    const htmlDoc =
      "<!doctype html>" +
      "<html><head><meta charset=\"utf-8\"/>" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>" +
      "<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45;padding:16px;color:#1d1d1f;background:#fff;}h1{font-size:20px;margin:18px 0 10px;}h2{font-size:18px;margin:16px 0 8px;}h3{font-size:16px;margin:14px 0 6px;}.p{margin:6px 0;white-space:normal;}@media(prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f;}}</style>" +
      "</head><body>" +
      parts.join("\n") +
      "</body></html>";

    const buf = Buffer.from(htmlDoc, "utf8");
    const sizeBytes = buf.length;

    if (sizeBytes > MAX_HTML_BYTES) {
      return res.status(413).json({
        ok: false,
        error: "SNAPSHOT_TOO_LARGE_FOR_GOOGLE_DOC",
        detail: "The last 90 days slice is too large. Download as DOCX and upload to HakMun.",
        size_bytes: sizeBytes,
        max_bytes: MAX_HTML_BYTES
      });
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

    // Fetch previously imported texts for this document (match on file_id substring
    // since source_uri can vary with query params and hash fragments)
    let imported_texts = [];
    try {
      const itR = await pool.query(
        `SELECT DISTINCT ci.text
         FROM documents d
         JOIN document_content_item_links dcil ON dcil.document_id = d.document_id
         JOIN content_items ci ON ci.content_item_id = dcil.content_item_id
         WHERE d.owner_user_id = $1::uuid
           AND d.source_kind = 'google_doc'
           AND d.source_uri LIKE '%' || $2 || '%'`,
        [userId, fileId]
      );
      imported_texts = itR.rows.map(r => r.text);
    } catch (e) {
      logger.warn("[google-snapshot] imported_texts query failed", { err: String(e.message || e) });
    }

    return res.status(201).json({
      ok: true,
      file_id: fileId,
      google_doc_url: url,
      title,
      asset_id: assetID,
      viewer_url: viewerUrl,
      expiresIn: 900,
      sessions_included: sessions.length,
      days_window: 90,
      imported_texts
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
    if (msg.startsWith("timeout:google-docs-get") || msg.startsWith("timeout:google-docs-get-body")) {
      return res.status(503).json({ ok: false, error: "GOOGLE_DOCS_TIMEOUT" });
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