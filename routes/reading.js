// FILE: hakmun-api/routes/reading.js
// PURPOSE: Reading module routes (personal items + coverage)
// NOTE (Postico 063):
// - reading_items renamed -> content_items
// - reading_items_coverage renamed -> content_items_coverage
// - PK column reading_item_id renamed -> content_item_id
// - audio variants table renamed -> content_item_audio_variants (used only by the view)
//
// Registry semantics (Postico 056):
// - library_registry_items.content_type = 'sentence' for sentence content
//
// IMPORTANT:
// - Reading is a module view over canonical content items.
// - We keep response keys compatible with existing clients for now:
//   * still return reading_item_id in JSON, mapped from content_item_id
//   * still return { reading_item, registry_item } on create

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
        ci.content_item_id AS reading_item_id,
        ci.unit_type,
        ci.text,
        ci.language,
        ci.notes,
        ci.created_at,
        ci.updated_at,

        lri.id                 AS registry_item_id,
        lri.audience           AS audience,
        lri.global_state       AS global_state,
        lri.operational_status AS operational_status,
        lri.owner_user_id      AS owner_user_id

      FROM content_items ci
      JOIN library_registry_items lri
        ON lri.content_type = 'sentence'
       AND lri.content_id   = ci.content_item_id
      WHERE ci.owner_user_id = $1::uuid
        AND lri.audience = 'personal'
        AND lri.owner_user_id = $1::uuid
      ORDER BY ci.created_at DESC
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
// Body: { text: string }
router.post("/v1/reading/items", requireSession, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });

  const client = db && typeof db.connect === "function" ? await db.connect() : null;
  const q = client ? client.query.bind(client) : dbQuery;

  try {
    if (client) await q("BEGIN", []);

    // Insert canonical content item (unit_type remains legacy column name)
    const insertContentSql = `
      INSERT INTO content_items (
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
        content_item_id,
        unit_type,
        text,
        language,
        notes,
        created_at,
        updated_at
    `;
    const ins = await q(insertContentSql, [userId, text]);
    const item = ins.rows[0];

    // Insert registry row (content_type='sentence')
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
    const reg = await q(insertRegistrySql, [item.content_item_id, userId]);
    const registryItem = reg.rows[0];

    if (client) await q("COMMIT", []);

    // Response shape compatible with existing iOS client
    return res.status(201).json({
      reading_item: {
        reading_item_id: item.content_item_id,
        unit_type: item.unit_type,
        text: item.text,
        language: item.language,
        notes: item.notes,
        created_at: item.created_at,
        updated_at: item.updated_at
      },
      registry_item: {
        registry_item_id: registryItem.id,
        content_type: registryItem.content_type, // 'sentence'
        content_id: registryItem.content_id,
        owner_user_id: registryItem.owner_user_id,
        audience: registryItem.audience,
        global_state: registryItem.global_state,
        operational_status: registryItem.operational_status,
        created_at: registryItem.created_at,
        updated_at: registryItem.updated_at
      }
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
        cic.content_item_id AS reading_item_id,
        cic.owner_user_id,
        cic.unit_type,
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
        cic.variants_count,

        lri.id                 AS registry_item_id,
        lri.audience           AS audience,
        lri.global_state       AS global_state,
        lri.operational_status AS operational_status,
        lri.owner_user_id      AS registry_owner_user_id

      FROM content_items_coverage cic
      JOIN library_registry_items lri
        ON lri.content_type = 'sentence'
       AND lri.content_id   = cic.content_item_id
      WHERE cic.owner_user_id = $1::uuid
        AND lri.audience = 'personal'
        AND lri.owner_user_id = $1::uuid
      ORDER BY cic.created_at DESC
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