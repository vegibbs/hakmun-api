// auth/google.js — HakMun API
// Google Sign-In: exchange authorization code for ID token, verify, extract identity.

const { createRemoteJWKSet, jwtVerify } = require("jose");
const { withTimeout } = require("../util/time");
const { logger } = require("../util/log");

const GOOGLE_SIGNIN_CLIENT_ID = process.env.GOOGLE_SIGNIN_CLIENT_ID;
const GOOGLE_SIGNIN_CLIENT_SECRET = process.env.GOOGLE_SIGNIN_CLIENT_SECRET;

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

/**
 * Exchange a Google authorization code for tokens, verify the ID token,
 * and return the user's identity.
 *
 * @param {string} code          - Authorization code from Google OAuth redirect
 * @param {string} redirectUri   - The redirect URI used in the auth request (must match exactly)
 * @returns {Promise<{googleSubject: string, audience: string, email: string|null, name: string|null}>}
 */
async function verifyGoogleCode(code, redirectUri) {
  if (!GOOGLE_SIGNIN_CLIENT_ID || !GOOGLE_SIGNIN_CLIENT_SECRET) {
    throw new Error("GOOGLE_SIGNIN_CLIENT_ID and GOOGLE_SIGNIN_CLIENT_SECRET must be set");
  }

  // Step 1: Exchange authorization code for tokens
  const tokenRes = await withTimeout(
    fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_SIGNIN_CLIENT_ID,
        client_secret: GOOGLE_SIGNIN_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    }),
    10000,
    "google-token-exchange"
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    logger.error("[google] token exchange failed", { status: tokenRes.status, body });
    throw new Error(`Google token exchange failed: ${tokenRes.status}`);
  }

  const tokenData = await tokenRes.json();
  const idToken = tokenData.id_token;
  if (!idToken) {
    throw new Error("Google token exchange did not return an id_token");
  }

  // Step 2: Verify the ID token
  const { payload } = await withTimeout(
    jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: GOOGLE_SIGNIN_CLIENT_ID
    }),
    6000,
    "google-jwtVerify"
  );

  if (!payload.sub) {
    throw new Error("Google ID token missing subject (sub)");
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  const name = typeof payload.name === "string" ? payload.name : null;

  return {
    googleSubject: payload.sub,
    audience: GOOGLE_SIGNIN_CLIENT_ID,
    email,
    name
  };
}

module.exports = { verifyGoogleCode };
