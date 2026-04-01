// FILE: hakmun-api/routes/google_picker.js
// PURPOSE: Serve Google Picker HTML page for native app WKWebView integration.
//
// ENDPOINT:
//   GET /v1/auth/google/picker?token=<bearer_token>
//
// The native app opens this URL in a WKWebView. The page loads the Google Picker
// JS API, lets the user select one or more Google Docs, then posts the selected
// file metadata back via window.webkit.messageHandlers.pickerResult.

const express = require("express");
const { pool } = require("../db/pool");
const { withTimeout } = require("../util/time");

const router = express.Router();

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
    expires_in: Number(json.expires_in || 0)
  };
}

// GET /v1/auth/google/picker?token=<bearer_token>
// Token is passed as query param because WKWebView loadRequest doesn't easily
// set Authorization headers on the initial HTML page load.
router.get("/v1/auth/google/picker", async (req, res) => {
  try {
    const token = typeof req.query?.token === "string" ? req.query.token.trim() : "";
    if (!token) return res.status(401).send("Missing token");

    // Validate the bearer token to get the user
    const { verifySessionJWT } = require("../auth/session");
    let decoded;
    try {
      decoded = await verifySessionJWT(token);
    } catch {
      return res.status(401).send("Invalid token");
    }
    if (decoded.typ !== "access" || !decoded.userID) return res.status(401).send("Invalid token");
    const userId = decoded.userID;

    // Get Google OAuth connection
    const connR = await withTimeout(
      pool.query(
        `SELECT refresh_token, access_token, access_token_expires_at
         FROM google_oauth_connections WHERE user_id = $1::uuid LIMIT 1`,
        [userId]
      ),
      8000,
      "db-get-google-conn-picker"
    );

    const conn = connR.rows?.[0];
    if (!conn?.refresh_token) {
      return res.status(400).send("Google not connected");
    }

    let accessToken = conn.access_token || null;
    const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
    const stillValid = accessToken && expiresAt && (expiresAt - Date.now() > 60_000);

    if (!stillValid) {
      const refreshed = await refreshAccessToken(conn.refresh_token);
      accessToken = refreshed.access_token;
      const expiresIso = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
      await pool.query(
        `UPDATE google_oauth_connections
           SET access_token = $2, access_token_expires_at = $3::timestamptz, updated_at = now()
         WHERE user_id = $1::uuid`,
        [userId, accessToken, expiresIso]
      );
    }

    const clientId = mustEnv("GOOGLE_OAUTH_CLIENT_ID");
    const apiKey = mustEnv("GOOGLE_PICKER_API_KEY");
    const appId = mustEnv("GOOGLE_CLOUD_PROJECT_NUMBER");

    // Serve the Picker HTML
    const html = buildPickerHTML({ apiKey, clientId, accessToken, appId });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (err) {
    console.error("google picker page failed:", err);
    return res.status(500).send("Internal error");
  }
});

function buildPickerHTML({ apiKey, clientId, accessToken, appId }) {
  // Escape values for safe embedding in JS strings
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pick Google Docs</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: #1a1a1a;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .loading {
      text-align: center;
    }
    .loading p {
      margin-top: 12px;
      font-size: 15px;
      color: #999;
    }
    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #333;
      border-top-color: #888;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error {
      color: #ff6b6b;
      text-align: center;
      font-size: 15px;
    }
    .cancel-btn {
      margin-top: 20px;
      padding: 10px 24px;
      background: #333;
      color: #e0e0e0;
      border: 1px solid #555;
      border-radius: 8px;
      font-size: 15px;
      cursor: pointer;
    }
    .cancel-btn:hover { background: #444; }
  </style>
</head>
<body>
  <div class="loading" id="loading">
    <div class="spinner"></div>
    <p>Opening file picker…</p>
  </div>
  <div class="error" id="error" style="display:none"></div>
  <button class="cancel-btn" id="cancelBtn" style="display:none" onclick="sendCancel()">Cancel</button>

  <script>
    // Relay console logs to native for debugging
    const _origLog = console.log;
    const _origErr = console.error;
    function nativeLog(level, args) {
      try {
        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickerLog) {
          window.webkit.messageHandlers.pickerLog.postMessage(level + ': ' + Array.from(args).join(' '));
        }
      } catch(e) {}
    }
    console.log = function() { nativeLog('LOG', arguments); _origLog.apply(console, arguments); };
    console.error = function() { nativeLog('ERR', arguments); _origErr.apply(console, arguments); };
    window.onerror = function(msg, url, line) { nativeLog('ERR', ['Uncaught: ' + msg + ' at ' + url + ':' + line]); };

    const ACCESS_TOKEN = '${esc(accessToken)}';
    const API_KEY = '${esc(apiKey)}';
    const APP_ID = '${esc(appId)}';

    // Send results back to the native app via WKWebView message handler
    function sendResult(files) {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickerResult) {
        window.webkit.messageHandlers.pickerResult.postMessage(JSON.stringify({
          action: 'picked',
          files: files
        }));
      }
    }

    function sendCancel() {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pickerResult) {
        window.webkit.messageHandlers.pickerResult.postMessage(JSON.stringify({
          action: 'cancelled'
        }));
      }
    }

    function showError(msg) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'block';
      document.getElementById('error').textContent = msg;
      document.getElementById('cancelBtn').style.display = 'inline-block';
    }

    // Load Google Picker API
    function loadPickerApi() {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://apis.google.com/js/api.js';
        script.onload = () => {
          gapi.load('picker', { callback: resolve, onerror: reject });
        };
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    async function openPicker() {
      try {
        await loadPickerApi();

        const docsView = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS)
          .setIncludeFolders(false)
          .setSelectFolderEnabled(false)
          .setMode(google.picker.DocsViewMode.LIST);

        const picker = new google.picker.PickerBuilder()
          .setAppId(APP_ID)
          .setOAuthToken(ACCESS_TOKEN)
          .setDeveloperKey(API_KEY)
          .addView(docsView)
          .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
          .setCallback(pickerCallback)
          .setTitle('Select Google Docs to import')
          .build();

        document.getElementById('loading').style.display = 'none';
        picker.setVisible(true);
      } catch (err) {
        showError('Could not load the file picker. Please try again.');
        console.error('Picker load error:', err);
      }
    }

    function pickerCallback(data) {
      if (data.action === google.picker.Action.PICKED) {
        const files = data.docs.map(doc => ({
          id: doc.id,
          name: doc.name,
          url: doc.url,
          mimeType: doc.mimeType
        }));
        sendResult(files);
      } else if (data.action === google.picker.Action.CANCEL) {
        sendCancel();
      }
    }

    openPicker();
  </script>
</body>
</html>`;
}

module.exports = router;
