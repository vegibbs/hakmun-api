// server.js — HakMun API (v0.7)
// Canonical identity + multi-audience Apple Sign In

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

console.log("[boot] HakMun API starting");
console.log("[boot] APPLE_CLIENT_IDS =", APPLE_CLIENT_IDS.join(", "));
console.log("[boot] DATABASE_URL host =", new URL(DATABASE_URL).host);
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

  const aud = Array.isArray(payload.aud)
    ? payload.aud[0]
    : payload.aud;

  if (!aud || !APPLE_CLIENT_IDS.includes(aud)) {
    throw new Error(`Apple token audience not allowed: ${aud}`);
  }

  if (!payload.sub) {
    throw new Error("Apple token missing subject");
  }

  return {
    appleSubject: payload.sub,
    audience: aud
  };
}

/* ------------------------------------------------------------------
   Identity helpers
------------------------------------------------------------------ */
async function ensureLegacyUserProfile(appleUserID) {
  await pool.query(
    `
    insert into user_profiles (apple_user_id, schema_version, settings_json)
    values ($1, 1, '{}'::jsonb)
    on conflict (apple_user_id) do nothing
    `,
    [appleUserID]
  );
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

async function resolveUserIDFromIdentity({ provider, subject, audience }) {
  const { rows } = await pool.query(
    `
    select user_id
    from auth_identities
    where provider = $1
      and subject = $2
      and audience = $3
    limit 1
    `,
    [provider, subject, audience]
  );
  return rows.length ? rows[0].user_id : null;
}

/* ------------------------------------------------------------------
   Canonical identity resolution
------------------------------------------------------------------ */
async function ensureCanonicalUser({ appleSubject, audience }) {
  // 1) Exact identity match
  const direct = await resolveUserIDFromIdentity({
    provider: "apple",
    subject: appleSubject,
    audience
  });

  if (direct) {
    await ensureLegacyUserProfile(appleSubject);
    await touchLastSeen(direct);
    return direct;
  }

  // 2) Link new audience to existing user (by apple_user_id)
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

    let userID;

    if (existing.rows.length) {
      userID = existing.rows[0].user_id;
    } else {
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

    await client.query(
      `
      insert into auth_identities (provider, subject, audience, user_id)
      values ('apple', $1, $2, $3)
      on conflict do nothing
      `,
      [appleSubject, audience, userID]
    );

    await ensureLegacyUserProfile(appleSubject);
    await touchLastSeen(userID);

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

    const userID = await ensureCanonicalUser({
      appleSubject,
      audience
    });

    req.user = {
      userID,
      appleUserID: appleSubject,
      audience
    };

    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(401).json({ error: "authentication failed" });
  }
}

/* ------------------------------------------------------------------
   Routes
------------------------------------------------------------------ */
app.get("/", (_, res) => res.send("hakmun-api up"));

app.get("/v1/auth/whoami", requireUser, (req, res) => {
  res.json(req.user);
});

app.get("/v1/handles/me", requireUser, async (req, res) => {
  const { userID } = req.user;

  const { rows } = await pool.query(
    `
    select handle, kind, primary_handle, created_at
    from user_handles
    where user_id = $1 and kind = 'primary'
    limit 1
    `,
    [userID]
  );

  if (!rows.length) {
    return res.status(404).json({ error: "no username set" });
  }

  res.json(rows[0]);
});

app.post("/v1/handles/reserve", requireUser, async (req, res) => {
  const { userID } = req.user;
  const handle = String(req.body?.handle || "").trim();

  if (!/^[\w.\-가-힣]{2,24}$/.test(handle)) {
    return res.status(400).json({ error: "invalid username" });
  }

  try {
    await pool.query(
      `
      insert into user_handles (handle, user_id, kind, primary_handle)
      values ($1, $2, 'primary', $1)
      `,
      [handle, userID]
    );

    res.json({ handle });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "username already taken" });
    }
    throw err;
  }
});

/* ------------------------------------------------------------------
   Start server
------------------------------------------------------------------ */
const port = process.env.PORT || 8080;
app.listen(port, () =>
  console.log(`[boot] listening on ${port}`)
);