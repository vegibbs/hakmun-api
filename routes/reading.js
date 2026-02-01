// FILE: hakmun-api/routes/reading.js
// End-state: Reading view over canonical content_items (content_type='sentence').
// DB (Postico 063+064):
// - content_items(content_item_id, content_type, text, language, notes, ...)
// - content_items_coverage(content_item_id, content_type, ...)
// - no reading_items tables remain
//
// API contract (end-state):
// - identifiers use content_item_id
// - no reading_item_id anywhere

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

// GET /v1/reading/items
router.get("/v1/reading/items", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

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
        ON lri.content_type = 'sentence'
       AND lri.content_id   = ci.content_item_id
      WHERE ci.owner_user_id = $1::uuid
        AND ci.content_type = 'sentence'
        AND lri.audience = 'personal'
      ORDER BY ci.created_at DESC
      LIMIT 2000
    `;

    const { rows } = await dbQuery(sql, [userId]);
    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("reading list failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/reading/items
router.post("/v1/reading/items", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });

  const client = db && typeof db.connect === "function" ? await db.connect() : null;
  const q = client ? client.query.bind(client) : dbQuery;

  try {
    if (client) await q("BEGIN", []);

    const ins = await q(
      `
      INSERT INTO content_items (owner_user_id, content_type, text, language, notes)
      VALUES ($1::uuid, 'sentence', $2::text, 'ko', NULL)
      RETURNING content_item_id, content_type, text, language, notes, created_at, updated_at
      `,
      [userId, text]
    );
    const item = ins.rows[0];

    const reg = await q(
      `
      INSERT INTO library_registry_items (content_type, content_id, owner_user_id, audience, global_state, operational_status)
      VALUES ('sentence', $1::uuid, $2::uuid, 'personal', NULL, 'active')
      RETURNING id, audience, global_state, operational_status
      `,
      [item.content_item_id, userId]
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
        operational_status: registry.operational_status
      }
    });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    console.error("reading create failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  } finally {
    if (client) client.release();
  }
});

// GET /v1/reading-items/coverage
router.get("/v1/reading-items/coverage", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const sql = `
      SELECT
        cic.content_item_id,
        cic.owner_user_id,
        cic.content_type,
        cic.text,
        cic.language,
        cic.notes,
        cic.created_at,
        cic.updated_at,

        cic.female_slow_asset_id,
        cic.female_moderate_asset_id,
        cic.female_native_asset_id,
        cic.male_slow_asset_id,
        cic.male_moderate_asset_id,
        cic.male_native_asset_id,
        cic.variants_count
      FROM content_items_coverage cic
      WHERE cic.owner_user_id = $1::uuid
        AND cic.content_type = 'sentence'
      ORDER BY cic.created_at DESC
      LIMIT 2000
    `;

    const { rows } = await dbQuery(sql, [userId]);
    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("reading coverage failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;