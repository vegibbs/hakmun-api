// server.js — HakMun API (v0.7.1)
// Canonical identity + handles + multi-audience Apple Sign In
//
// FIX: Legacy user_profiles insert is now NON-FATAL (never blocks auth).
// Reason: user_profiles is keyed by apple_user_id (legacy), and can have FK constraints
// that are not guaranteed to be satisfiable for all identity flows.

const express = require("express");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

/* ------------------------------------------------------------------
   Env helpers
------------------------------------------------------------------ */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/* ------------------------------------------------------------------
   Environment
------------------------------------------------------------------ */
const APPLE_CLIENT_IDS = requireEnv("APPLE_CLIENT_IDS")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const DATABASE_URL = requireEnv("DATABASE_URL");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

function safeDbHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

console.log("[boot] HakMun API starting");
console.log("[boot] NODE_ENV =", process.env.NODE_ENV || "<unset>");
console.log("[boot] APPLE_CLIENT_IDS =", APPLE_CLIENT_IDS.join(", "));
console.log("[boot] DATABASE_URL host =", safeDbHost(DATABASE_URL));
console.log("[boot] OPENAI enabled =", Boolean(OPENAI_API_KEY));

/* ------------------------------------------------------------------
   Postgres
------------------------------------------------------------------ */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

/* ------------------------------------------------------------------
   OpenAI (optional)
------------------------------------------------------------------ */
const openai =
  OPENAI_API_KEY && OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

/* ------------------------------------------------------------------
   Apple Sign In verification
------------------------------------------------------------------ */
const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

async function verifyAppleToken(identityToken) {
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: "https://appleid.apple.com",
    audience: APPLE_CLIENT_IDS
  });

  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (!aud || !APPLE_CLIENT_IDS.includes(aud)) {
    throw new Error(`Apple token audience not allowed: ${String(aud)}`);
  }
  if (!payload.sub) {
    throw new Error("Apple token missing subject (sub)");
  }

  return { appleSubject: payload.sub, audience: aud };
}

/* ------------------------------------------------------------------
   Legacy helpers (non-fatal)
------------------------------------------------------------------ */
async function ensureLegacyUserProfileNonFatal(appleUserID) {
  // Legacy storage: user_profiles keyed by apple_user_id.
  // IMPORTANT: This must NEVER block auth. If FK constraints exist, swallow and continue.
  try {
    await pool.query(
      `
      insert into user_profiles (apple_user_id, schema_version, settings_json)
      values ($1, 1, '{}'::jsonb)
      on conflict (apple_user_id) do nothing
      `,
      [appleUserID]
    );
  } catch (err) {
    console.warn(
      "[warn] ensureLegacyUserProfileNonFatal failed (continuing):",
      err?.code,
      err?.detail || err?.message
    );
  }
}

async function touchLastSeen(userID) {
  await pool.query(
    `
    update users
    set last_seen_at = now()
    where user_id = $1
    `,
    [userID]
  );
}

/* ------------------------------------------------------------------
   Canonical identity resolution
------------------------------------------------------------------ */
async function resolveUserIDFromIdentity({ provider, subject, audience }) {
  const { rows } = await pool.query(
    `
    select user_id
    from auth_identities
    where provider = $1 and subject = $2 and audience = $3
    limit 1
    `,
    [provider, subject, audience]
  );
  return rows && rows.length ? rows[0].user_id : null;
}

async function ensureCanonicalUser({ appleSubject, audience }) {
  // 1) Resolve via auth_identities (provider, subject, audience)
  const userID = await resolveUserIDFromIdentity({
    provider: "apple",
    subject: appleSubject,
    audience
  });

  if (userID) {
    // Legacy profile is best-effort only
    await ensureLegacyUserProfileNonFatal(appleSubject);
    await touchLastSeen(userID);
    return userID;
  }

  // 2) Not found -> reuse existing users row by apple_user_id OR create one,
  //    then bind auth_identities for this audience.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `
      select user_id
      from users
      where apple_user_id = $1
      limit 1
      `,
      [appleSubject]
    );

    let canonicalUserID;
    if (existing.rows && existing.rows.length) {
      canonicalUserID = existing.rows[0].user_id;
    } else {
      const created = await client.query(
        `
        insert into users (user_id, apple_user_id, last_seen_at)
        values (gen_random_uuid(), $1, now())
        returning user_id
        `,
        [appleSubject]
      );
      canonicalUserID = created.rows[0].user_id;
    }

    await client.query(
      `
      insert into auth_identities (provider, subject, audience, user_id)
      values ('apple', $1, $2, $3)
      on conflict do nothing
      `,
      [appleSubject, audience, canonicalUserID]
    );

    // Legacy profile is still best-effort. Use the same transaction client.
    try {
      await client.query(
        `
        insert into user_profiles (apple_user_id, schema_version, settings_json)
        values ($1, 1, '{}'::jsonb)
        on conflict (apple_user_id) do nothing
        `,
        [appleSubject]
      );
    } catch (err) {
      console.warn(
        "[warn] (tx) legacy user_profiles insert failed (continuing):",
        err?.code,
        err?.detail || err?.message
      );
    }

    await client.query("COMMIT");

    // Last-seen outside tx is fine
    await touchLastSeen(canonicalUserID);

    return canonicalUserID;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
    const { appleSubject, audience } = await verifyAppleToken(token);

    const userID = await ensureCanonicalUser({ appleSubject, audience });

    req.user = {
      userID,
      appleUserID: appleSubject,
      audience
    };

    return next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "authentication failed" });
  }
}

/* ------------------------------------------------------------------
   Routes
------------------------------------------------------------------ */
app.get("/", (req, res) => res.send("hakmun-api up"));

app.get("/v1/auth/whoami", requireUser, async (req, res) => {
  return res.json(req.user);
});

/* ------------------------------------------------------------------
   GET /v1/me (legacy profiles keyed by apple_user_id)
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
   Handles
------------------------------------------------------------------ */
function normalizeHandle(handle) {
  return String(handle || "").trim();
}

function isValidHandle(handle) {
  // 2–24 chars: letters, numbers, underscore, dot, hyphen, Hangul
  return /^[\w.\-가-힣]{2,24}$/.test(handle);
}

app.get("/v1/handles/me", requireUser, async (req, res) => {
  const { userID } = req.user;

  try {
    const { rows } = await pool.query(
      `
      select handle, kind, primary_handle, created_at
      from user_handles
      where user_id = $1 and kind = 'primary'
      limit 1
      `,
      [userID]
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

app.post("/v1/handles/reserve", requireUser, async (req, res) => {
  const { userID } = req.user;
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

    await client.query(
      `
      insert into user_handles (handle, user_id, kind, primary_handle)
      values ($1, $2, 'primary', $1)
      `,
      [handle, userID]
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