// FILE: hakmun-api/routes/google_oauth.js
// PURPOSE: D2.2 — Google OAuth connect (per-user) for Google Docs import/view
// ENDPOINTS:
//   GET /v1/auth/google/start        (returns auth_url JSON)
//   GET /v1/auth/google/callback     (stores tokens)
//
// Scopes (locked):
// - drive.readonly (file access + export metadata)
// - documents.readonly (Docs API read-only viewer)

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signState(payloadObj, secret) {
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const payloadB64 = b64url(payload);
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const sigB64 = b64url(sig);
  return `${payloadB64}.${sigB64}`;
}

function verifyState(state, secret) {
  if (!state || typeof state !== "string") return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const expectedSigB64 = b64url(expectedSig);

  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSigB64);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  try {
    const json = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// GET /v1/auth/google/start
router.get("/v1/auth/google/start", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const clientId = mustEnv("GOOGLE_OAUTH_CLIENT_ID");
    const redirectUri = mustEnv("GOOGLE_OAUTH_REDIRECT_URI");
    const stateSecret = mustEnv("GOOGLE_OAUTH_STATE_SECRET");

    const scope = [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly"
    ].join(" ");

    const nonce = crypto.randomBytes(16).toString("hex");
    const state = signState({ uid: userId, nonce, ts: Date.now() }, stateSecret);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return res.json({ ok: true, auth_url: authUrl });
  } catch (err) {
    console.error("google oauth start failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /v1/auth/google/callback
router.get("/v1/auth/google/callback", async (req, res) => {
  try {
    const code = typeof req.query?.code === "string" ? req.query.code : "";
    const state = typeof req.query?.state === "string" ? req.query.state : "";
    const oauthError = typeof req.query?.error === "string" ? req.query.error : "";

    if (oauthError) return res.status(400).send(`Google OAuth error: ${oauthError}`);
    if (!code) return res.status(400).send("Missing code");

    const clientId = mustEnv("GOOGLE_OAUTH_CLIENT_ID");
    const clientSecret = mustEnv("GOOGLE_OAUTH_CLIENT_SECRET");
    const redirectUri = mustEnv("GOOGLE_OAUTH_REDIRECT_URI");
    const stateSecret = mustEnv("GOOGLE_OAUTH_STATE_SECRET");

    const parsed = verifyState(state, stateSecret);
    if (!parsed || !parsed.uid) return res.status(400).send("Invalid state");
    const userId = parsed.uid;

    const tokenParams = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    });

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString()
    });

    const tokenJson = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok) {
      console.error("google oauth token exchange failed:", tokenJson);
      return res.status(400).send("Token exchange failed");
    }

    const accessToken = tokenJson.access_token || null;
    const refreshToken = tokenJson.refresh_token || null;
    const expiresIn = tokenJson.expires_in || null;
    const scopeStr = tokenJson.scope || "";

    const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null;

    const existing = await dbQuery(
      `SELECT refresh_token FROM google_oauth_connections WHERE user_id = $1::uuid`,
      [userId]
    );

    const existingRefresh = existing.rows?.[0]?.refresh_token || null;
    const finalRefresh = refreshToken || existingRefresh;

    if (!finalRefresh) {
      return res
        .status(400)
        .send("No refresh_token returned. Remove HakMun access in Google Account permissions and try again.");
    }

    await dbQuery(
      `
      INSERT INTO google_oauth_connections (
        user_id, scopes, refresh_token, access_token, access_token_expires_at, created_at, updated_at
      )
      VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz, now(), now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        scopes = EXCLUDED.scopes,
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        updated_at = now()
      `,
      [userId, scopeStr, finalRefresh, accessToken, expiresAt]
    );

    return res.status(200).send("Google connected. You can return to HakMun.");
  } catch (err) {
    console.error("google oauth callback failed:", err);
    return res.status(500).send("Internal error");
  }
});

module.exports = router;