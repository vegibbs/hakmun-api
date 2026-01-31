// FILE: hakmun-api/routes/reading.js
// PURPOSE: Reading module routes (personal reading items + coverage)
// REFRACTOR: Registry content_type renamed from 'reading_item' -> 'sentence' (migration 056)
// NOTE:
// - Payload table remains reading_items.
// - We only change registry semantics + joins to use content_type='sentence'.
// - Response shapes remain compatible with existing clients/smoke.
//
// ENDPOINTS:
// - GET  /v1/reading/items
// - POST /v1/reading/items
// - GET  /v1/reading-items/coverage

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
        ri.reading_item_id,
        ri.unit_type,
        ri.text,
        ri.language,
        ri.notes,
        ri.created_at,
        ri.updated_at,

        lri.id              AS registry_item_id,
        lri.audience        AS audience,
        lri.global_state    AS global_state,
        lri.operational_status AS operational_status,
        lri.owner_user_id   AS owner_user_id

      FROM reading_items ri
      JOIN library_registry_items lri
        ON lri.content_type = 'sentence'
       AND lri.content_id   = ri.reading_item_id
      WHERE ri.owner_user_id = $1::uuid
        AND lri.audience = 'personal'
        AND lri.owner_user_id = $1::uuid
      ORDER BY ri.created_at DESC
      LIMIT 2000
    `;

    const { rows } = await dbQuery(sql, [userId]);
    return res.json({ items: rows || [] });
  } catch (err) {
    console.error("reading GET /v1/reading/items failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/reading/items
// Body: { text: string }  (client currently only sends text)
router.post("/v1/reading/items", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });

  const client = db && typeof db.connect === "function" ? await db.connect() : null;
  const q = client ? client.query.bind(client) : dbQuery;

  try {
    if (client) await q("BEGIN", []);

    // Insert payload row (sentence unit for now)
    const insertReadingSql = `
      INSERT INTO reading_items (
        owner_user_id,
        unit_type,
        text,
        language,
        notes
      )
      VALUES (
        $1::uuid,
        'sentence',
        $2::text,
        'ko',
        NULL
      )
      RETURNING
        reading_item_id,
        unit_type,
        text,
        language,
        notes,
        created_at,
        updated_at
    `;
    const ins = await q(insertReadingSql, [userId, text]);
    const readingItem = ins.rows[0];

    // Insert registry row with NEW canonical content_type='sentence'
    const insertRegistrySql = `
      INSERT INTO library_registry_items (
        content_type,
        content_id,
        owner_user_id,
        audience,
        global_state,
        operational_status
      )
      VALUES (
        'sentence',
        $1::uuid,
        $2::uuid,
        'personal',
        NULL,
        'active'
      )
      RETURNING
        id,
        content_type,
        content_id,
        owner_user_id,
        audience,
        global_state,
        operational_status,
        created_at,
        updated_at
    `;
    const reg = await q(insertRegistrySql, [readingItem.reading_item_id, userId]);
    const registryItem = reg.rows[0];

    if (client) await q("COMMIT", []);

    // Response shape kept compatible with existing clients/smoke:
    // { reading_item: {...}, registry_item: {...} }
    return res.status(201).json({
      reading_item: {
        reading_item_id: readingItem.reading_item_id,
        unit_type: readingItem.unit_type,
        text: readingItem.text,
        language: readingItem.language,
        notes: readingItem.notes,
        created_at: readingItem.created_at,
        updated_at: readingItem.updated_at,
      },
      registry_item: {
        registry_item_id: registryItem.id,
        content_type: registryItem.content_type, // now 'sentence'
        content_id: registryItem.content_id,
        owner_user_id: registryItem.owner_user_id,
        audience: registryItem.audience,
        global_state: registryItem.global_state,
        operational_status: registryItem.operational_status,
        created_at: registryItem.created_at,
        updated_at: registryItem.updated_at,
      },
    });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    console.error("reading POST /v1/reading/items failed:", err);
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
        ric.reading_item_id,
        ric.owner_user_id,
        ric.unit_type,
        ric.text,
        ric.language,
        ric.notes,
        ric.created_at,
        ric.updated_at,

        ric.female_slow_asset_id,
        ric.female_moderate_asset_id,
        ric.female_native_asset_id,
        ric.male_slow_asset_id,
        ric.male_moderate_asset_id,
        ric.male_native_asset_id,
        ric.variants_count,

        lri.id               AS registry_item_id,
        lri.audience         AS audience,
        lri.global_state     AS global_state,
        lri.operational_status AS operational_status,
        lri.owner_user_id    AS registry_owner_user_id
      FROM reading_items_coverage ric
      JOIN library_registry_items lri
        ON lri.content_type = 'sentence'
       AND lri.content_id   = ric.reading_item_id
      WHERE ric.owner_user_id = $1::uuid
        AND lri.audience = 'personal'
        AND lri.owner_user_id = $1::uuid
      ORDER BY ric.created_at DESC
      LIMIT 2000
    `;

    const { rows } = await dbQuery(sql, [userId]);
    return res.json({ items: rows || [] });
  } catch (err) {
    console.error("reading GET /v1/reading-items/coverage failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;