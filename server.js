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
   Username/Handle helpers
------------------------------------------------------------------ */
function normalizeHandle(handle) {
  return String(handle || "").trim();
}

function isValidHandle(handle) {
  // 2–24 chars: letters, numbers, underscore, dot, hyphen, Hangul
  // NOTE: CITEXT enforces case-insensitive uniqueness; we still validate shape here.
  return /^[\w.\-가-힣]{2,24}$/.test(handle);
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
   POST /v1/handles/reserve
   Reserves a globally-unique primary username for the authenticated user.

   Body:
   { "handle": "버논" }
------------------------------------------------------------------ */
app.post("/v1/handles/reserve", requireUser, async (req, res) => {
  const { appleUserID } = req.user;
  const handle = normalizeHandle(req.body?.handle);

  if (!handle) {
    return res.status(400).json({ error: "handle is required" });
  }
  if (!isValidHandle(handle)) {
    return res.status(400).json({
      error:
        "Invalid username. Use 2–24 characters: letters, numbers, underscore, dot, hyphen, or Hangul."
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure user exists (idempotent)
    await client.query(
      `
      insert into users (apple_user_id)
      values ($1)
      on conflict (apple_user_id) do nothing
      `,
      [appleUserID]
    );

    // Reserve primary handle
    await client.query(
      `
      insert into user_handles (handle, apple_user_id, kind, primary_handle)
      values ($1, $2, 'primary', $1)
      `,
      [handle, appleUserID]
    );

    await client.query("COMMIT");

    return res.json({
      handle,
      kind: "primary",
      primary_handle: handle
    });
  } catch (err) {
    await client.query("ROLLBACK");

    // Unique violation (CITEXT PK / unique index)
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "username already taken" });
    }

    console.error("reserve handle failed:", err);
    return res.status(500).json({ error: "reserve failed" });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------
   GET /v1/handles/resolve?handle=vernon
   Resolves any handle (username or alias) to its primary_handle.

   Response:
   { handle, kind, primary_handle }
------------------------------------------------------------------ */
app.get("/v1/handles/resolve", requireUser, async (req, res) => {
  const handle = normalizeHandle(req.query?.handle);

  if (!handle) {
    return res.status(400).json({ error: "handle is required" });
  }

  try {
    const { rows } = await pool.query(
      `
      select handle, kind, primary_handle
      from user_handles
      where handle = $1
      `,
      [handle]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "username not found" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("resolve handle failed:", err);
    return res.status(500).json({ error: "resolve failed" });
  }
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