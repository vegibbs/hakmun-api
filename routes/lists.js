// FILE: hakmun-api/routes/lists.js
// PURPOSE: CRUD for user lists and list items.

const express = require("express");
const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// ---------------------------------------------------------------------------
// Lists CRUD
// ---------------------------------------------------------------------------

// GET /v1/lists — all lists for current user (with item counts)
router.get("/v1/lists", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(
        `SELECT
           l.id,
           l.name,
           l.description,
           l.global_weight,
           l.is_active,
           l.created_at,
           l.updated_at,
           COALESCE(ic.item_count, 0)::int AS item_count
         FROM lists l
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS item_count
             FROM list_items li
            WHERE li.list_id = l.id
         ) ic ON true
         WHERE l.user_id = $1::uuid
         ORDER BY l.created_at DESC`,
        [userId]
      ),
      8000,
      "db-list-lists"
    );

    return res.json({ ok: true, lists: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] list failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /v1/lists/:id — single list with its items
router.get("/v1/lists/:id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const listId = req.params.id;

    const listR = await withTimeout(
      pool.query(
        `SELECT id, name, description, global_weight, is_active, created_at, updated_at
           FROM lists
          WHERE id = $1::uuid AND user_id = $2::uuid`,
        [listId, userId]
      ),
      8000,
      "db-get-list"
    );

    if (listR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const itemsR = await withTimeout(
      pool.query(
        `SELECT
           li.id,
           li.list_id,
           li.item_type,
           li.item_id,
           li.position,
           li.added_at,
           ci.content_item_id,
           ci.content_type,
           ci.text,
           ci.language,
           ci.notes,
           ci.cefr_level,
           ci.topic,
           ci.politeness,
           ci.tense,
           ci.created_at AS content_created_at,
           lri.audience,
           lri.global_state,
           lri.operational_status
         FROM list_items li
         LEFT JOIN content_items ci
           ON li.item_id = ci.content_item_id
          AND li.item_type IN ('sentence', 'pattern')
         LEFT JOIN library_registry_items lri
           ON lri.content_item_id = ci.content_item_id
          AND lri.content_type = ci.content_type
          AND lri.owner_user_id = $2::uuid
         WHERE li.list_id = $1::uuid
         ORDER BY li.position ASC, li.added_at ASC`,
        [listId, userId]
      ),
      8000,
      "db-get-list-items"
    );

    return res.json({
      ok: true,
      list: listR.rows[0],
      items: itemsR.rows || []
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] get failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/lists — create a new list
router.post("/v1/lists", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ ok: false, error: "NAME_REQUIRED" });

    const description = typeof req.body?.description === "string" ? req.body.description.trim() || null : null;
    const globalWeight = Number.isInteger(req.body?.global_weight) ? Math.max(1, Math.min(5, req.body.global_weight)) : 3;

    const r = await withTimeout(
      pool.query(
        `INSERT INTO lists (user_id, name, description, global_weight)
         VALUES ($1::uuid, $2, $3, $4)
         RETURNING id, name, description, global_weight, is_active, created_at, updated_at`,
        [userId, name, description, globalWeight]
      ),
      8000,
      "db-create-list"
    );

    return res.status(201).json({ ok: true, list: r.rows[0] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] create failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// PUT /v1/lists/:id — update list metadata
router.put("/v1/lists/:id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const listId = req.params.id;
    const body = req.body || {};

    // Build SET clauses dynamically for provided fields
    const sets = [];
    const params = [listId, userId];
    let idx = 3;

    if (typeof body.name === "string" && body.name.trim()) {
      sets.push(`name = $${idx++}`);
      params.push(body.name.trim());
    }
    if (body.description !== undefined) {
      const desc = typeof body.description === "string" ? body.description.trim() || null : null;
      sets.push(`description = $${idx++}`);
      params.push(desc);
    }
    if (Number.isInteger(body.global_weight)) {
      sets.push(`global_weight = $${idx++}`);
      params.push(Math.max(1, Math.min(5, body.global_weight)));
    }
    if (typeof body.is_active === "boolean") {
      sets.push(`is_active = $${idx++}`);
      params.push(body.is_active);
    }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_FIELDS" });
    }

    const r = await withTimeout(
      pool.query(
        `UPDATE lists
            SET ${sets.join(", ")}
          WHERE id = $1::uuid AND user_id = $2::uuid
         RETURNING id, name, description, global_weight, is_active, created_at, updated_at`,
        params
      ),
      8000,
      "db-update-list"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true, list: r.rows[0] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] update failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/lists/:id — delete a list (items cascade)
router.delete("/v1/lists/:id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const listId = req.params.id;

    const r = await withTimeout(
      pool.query(
        `DELETE FROM lists WHERE id = $1::uuid AND user_id = $2::uuid`,
        [listId, userId]
      ),
      8000,
      "db-delete-list"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] delete failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// List Items
// ---------------------------------------------------------------------------

// POST /v1/lists/:id/items — add item(s) to a list
router.post("/v1/lists/:id/items", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const listId = req.params.id;

    // Verify ownership
    const ownerR = await withTimeout(
      pool.query(`SELECT id FROM lists WHERE id = $1::uuid AND user_id = $2::uuid`, [listId, userId]),
      8000,
      "db-check-list-owner"
    );
    if (ownerR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    // Accept single item or array
    let items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0 && req.body?.item_type && req.body?.item_id) {
      items = [{ item_type: req.body.item_type, item_id: req.body.item_id }];
    }
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_ITEMS" });
    }

    // Get max position
    const maxR = await withTimeout(
      pool.query(`SELECT COALESCE(MAX(position), 0) AS max_pos FROM list_items WHERE list_id = $1::uuid`, [listId]),
      8000,
      "db-max-position"
    );
    let pos = (maxR.rows[0]?.max_pos || 0) + 100;

    const added = [];
    for (const item of items) {
      const itemType = typeof item.item_type === "string" ? item.item_type.trim() : "";
      const itemId = typeof item.item_id === "string" ? item.item_id.trim() : "";
      if (!itemType || !itemId) continue;
      if (!["sentence", "pattern", "vocabulary"].includes(itemType)) continue;

      try {
        const r = await pool.query(
          `INSERT INTO list_items (list_id, item_type, item_id, position)
           VALUES ($1::uuid, $2, $3::uuid, $4)
           ON CONFLICT (list_id, item_type, item_id) DO NOTHING
           RETURNING id, list_id, item_type, item_id, position, added_at`,
          [listId, itemType, itemId, pos]
        );
        if (r.rows.length > 0) {
          added.push(r.rows[0]);
          pos += 100;
        }
      } catch (insertErr) {
        // Skip invalid item_id UUIDs etc.
        logger.warn("[lists] item insert skipped", { item_type: itemType, item_id: itemId, err: String(insertErr?.message || insertErr) });
      }
    }

    return res.status(201).json({ ok: true, added, added_count: added.length });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] add items failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/lists/:id/items/:item_id — remove an item from a list
router.delete("/v1/lists/:id/items/:item_id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const listId = req.params.id;
    const itemId = req.params.item_id;

    // Verify ownership via join
    const r = await withTimeout(
      pool.query(
        `DELETE FROM list_items li
          USING lists l
          WHERE li.id = $1::uuid
            AND li.list_id = l.id
            AND l.id = $2::uuid
            AND l.user_id = $3::uuid`,
        [itemId, listId, userId]
      ),
      8000,
      "db-delete-list-item"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] remove item failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// PUT /v1/lists/:id/items/reorder — reorder items (accepts array of item IDs)
router.put("/v1/lists/:id/items/reorder", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const listId = req.params.id;
    const itemIds = Array.isArray(req.body?.item_ids) ? req.body.item_ids : [];
    if (itemIds.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_ITEM_IDS" });
    }

    // Verify ownership
    const ownerR = await withTimeout(
      pool.query(`SELECT id FROM lists WHERE id = $1::uuid AND user_id = $2::uuid`, [listId, userId]),
      8000,
      "db-check-list-owner-reorder"
    );
    if (ownerR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    // Update positions using gap-based numbering
    for (let i = 0; i < itemIds.length; i++) {
      await pool.query(
        `UPDATE list_items SET position = $1 WHERE id = $2::uuid AND list_id = $3::uuid`,
        [(i + 1) * 100, itemIds[i], listId]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[lists] reorder failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
