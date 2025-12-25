const express = require("express");
const OpenAI = require("openai");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

/* ------------------------------------------------------------------
   OpenAI (server-side only)
------------------------------------------------------------------ */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ------------------------------------------------------------------
   Postgres (Railway)
------------------------------------------------------------------ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

/* ------------------------------------------------------------------
   Apple Sign In verification
------------------------------------------------------------------ */

const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

async function verifyAppleToken(identityToken) {
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: "https://appleid.apple.com",
    audience: process.env.APPLE_CLIENT_ID
  });
  return payload; // includes `sub`
}

/* ------------------------------------------------------------------
   Auth middleware
------------------------------------------------------------------ */
async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "missing authorization token" });
    }

    const token = header.slice("Bearer ".length);
    const payload = await verifyAppleToken(token);

    if (!payload || !payload.sub) {
      return res.status(401).json({ error: "invalid apple token" });
    }

    req.user = { appleUserID: payload.sub };
    return next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "authentication failed" });
  }
}

/* ------------------------------------------------------------------
   Bootstrap user + profile (server-side)
------------------------------------------------------------------ */
async function ensureUser(appleUserID) {
  await pool.query(
    `
    insert into users (apple_user_id)
    values ($1)
    on conflict (apple_user_id) do nothing
    `,
    [appleUserID]
  );

  await pool.query(
    `
    insert into user_profiles (apple_user_id, schema_version, settings_json)
    values ($1, 1, '{}'::jsonb)
    on conflict (apple_user_id) do nothing
    `,
    [appleUserID]
  );
}

/* ------------------------------------------------------------------
   Health check
------------------------------------------------------------------ */
app.get("/", (req, res) => res.send("hakmun-api up"));

/* ------------------------------------------------------------------
   GET /v1/me
------------------------------------------------------------------ */
app.get("/v1/me", requireUser, async (req, res) => {
  const { appleUserID } = req.user;

  await ensureUser(appleUserID);

  const result = await pool.query(
    `
    select apple_user_id, schema_version, settings_json, updated_at
    from user_profiles
    where apple_user_id = $1
    `,
    [appleUserID]
  );

  return res.json({
    appleUserID,
    profile: result.rows[0] || null
  });
});

/* ------------------------------------------------------------------
   PUT /v1/me/profile
   v0: settings_json blob (schema_version stays 1 for now)
------------------------------------------------------------------ */
app.put("/v1/me/profile", requireUser, async (req, res) => {
  const { appleUserID } = req.user;
  const updates = req.body || {};

  await ensureUser(appleUserID);

  await pool.query(
    `
    update user_profiles
    set settings_json = $2,
        updated_at = now()
    where apple_user_id = $1
    `,
    [appleUserID, updates]
  );

  return res.json({ ok: true });
});

/* ------------------------------------------------------------------
   Sentence validation (stub)
------------------------------------------------------------------ */
app.post("/v1/validate/sentence", requireUser, (req, res) => {
  const { sentenceID, text } = req.body || {};

  if (!sentenceID || !text) {
    return res.status(400).json({
      verdict: "NEEDS_REVIEW",
      reason: "missing sentenceID or text"
    });
  }

  return res.json({
    verdict: "OK",
    reason: ""
  });
});

/* ------------------------------------------------------------------
   Sentence generation (global worker for now)
------------------------------------------------------------------ */
app.post("/v1/generate/sentences", requireUser, async (req, res) => {
  try {
    const { tier, count } = req.body || {};

    if (!count || typeof count !== "number" || count < 1 || count > 30) {
      return res.status(400).json({
        error: "count must be a number between 1 and 30"
      });
    }

    const safeTier =
      tier === "intermediate" || tier === "advanced" ? tier : "beginner";

    const prompt = `
You generate Korean typing practice sentences for a language-learning app.

Return ONLY valid JSON. Do not include explanations or markdown.

The JSON MUST have this shape:

{
  "generatorVersion": "string",
  "sentences": [
    {
      "id": "string",
      "ko": "string",
      "literal": "string | null",
      "natural": "string | null",
      "naturalnessScore": number (0 to 1)
    }
  ]
}

Rules:
- Generate exactly ${count} unique sentences.
- Tier: ${safeTier}.
- Sentences must be natural, realistic Korean.
- Each sentence must be complete and properly punctuated.
- Avoid unsafe content.
- Use stable IDs like GEN_A1B2C3D4.
- naturalnessScore is your self-evaluation (higher = more natural).
`.trim();

    const r = await openai.responses.create({
      model: "gpt-5.2",
      input: prompt,
      text: { format: { type: "json_object" } }
    });

    const payload = JSON.parse(r.output_text);
    return res.json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "generation failed" });
  }
});

/* ------------------------------------------------------------------
   Start server (Railway)
------------------------------------------------------------------ */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`listening on ${port}`));