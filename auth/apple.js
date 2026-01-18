// auth/apple.js — HakMun API (v0.12)
// Apple Sign-In verification (fail-fast)

const { createRemoteJWKSet, jwtVerify } = require("jose");
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

  // Optional legacy bridge signal: Apple email is sometimes present (first auth, relay email, etc.)
  // This is NOT identity authority; it is only used to migrate legacy rows once.
  const email = typeof payload.email === "string" ? payload.email : null;

  return { appleSubject: payload.sub, audience: aud, email };
}

module.exports = {
  verifyAppleToken,
  APPLE_CLIENT_IDS
};