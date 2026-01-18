// routes/library/item_status.js — HakMun API (v0.12)
// REGISTRY EPIC 3 — Owner Status Introspection (read-only)

const express = require("express");

const { pool } = require("../../db/pool");
const { logger } = require("../../util/log");
const { withTimeout } = require("../../util/time");
const { requireSession } = require("../../auth/session");

const router = express.Router();

function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

// GET /v1/library/item-status?content_type=<text>&content_id=<uuid>
router.get("/v1/library/item-status", requireSession, async (req, res) => {
  const rid = req._rid;

  try {
    const contentType = String(req.query?.content_type || "").trim();
    const contentID = String(req.query?.content_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID)) {
      return res.status(400).json({ error: "invalid content_type or content_id" });
    }

    const r = await withTimeout(
      pool.query(
        `
        select
          id as registry_item_id,
          content_type,
          content_id,
          audience,
          global_state,
          operational_status,
          owner_user_id,
          created_at,
          updated_at
        from library_registry_items
        where content_type = $1
          and content_id = $2
        limit 1
        `,
        [contentType, contentID]
      ),
      8000,
      "db-get-registry-item-status"
    );

    const item = r.rows?.[0];
    if (!item?.registry_item_id) {
      return res.status(404).json({ error: "registry item not found" });
    }

    const actorUserID = req.user.userID;
    const isOwner = String(item.owner_user_id) === String(actorUserID);

    if (!isOwner && !req.user.isRootAdmin) {
      return res.status(403).json({ error: "not authorized" });
    }

    const a = await withTimeout(
      pool.query(
        `
        select
          action,
          created_at,
          actor_user_id
        from library_moderation_actions
        where content_type = $1
          and content_id = $2
        order by created_at desc
        limit 1
        `,
        [contentType, contentID]
      ),
      8000,
      "db-get-last-moderation-action"
    );

    const last = a.rows?.[0] || null;

    return res.json({
      registry_item: {
        registry_item_id: item.registry_item_id,
        content_type: item.content_type,
        content_id: item.content_id,
        audience: item.audience,
        global_state: item.global_state,
        operational_status: item.operational_status,
        owner_user_id: item.owner_user_id,
        created_at: item.created_at,
        updated_at: item.updated_at
      },
      last_action: last
        ? {
            action: last.action,
            created_at: last.created_at,
            actor_user_id: last.actor_user_id
          }
        : null
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/item-status] failed", { rid, err: msg });

    if (msg.startsWith("timeout:db-get-registry-item-status")) {
      logger.error("timeout:db-get-registry-item-status", { rid });
      return res.status(503).json({ error: "db timeout resolving item status" });
    }
    if (msg.startsWith("timeout:db-get-last-moderation-action")) {
      logger.error("timeout:db-get-last-moderation-action", { rid });
      return res.status(503).json({ error: "db timeout resolving last action" });
    }

    return res.status(500).json({ error: "item-status failed" });
  }
});

module.exports = router;