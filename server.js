// server.js — HakMun API (v0.8)
// Canonical identity + handles + secure private asset storage (signed URLs)
//
// Identity:
// - Canonical user key: users.user_id (UUID)
// - auth_identities maps (provider, subject, audience) -> user_id
// - Apple `sub` is auth identity (subject), not a data key.
//
// Handles:
// - user_handles is keyed by user_id
// - handle globally unique (CITEXT PK)
// - aliases resolve to primary_handle
//
// Legacy:
// - user_profiles is still keyed by apple_user_id (legacy).
// - Legacy profile writes are best-effort and MUST NOT break auth.
//
// Secure assets:
// - Store profile photos privately in Railway bucket
// - Expose read access via signed URLs (time-limited)

const express = require("express");
const OpenAI = require("openai");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { Pool } = require("pg");

// Secure object storage (S3-compatible)
const multer = require("multer");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

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

const APPLE_CLIENT_IDS = requireEnv("APPLE_CLIENT_IDS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DATABASE_URL = requireEnv("DATABASE_URL");

// OPENAI is optional unless you call generation endpoints.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ------------------------------------------------------------------
   Safe boot logging (no secrets)
------------------------------------------------------------------ */
function safeDbHost(url) {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

console.log("[boot] HakMun API starting");
console.log("[boot] NODE_ENV =", process.env.NODE_ENV || "<unset>");
console.log("[boot] APPLE_CLIENT_IDS =", APPLE_CLIENT_IDS.join(", "));
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
   Helpers
------------------------------------------------------------------ */
function normalizeHandle(handle) {
  return String(handle || "").trim();
}

function isValidHandle(handle) {
  // 2–24 chars: letters, numbers, underscore, dot, hyphen, Hangul
  return /^[\w.\-가-힣]{2,24}$/.test(handle);
}

/* ------------------------------------------------------------------
   Legacy profile helpers (NON-FATAL)
------------------------------------------------------------------ */
async function ensureLegacyUserProfileNonFatal(appleUserID) {
  // Legacy storage: user_profiles keyed by apple_user_id.
  // IMPORTANT: This must NEVER block auth (FK constraints may exist).
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
  // 1) Resolve via auth_identities
  const userID = await resolveUserIDFromIdentity({
    provider: "apple",
    subject: appleSubject,
    audience
  });

  if (userID) {
    await ensureLegacyUserProfileNonFatal(appleSubject);
    await touchLastSeen(userID);
    return userID;
  }

  // 2) Not found -> reuse users row by apple_user_id OR create one, then bind identity
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

    // Best-effort legacy profile insert (same transaction)
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
   User state (role/admin flags) — read-only for now
------------------------------------------------------------------ */
async function getUserState(userID) {
  const { rows } = await pool.query(
    `
    select role, is_admin, is_root_admin, is_active
    from users
    where user_id = $1
    limit 1
    `,
    [userID]
  );

  // Be defensive: should always exist
  return rows?.[0] || {
    role: "student",
    is_admin: false,
    is_root_admin: false,
    is_active: true
  };
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

    // Read user state flags (no behavior change yet; just visibility)
    const state = await getUserState(userID);

    req.user = {
      userID,
      appleUserID: appleSubject,
      audience,

      role: state.role,
      isAdmin: Boolean(state.is_admin),
      isRootAdmin: Boolean(state.is_root_admin),
      isActive: Boolean(state.is_active)
    };

    return next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "authentication failed" });
  }
}

/* ------------------------------------------------------------------
   Secure object storage (Railway bucket, S3-compatible)
------------------------------------------------------------------ */
function storageConfigured() {
  return Boolean(
    process.env.OBJECT_STORAGE_ENDPOINT &&
      process.env.OBJECT_STORAGE_BUCKET &&
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

function requireStorageOr503(res) {
  if (!storageConfigured()) {
    return res.status(503).json({ error: "object storage not configured" });
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT, // e.g. https://storage.railway.app
    region: process.env.OBJECT_STORAGE_REGION || "auto",
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
    },
    forcePathStyle: true
  });
}

function bucketName() {
  return process.env.OBJECT_STORAGE_BUCKET;
}

/* ------------------------------------------------------------------
   Health check
------------------------------------------------------------------ */
app.get("/", (req, res) => res.send("hakmun-api up"));

/* ------------------------------------------------------------------
   GET /v1/auth/whoami
------------------------------------------------------------------ */
app.get("/v1/auth/whoami", requireUser, async (req, res) => {
  return res.json(req.user);
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
   PUT /v1/me/profile-photo  (PRIVATE object upload)
   multipart/form-data field: photo
   Stores only key in settings_json:
     profilePhotoKey, profilePhotoUpdatedAt
------------------------------------------------------------------ */
app.put(
  "/v1/me/profile-photo",
  requireUser,
  upload.single("photo"),
  async (req, res) => {
    const maybe = requireStorageOr503(res);
    if (maybe) return;

    try {
      if (!req.file) {
        return res.status(400).json({ error: "photo file required" });
      }

      const { userID, appleUserID } = req.user;
      const key = `users/${userID}/profile.jpg`;

      const s3 = makeS3Client();

      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketName(),
          Key: key
        })
      );

      // Store key only (NOT URL)
      await pool.query(
        `
        update user_profiles
        set settings_json =
          coalesce(settings_json, '{}'::jsonb)
          || jsonb_build_object(
            'profilePhotoKey', $2::text,
            'profilePhotoUpdatedAt', now()
          ),
          updated_at = now()
        where apple_user_id = $1
        `,
        [appleUserID, key]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("profile-photo upload failed:", err);
      return res.status(500).json({ error: "upload failed" });
    }
  }
);

/* ------------------------------------------------------------------
   DELETE /v1/me/profile-photo  (PRIVATE object delete + DB clear)
------------------------------------------------------------------ */
app.delete("/v1/me/profile-photo", requireUser, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const { appleUserID } = req.user;

    // 1) Fetch current key from profile
    const r = await pool.query(
      `
      select settings_json->>'profilePhotoKey' as key
      from user_profiles
      where apple_user_id = $1
      `,
      [appleUserID]
    );

    const key = r.rows[0]?.key;
    if (!key) {
      // Nothing to delete (already removed)
      return res.json({ ok: true });
    }

    // 2) Delete from bucket (ignore if missing)
    const s3 = makeS3Client();
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketName(),
          Key: key
        })
      );
    } catch (err) {
      // If object delete fails, still clear DB so UI is consistent;
      // log for investigation.
      console.error("profile-photo delete object failed:", err);
    }

    // 3) Clear DB fields
    await pool.query(
      `
      update user_profiles
      set settings_json =
        (coalesce(settings_json, '{}'::jsonb) - 'profilePhotoKey' - 'profilePhotoUpdatedAt'),
          updated_at = now()
      where apple_user_id = $1
      `,
      [appleUserID]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("profile-photo delete failed:", err);
    return res.status(500).json({ error: "delete failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/me/profile-photo-url  (SIGNED URL)
   Returns time-limited URL to the private object.
------------------------------------------------------------------ */
app.get("/v1/me/profile-photo-url", requireUser, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const { appleUserID } = req.user;

    const result = await pool.query(
      `
      select settings_json->>'profilePhotoKey' as key
      from user_profiles
      where apple_user_id = $1
      `,
      [appleUserID]
    );

    const key = result.rows[0]?.key;
    if (!key) {
      return res.status(404).json({ error: "no profile photo" });
    }

    const s3 = makeS3Client();
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: key
      }),
      { expiresIn: 60 * 15 } // 15 minutes
    );

    return res.json({ url, expiresIn: 900 });
  } catch (err) {
    console.error("profile-photo-url failed:", err);
    return res.status(500).json({ error: "failed to sign url" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/handles/me
------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------
   POST /v1/handles/reserve
------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------
   GET /v1/handles/resolve?handle=vernon
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