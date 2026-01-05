// server.js — HakMun API (v0.4)
// Identity architecture (real-app style):
// - Apple `sub` is NOT your canonical user key.
// - Canonical key is users.user_id (UUID).
// - auth_identities maps (provider, subject, audience) -> user_id.
// - For now, existing tables user_profiles/user_handles are still keyed by apple_user_id.
//   We keep them working while we migrate them later.
//
// Stability guardrails:
// - Fail fast if APPLE_CLIENT_ID / DATABASE_URL are missing.
// - Log APPLE_CLIENT_ID and DATABASE host on boot (no secrets).
// - Provide /v1/auth/whoami for quick identity sanity checks.

const express = require("express");
const OpenAI = require("openai");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

/* ------------------------------------------------------------------
   Hard config guardrails (fail fast)
------------------------------------------------------------------ */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

const APPLE_CLIENT_ID = requireEnv("APPLE_CLIENT_ID");
const DATABASE_URL = requireEnv("DATABASE_URL");

// OPENAI is optional unless you call generation endpoints.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ------------------------------------------------------------------
   Safe boot logging (no secrets)
------------------------------------------------------------------ */
function safeDbHost(url) {
  try {
    const u = new URL(url);
    return u.host; // host:port (safe to log)
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

console.log("[boot] HakMun API starting");
console.log("[boot] NODE_ENV =", process.env.NODE_ENV || "<unset>");
console.log("[boot] APPLE_CLIENT_ID =", APPLE_CLIENT_ID);
console.log("[boot] DATABASE_URL host =", safeDbHost(DATABASE_URL));
console.log("[boot] OPENAI_API_KEY set =", Boolean(OPENAI_API_KEY));

/* ------------------------------------------------------------------
   OpenAI (server-side only)
------------------------------------------------------------------ */
const openai =
  OPENAI_API_KEY && String(OPENAI_API_KEY).trim()
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

/* ------------------------------------------------------------------
   Postgres (Railway)
------------------------------------------------------------------ */
const pool = new Pool({
  connectionString: DATABASE_URL,
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
    audience: APPLE_CLIENT_ID
  });
  return payload; // includes `sub`
}

/* ------------------------------------------------------------------
   Username/Handle helpers
------------------------------------------------------------------ */
function normalizeHandle(handle) {
  return String(handle || "").trim();
}

function isValidHandle(handle) {
  // 2–24 chars: letters, numbers, underscore, dot, hyphen, Hangul
  return /^[\w.\-가-힣]{2,24}$/.test(handle);
}

/* ------------------------------------------------------------------
   Internal: ensure a user exists and returns canonical user_id.
   - Resolves via auth_identities first.
   - If missing, creates a new users row + auth_identities row.
   - Also ensures legacy user_profiles row exists keyed by apple_user_id.
------------------------------------------------------------------ */
async function ensureCanonicalUser({ appleSubject, audience }) {
  // 1) Try to resolve via auth_identities
  const found = await pool.query(
    `
    select user_id
    from auth_identities
    where provider = 'apple' and subject = $1 and audience = $2
    limit 1
    `,
    [appleSubject, audience]
  );

  if (found.rows && found.rows.length > 0) {
    const userID = found.rows[0].user_id;

    // Ensure legacy profile exists (still apple_user_id keyed for now)
    await pool.query(
      `
      insert into user_profiles (apple_user_id, schema_version, settings_json)
      values ($1, 1, '{}'::jsonb)
      on conflict (apple_user_id) do nothing
      `,
      [appleSubject]
    );

    // Keep last_seen_at fresh if table has it
    await pool.query(
      `
      update users
      set last_seen_at = now()
      where user_id = $1
      `,
      [userID]
    );

    return userID;
  }

  // 2) No identity row yet -> create user + identity (transactional)
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2a) If a legacy users row exists by apple_user_id, reuse it (helps if you seeded users earlier)
    // NOTE: This assumes users.apple_user_id exists (it does in your schema).
    const existingUser = await client.query(
      `
      select user_id
      from users
      where apple_user_id = $1
      limit 1
      `,
      [appleSubject]
    );

    let userID;
    if (existingUser.rows && existingUser.rows.length > 0) {
      userID = existingUser.rows[0].user_id;
    } else {
      // Insert new canonical user row. (user_id has no default in your schema, so we generate it here.)
      const created = await client.query(
        `
        insert into users (user_id, apple_user_id, last_seen_at)
        values (gen_random_uuid(), $1, now())
        returning user_id
        `,
        [appleSubject]
      );
      userID = created.rows[0].user_id;
    }

    // 2b) Ensure auth identity row exists
    await client.query(
      `
      insert into auth_identities (provider, subject, audience, user_id)
      values ('apple', $1, $2, $3)
      on conflict do nothing
      `,
      [appleSubject, audience, userID]
    );

    // 2c) Ensure legacy profile exists (still apple_user_id keyed for now)
    await client.query(
      `
      insert into user_profiles (apple_user_id, schema_version, settings_json)
      values ($1, 1, '{}'::jsonb)
      on conflict (apple_user_id) do nothing
      `,
      [appleSubject]
    );

    await client.query("COMMIT");
    return userID;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------
   Auth middleware (canonical)
   - Verifies Apple token
   - Resolves/creates canonical user_id via auth_identities
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

    const appleSubject = payload.sub;

    const userID = await ensureCanonicalUser({
      appleSubject,
      audience: APPLE_CLIENT_ID
    });

    // Expose both: canonical userID + legacy appleUserID (sub)
    req.user = {
      userID,
      appleUserID: appleSubject,
      audience: APPLE_CLIENT_ID
    };

    return next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "authentication failed" });
  }
}

/* ------------------------------------------------------------------
   Health check
------------------------------------------------------------------ */
app.get("/", (req, res) => res.send("hakmun-api up"));

/* ------------------------------------------------------------------
   GET /v1/auth/whoami
   Authenticated introspection (for stability checks)
------------------------------------------------------------------ */
app.get("/v1/auth/whoami", requireUser, async (req, res) => {
  const { userID, appleUserID, audience } = req.user;
  return res.json({
    userID,
    appleUserID,
    audience
  });
});

/* ------------------------------------------------------------------
   GET /v1/me
   (legacy profile storage still keyed by apple_user_id)
------------------------------------------------------------------ */
app.get("/v1/me", requireUser, async (req, res) => {
  const { appleUserID, userID } = req.user;

  const result = await pool.query(
    `
    select apple_user_id, schema_version, settings_json, updated_at
    from user_profiles
    where apple_user_id = $1
    `,
    [appleUserID]
  );

  return res.json({
    userID,
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
   GET /v1/handles/me
   Returns the authenticated user's canonical primary handle (username).

   NOTE: user_handles is still keyed by apple_user_id for now.
------------------------------------------------------------------ */
app.get("/v1/handles/me", requireUser, async (req, res) => {
  const { appleUserID } = req.user;

  try {
    const { rows } = await pool.query(
      `
      select handle, kind, primary_handle, created_at
      from user_handles
      where apple_user_id = $1 and kind = 'primary'
      limit 1
      `,
      [appleUserID]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "no username set" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("handles/me failed:", err);
    return res.status(500).json({ error: "resolve failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/handles/reserve
   Reserves a globally-unique primary username for the authenticated user.

   Body:
   { "handle": "버논" }
------------------------------------------------------------------ */
app.post("/v1/handles/reserve", requireUser, async (req, res) => {
  const { appleUserID } = req.user;

  const handle = normalizeHandle(req.body?.handle ?? req.body?.username);

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

    // Reserve primary handle (apple_user_id still the FK here)
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
    if (!openai) {
      return res.status(503).json({ error: "OpenAI is not configured" });
    }

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