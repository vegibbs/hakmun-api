// auth/apple.js — HakMun API (v0.13)
// Apple Sign-In verification (fail-fast)
// Supports two flows:
//   1. Native: client sends identityToken (JWT) directly → verifyAppleToken()
//   2. Web:    client sends authorization code + redirectUri → verifyAppleCode()

const { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } = require("jose");
const { withTimeout } = require("../util/time");
const { logger } = require("../util/log");

// Env (fail-fast parity)
const rawClientIDs = process.env.APPLE_CLIENT_IDS;
if (!rawClientIDs || String(rawClientIDs).trim() === "") {
  throw new Error("Missing required environment variable: APPLE_CLIENT_IDS");
}

const APPLE_CLIENT_IDS = String(rawClientIDs)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

// Web flow env vars — optional (only needed when web sign-in is enabled)
const APPLE_WEB_SERVICE_ID = process.env.APPLE_WEB_SERVICE_ID || null;
const APPLE_WEB_TEAM_ID = process.env.APPLE_WEB_TEAM_ID || null;
const APPLE_WEB_KEY_ID = process.env.APPLE_WEB_KEY_ID || null;
const APPLE_WEB_KEY_B64 = process.env.APPLE_WEB_KEY_B64 || null;

/**
 * Generate the Apple client secret JWT for the web code exchange.
 * Apple requires this instead of a static client secret.
 * See: https://developer.apple.com/documentation/sign_in_with_apple/generate_and_validate_tokens
 */
let _cachedKey = null;
async function getAppleClientSecret() {
  if (!APPLE_WEB_SERVICE_ID || !APPLE_WEB_TEAM_ID || !APPLE_WEB_KEY_ID || !APPLE_WEB_KEY_B64) {
    throw new Error("Apple web sign-in env vars not configured (APPLE_WEB_SERVICE_ID, APPLE_WEB_TEAM_ID, APPLE_WEB_KEY_ID, APPLE_WEB_KEY_B64)");
  }

  if (!_cachedKey) {
    const pem = Buffer.from(APPLE_WEB_KEY_B64, "base64").toString("utf-8");
    _cachedKey = await importPKCS8(pem, "ES256");
  }

  const now = Math.floor(Date.now() / 1000);
  const secret = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: APPLE_WEB_KEY_ID })
    .setIssuer(APPLE_WEB_TEAM_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 86400) // 24 hours (Apple allows up to 6 months)
    .setAudience("https://appleid.apple.com")
    .setSubject(APPLE_WEB_SERVICE_ID)
    .sign(_cachedKey);

  return secret;
}

/**
 * Native flow: verify an Apple identity token (JWT) directly.
 */
async function verifyAppleToken(identityToken) {
  const t0 = Date.now();

  const { payload } = await withTimeout(
    jwtVerify(identityToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: APPLE_CLIENT_IDS
    }),
    6000,
    "apple-jwtVerify"
  );

  const ms = Date.now() - t0;
  logger.info("[apple] jwtVerify ok", { ms });

  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (!aud || !APPLE_CLIENT_IDS.includes(aud)) {
    throw new Error(`Apple token audience not allowed: ${String(aud)}`);
  }
  if (!payload.sub) {
    throw new Error("Apple token missing subject (sub)");
  }

  const email = typeof payload.email === "string" ? payload.email : null;

  return { appleSubject: payload.sub, audience: aud, email };
}

/**
 * Web flow: exchange an authorization code with Apple's token endpoint,
 * then verify the resulting ID token.
 */
async function verifyAppleCode(code, redirectUri) {
  const clientSecret = await getAppleClientSecret();

  // Step 1: Exchange authorization code for tokens
  const tokenRes = await withTimeout(
    fetch("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: APPLE_WEB_SERVICE_ID,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    }),
    10000,
    "apple-token-exchange"
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    logger.error("[apple] token exchange failed", { status: tokenRes.status, body });
    throw new Error(`Apple token exchange failed: ${tokenRes.status}`);
  }

  const tokenData = await tokenRes.json();
  const idToken = tokenData.id_token;
  if (!idToken) {
    throw new Error("Apple token exchange did not return an id_token");
  }

  // Step 2: Verify the ID token
  const { payload } = await withTimeout(
    jwtVerify(idToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: APPLE_WEB_SERVICE_ID
    }),
    6000,
    "apple-web-jwtVerify"
  );

  if (!payload.sub) {
    throw new Error("Apple ID token missing subject (sub)");
  }

  const email = typeof payload.email === "string" ? payload.email : null;

  return {
    appleSubject: payload.sub,
    audience: APPLE_WEB_SERVICE_ID,
    email
  };
}

module.exports = {
  verifyAppleToken,
  verifyAppleCode,
  APPLE_CLIENT_IDS
};