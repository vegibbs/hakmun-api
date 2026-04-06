// FILE: hakmun-api/routes/google_picker.js
// PURPOSE: Serve a hosted Google Picker page for drive.file doc selection
// ENDPOINTS:
//   POST /v1/google-picker/token  (requires Bearer session, returns { page_token })
//   GET  /v1/google-picker        (requires ?page_token=..., returns HTML page)
//
// Two-step auth pattern:
// 1. Client calls POST /v1/google-picker/token with its Bearer token → gets a short-lived page_token
// 2. Client opens GET /v1/google-picker?page_token=... in ASWebAuthenticationSession
//    (browser context can't set Authorization headers, so we use a query param token)
//
// The Picker page uses the user's Google OAuth access token (refreshed if needed)
// and the GOOGLE_PICKER_API_KEY to show a file picker filtered to Google Docs.
// On selection, redirects to hakmun://google-picker?doc_id=...&title=...&url=...
// which ASWebAuthenticationSession captures as its callback URL.

const express = require("express");
const crypto = require("crypto");
const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
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

// ---- Step 1: Issue a short-lived page token ----
// Client calls this with its normal Bearer auth. Returns a one-time-use token
// that the client passes as a query param when opening the Picker page in a browser.

router.post("/v1/google-picker/token", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    // Check Google connection exists
    const connR = await withTimeout(
      pool.query(
        `SELECT refresh_token FROM google_oauth_connections WHERE user_id = $1::uuid LIMIT 1`,
        [userId]
      ),
      8000,
      "db-check-google-conn"
    );

    if (!connR.rows?.[0]?.refresh_token) {
      return res.status(400).json({ ok: false, error: "GOOGLE_NOT_CONNECTED" });
    }

    // Generate a short-lived page token (5 minutes, one-time use)
    const pageToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await withTimeout(
      pool.query(
        `INSERT INTO google_picker_tokens (token, user_id, expires_at, used)
         VALUES ($1, $2::uuid, $3::timestamptz, false)`,
        [pageToken, userId, expiresAt.toISOString()]
      ),
      8000,
      "db-insert-picker-token"
    );

    return res.json({ ok: true, page_token: pageToken, expires_in: 300 });
  } catch (err) {
    console.error("[google-picker-token] failed:", String(err?.message || err));
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---- Step 2: Serve the Picker page ----
// Opened in ASWebAuthenticationSession. Validates page_token from query param.
// No Bearer header needed — the browser context can't set one.

router.get("/v1/google-picker", async (req, res) => {
  try {
    const pageToken = typeof req.query?.page_token === "string" ? req.query.page_token.trim() : "";
    if (!pageToken) return res.status(400).send("Missing page_token");

    // Validate and consume the page token
    const tokenR = await withTimeout(
      pool.query(
        `UPDATE google_picker_tokens
         SET used = true
         WHERE token = $1 AND used = false AND expires_at > now()
         RETURNING user_id`,
        [pageToken]
      ),
      8000,
      "db-validate-picker-token"
    );

    if (!tokenR.rows?.[0]?.user_id) {
      return res.status(401).send("Invalid or expired page token. Please try again from the app.");
    }

    const userId = tokenR.rows[0].user_id;

    const pickerApiKey = mustEnv("GOOGLE_PICKER_API_KEY");
    const clientId = mustEnv("GOOGLE_OAUTH_CLIENT_ID");

    const callbackScheme = typeof req.query?.callback_scheme === "string"
      ? req.query.callback_scheme.replace(/[^a-zA-Z0-9.-]/g, "")
      : "hakmun";

    // Load and refresh Google OAuth token
    const connR = await withTimeout(
      pool.query(
        `SELECT refresh_token, access_token, access_token_expires_at
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
      return res.status(400).send("Google account not connected. Please reconnect from the app.");
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

    const html = pickerPageHTML({
      accessToken,
      pickerApiKey,
      clientId,
      callbackScheme
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.status(200).send(html);
  } catch (err) {
    const msg = String(err?.message || err);

    if (msg.startsWith("google_refresh_failed:")) {
      return res.status(401).send("Google session expired. Please reconnect from the app.");
    }

    console.error("[google-picker] failed:", msg);
    return res.status(500).send("Internal error");
  }
});

function pickerPageHTML({ accessToken, pickerApiKey, clientId, callbackScheme }) {
  // Escape values for safe embedding in JS string literals
  const esc = (s) => String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/</g, "\\x3c")
    .replace(/>/g, "\\x3e");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Select a Google Doc</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f7;
      color: #1d1d1f;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1d1d1f; color: #f5f5f7; }
    }
    .status {
      text-align: center;
      font-size: 16px;
    }
    .error { color: #d32f2f; }
  </style>
</head>
<body>
  <div id="status" class="status">Loading Google Drive&hellip;</div>

  <script src="https://apis.google.com/js/api.js"></script>
  <script>
    var OAUTH_TOKEN = '${esc(accessToken)}';
    var API_KEY = '${esc(pickerApiKey)}';
    var CALLBACK_SCHEME = '${esc(callbackScheme)}';

    function onPickerApiLoad() {
      try {
        var docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(false)
          .setMimeTypes('application/vnd.google-apps.document');

        var picker = new google.picker.PickerBuilder()
          .addView(docsView)
          .setOAuthToken(OAUTH_TOKEN)
          .setDeveloperKey(API_KEY)
          .setCallback(pickerCallback)
          .setTitle('Select a Google Doc')
          .setMaxItems(1)
          .build();

        picker.setVisible(true);
        document.getElementById('status').style.display = 'none';
      } catch (e) {
        document.getElementById('status').className = 'status error';
        document.getElementById('status').textContent = 'Could not load the file picker. Please try again.';
      }
    }

    function pickerCallback(data) {
      if (data.action === google.picker.Action.PICKED) {
        var doc = data.docs[0];
        var callbackUrl = CALLBACK_SCHEME + '://google-picker'
          + '?doc_id=' + encodeURIComponent(doc.id || '')
          + '&url=' + encodeURIComponent(doc.url || '')
          + '&title=' + encodeURIComponent(doc.name || '');
        window.location.href = callbackUrl;
      } else if (data.action === google.picker.Action.CANCEL) {
        window.location.href = CALLBACK_SCHEME + '://google-picker?cancelled=1';
      }
    }

    gapi.load('picker', { callback: onPickerApiLoad });
  </script>
</body>
</html>`;
}

module.exports = router;
