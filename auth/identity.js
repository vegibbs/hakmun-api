// auth/identity.js — HakMun API
// Canonical identity resolution: shared across all auth providers (Apple, Google, etc.)

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { touchLastSeen } = require("./session");

/**
 * Look up a user by provider identity WITHOUT creating anything.
 * Returns the user_id if found, null if not.
 */
async function findUserByIdentity({ provider, subject, audience }) {
  // Exact match: provider + subject + audience
  const rExact = await pool.query(
    `SELECT user_id FROM auth_identities
     WHERE provider = $1 AND subject = $2 AND audience = $3
     LIMIT 1`,
    [provider, subject, audience]
  );
  if (rExact.rows?.[0]?.user_id) return rExact.rows[0].user_id;

  // Same subject, different audience (e.g., web vs native client ID)
  const rAny = await pool.query(
    `SELECT user_id FROM auth_identities
     WHERE provider = $1 AND subject = $2
     LIMIT 1`,
    [provider, subject]
  );
  if (rAny.rows?.[0]?.user_id) return rAny.rows[0].user_id;

  // Legacy Apple bridge: check users.apple_user_id
  if (provider === "apple") {
    const rLegacy = await pool.query(
      `SELECT user_id FROM users
       WHERE apple_user_id = $1
       LIMIT 1`,
      [subject]
    );
    if (rLegacy.rows?.[0]?.user_id) return rLegacy.rows[0].user_id;
  }

  return null;
}

/**
 * Resolve or create a canonical user for the given provider identity.
 *
 * @param {object} opts
 * @param {string} opts.provider   - e.g. "apple", "google"
 * @param {string} opts.subject    - provider-specific unique user ID
 * @param {string} opts.audience   - client ID / app ID that issued the token
 * @param {string|null} opts.email - optional, used for legacy bridge (Apple only)
 * @param {string} rid             - request ID for logging
 * @returns {Promise<string>}      - canonical user_id (UUID)
 */
async function ensureCanonicalUser({ provider, subject, audience, email }, rid) {
  // FAST PATH 1: exact auth_identities match
  try {
    const r = await withTimeout(
      pool.query(
        `
        select user_id
        from auth_identities
        where provider = $1 and subject = $2 and audience = $3
        limit 1
        `,
        [provider, subject, audience]
      ),
      3000,
      "auth_identities-lookup"
    );

    const userID = r?.rows?.[0]?.user_id || null;
    if (userID) {
      touchLastSeen(userID).catch(() => {});
      return userID;
    }
  } catch (e) {
    logger.error("[auth] fast auth_identities lookup failed", { rid, err: e?.message || String(e) });
  }

  // FAST PATH 2: same subject already known under a different audience
  try {
    const r = await withTimeout(
      pool.query(
        `
        select user_id
        from auth_identities
        where provider = $1 and subject = $2
        limit 1
        `,
        [provider, subject]
      ),
      3000,
      "auth_identities-any-audience"
    );

    const userID = r?.rows?.[0]?.user_id || null;
    if (userID) {
      // Bind this audience to the same canonical user.
      pool
        .query(
          `
          insert into auth_identities (provider, subject, audience, user_id)
          values ($1, $2, $3, $4)
          on conflict do nothing
          `,
          [provider, subject, audience, userID]
        )
        .catch((err) =>
          logger.warn("[warn] auth_identities bind (audience) failed", {
            rid,
            code: err?.code,
            err: err?.detail || err?.message || String(err)
          })
        );

      touchLastSeen(userID).catch(() => {});
      return userID;
    }
  } catch (e) {
    logger.error("[auth] fast auth_identities any-audience lookup failed", {
      rid,
      err: e?.message || String(e)
    });
  }

  // SLOW PATH: transactional create/bind (fail-fast on locks)
  const client = await pool.connect();
  try {
    await client.query(`set statement_timeout = 6000;`);
    await client.query(`set lock_timeout = 2000;`);
    await client.query("BEGIN");

    // Single-flight per provider:subject to prevent duplicate user creation.
    await client.query(`select pg_advisory_xact_lock(hashtext($1));`, [`${provider}:${subject}`]);

    // Re-check exact match.
    const rExact = await client.query(
      `
      select user_id
      from auth_identities
      where provider = $1 and subject = $2 and audience = $3
      limit 1
      `,
      [provider, subject, audience]
    );

    let canonicalUserID = rExact.rows?.[0]?.user_id || null;

    // Re-check any-audience match.
    if (!canonicalUserID) {
      const rAny = await client.query(
        `
        select user_id
        from auth_identities
        where provider = $1 and subject = $2
        limit 1
        `,
        [provider, subject]
      );
      canonicalUserID = rAny.rows?.[0]?.user_id || null;
    }

    // One-time legacy bridge: match legacy users.apple_user_id by email or old sub.
    // Only applies to Apple sign-in (legacy users were stored by apple_user_id).
    if (!canonicalUserID && provider === "apple") {
      if (email) {
        const rLegacyEmail = await client.query(
          `
          select user_id
          from users
          where apple_user_id = $1
          limit 1
          `,
          [email]
        );
        canonicalUserID = rLegacyEmail.rows?.[0]?.user_id || null;
      }

      if (!canonicalUserID) {
        const rLegacySub = await client.query(
          `
          select user_id
          from users
          where apple_user_id = $1
          limit 1
          `,
          [subject]
        );
        canonicalUserID = rLegacySub.rows?.[0]?.user_id || null;
      }
    }

    // Create new canonical user if still missing.
    if (!canonicalUserID) {
      const created = await client.query(
        `
        insert into users (user_id, apple_user_id, last_seen_at, role, is_active, is_admin, is_root_admin)
        values (gen_random_uuid(), null, now(), 'student', true, false, false)
        returning user_id, created_at
        `
      );
      canonicalUserID = created.rows[0].user_id;

      // Notify Discord when a new user joins
      const webhookUrl = process.env.DISCORD_SIGNUP_WEBHOOK_URL;
      if (webhookUrl) {
        const ts = created.rows[0].created_at;
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🎉 **New HakMun user** joined!\nUser ID: \`${canonicalUserID}\`\nProvider: ${provider}\nTime: ${ts}`
          })
        }).catch((err) =>
          logger.warn("[discord] signup webhook failed", { rid, err: err?.message || String(err) })
        );
      }
    }

    // Bind this (provider, sub, aud) to canonical user.
    await client.query(
      `
      insert into auth_identities (provider, subject, audience, user_id)
      values ($1, $2, $3, $4)
      on conflict do nothing
      `,
      [provider, subject, audience, canonicalUserID]
    );

    await client.query("COMMIT");

    touchLastSeen(canonicalUserID).catch(() => {});
    return canonicalUserID;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    logger.error("[auth] ensureCanonicalUser TX FAILED", { rid, err: err?.message || String(err) });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ensureCanonicalUser, findUserByIdentity };
