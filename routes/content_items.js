// FILE: hakmun-api/routes/content_items.js
// PURPOSE: Canonical Content Items API (no module-owned objects)
// ENDPOINTS:
//   GET  /v1/content/items?content_type=sentence
//   POST /v1/content/items
//   GET  /v1/content/items/coverage?content_type=sentence
//   GET  /v1/library/global/items?content_type=sentence&global_state=approved
//
// Canonical identifiers:
// - content_item_id (UUID)
// - content_type: sentence | paragraph | passage | pattern (pattern later)
//
// Registry:
// - library_registry_items content_type matches content_items.content_type
// - audience/global_state/operational_status live in registry

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

function normalizeContentType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  if (["sentence", "paragraph", "passage", "pattern"].includes(s)) return s;
  return null;
}

function normalizeGlobalState(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return null;
  if (["preliminary", "approved", "rejected"].includes(s)) return s;
  return null;
}

// ------------------------------------------------------------------
// GET /v1/content/items?content_type=sentence
// Personal-only canonical list (owner-scoped).
// ------------------------------------------------------------------
router.get("/v1/content/items", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const contentType = normalizeContentType(req.query?.content_type) || "sentence";

    const sql = `
      SELECT
        ci.content_item_id,
        ci.content_type,
        ci.text,
        ci.language,
        ci.notes,
        ci.created_at,
        ci.updated_at,

        lri.id                 AS registry_item_id,
        lri.audience,
        lri.global_state,
        lri.operational_status,
        lri.owner_user_id      AS registry_owner_user_id
      FROM content_items ci
      JOIN library_registry_items lri
        ON lri.content_type = ci.content_type
       AND lri.content_id   = ci.content_item_id
      WHERE ci.owner_user_id = $1::uuid
        AND ci.content_type = $2::text
        AND lri.audience = 'personal'
      ORDER BY ci.created_at DESC
      LIMIT 2000
    `;

    const { rows } = await dbQuery(sql, [userId, contentType]);
    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("content items list failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ------------------------------------------------------------------
// GET /v1/library/global/items?content_type=sentence&global_state=approved
// Global library list (approved by default).
//
// NOTE:
// - This endpoint is intentionally separate from /v1/content/items.
// - It returns the same row shape as /v1/content/items so the frontend can decode
//   using ContentItemDTO without introducing new client models.
// - Access control for preliminary/rejected can be added later (teacher-only).
// ------------------------------------------------------------------
router.get("/v1/library/global/items", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const contentType = normalizeContentType(req.query?.content_type) || "sentence";
    const globalState = normalizeGlobalState(req.query?.global_state) || "approved";

    const sql = `
      SELECT
        ci.content_item_id,
        ci.content_type,
        ci.text,
        ci.language,
        ci.notes,
        ci.created_at,
        ci.updated_at,

        lri.id                 AS registry_item_id,
        lri.audience,
        lri.global_state,
        lri.operational_status,
        lri.owner_user_id      AS registry_owner_user_id
      FROM content_items ci
      JOIN library_registry_items lri
        ON lri.content_type = ci.content_type
       AND lri.content_id   = ci.content_item_id
      WHERE ci.content_type = $1::text
        AND lri.audience = 'global'
        AND lri.global_state = $2::text
        AND lri.operational_status = 'active'
      ORDER BY ci.created_at DESC
      LIMIT 500
    `;

    const { rows } = await dbQuery(sql, [contentType, globalState]);
    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("global items list failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ------------------------------------------------------------------
// POST /v1/content/items
// Body: { content_type: "sentence", text: "..." }
// Creates PERSONAL content + PERSONAL registry row.
// ------------------------------------------------------------------
router.post("/v1/content/items", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  const contentType = normalizeContentType(req.body?.content_type) || "sentence";
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });

  const client = db && typeof db.connect === "function" ? await db.connect() : null;
  const q = client ? client.query.bind(client) : dbQuery;

  try {
    if (client) await q("BEGIN", []);

    const ins = await q(
      `
      INSERT INTO content_items (owner_user_id, content_type, text, language, notes)
      VALUES ($1::uuid, $2::text, $3::text, 'ko', NULL)
      RETURNING content_item_id, content_type, text, language, notes, created_at, updated_at
      `,
      [userId, contentType, text]
    );
    const item = ins.rows[0];

    const reg = await q(
      `
      INSERT INTO library_registry_items
        (content_type, content_id, owner_user_id, audience, global_state, operational_status)
      VALUES
        ($1::text, $2::uuid, $3::uuid, 'personal', NULL, 'active')
      RETURNING id, audience, global_state, operational_status
      `,
      [item.content_type, item.content_item_id, userId]
    );
    const registry = reg.rows[0];

    if (client) await q("COMMIT", []);

    return res.status(201).json({
      ok: true,
      item: {
        content_item_id: item.content_item_id,
        content_type: item.content_type,
        text: item.text,
        language: item.language,
        notes: item.notes,
        created_at: item.created_at,
        updated_at: item.updated_at,
        registry_item_id: registry.id,
        audience: registry.audience,
        global_state: registry.global_state,
        operational_status: registry.operational_status,
      },
    });
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
    }
    console.error("content items create failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------
// GET /v1/content/items/coverage?content_type=sentence
//
// Capability-only surface:
// - answers module participation (e.g., Listening)
// - MUST NOT expose content or lifecycle fields
// ------------------------------------------------------------------
router.get("/v1/content/items/coverage", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const contentType = normalizeContentType(req.query?.content_type) || "sentence";

    const sql = `
      SELECT
        cic.content_item_id,
        cic.content_type,

        cic.female_slow_asset_id,
        cic.female_moderate_asset_id,
        cic.female_native_asset_id,
        cic.male_slow_asset_id,
        cic.male_moderate_asset_id,
        cic.male_native_asset_id,
        cic.variants_count
      FROM content_items_coverage cic
      WHERE cic.owner_user_id = $1::uuid
        AND cic.content_type = $2::text
      ORDER BY cic.content_item_id
      LIMIT 2000
    `;

    const { rows } = await dbQuery(sql, [userId, contentType]);
    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("content items coverage failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ------------------------------------------------------------------
// DELETE /v1/content/items
// Body: { content_item_ids: ["uuid", ...] }
// Deletes content items and their registry rows (owner-scoped).
// ------------------------------------------------------------------
router.delete("/v1/content/items", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  const ids = req.body?.content_item_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: "CONTENT_ITEM_IDS_REQUIRED" });
  }

  const client = db && typeof db.connect === "function" ? await db.connect() : null;
  const q = client ? client.query.bind(client) : dbQuery;

  try {
    if (client) await q("BEGIN", []);

    // Delete registry rows first (FK-safe)
    await q(
      `
      DELETE FROM library_registry_items
      WHERE content_id = ANY($1::uuid[])
        AND owner_user_id = $2::uuid
      `,
      [ids, userId]
    );

    // Delete content items
    const result = await q(
      `
      DELETE FROM content_items
      WHERE content_item_id = ANY($1::uuid[])
        AND owner_user_id = $2::uuid
      `,
      [ids, userId]
    );

    if (client) await q("COMMIT", []);

    return res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    console.error("content items delete failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;