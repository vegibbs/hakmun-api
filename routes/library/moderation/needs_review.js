// routes/library/moderation/needs_review.js — HakMun API (v0.12)
// POST /v1/library/needs-review

const express = require("express");

const { pool } = require("../../../db/pool");
const { logger } = require("../../../util/log");
const { withTimeout } = require("../../../util/time");
const { requireSession } = require("../../../auth/session");

const router = express.Router();

function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

// Body: { content_type, content_id, reason? }
router.post("/v1/library/needs-review", requireSession, async (req, res) => {
  const rid = req._rid;

  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const reason =
      req.body?.reason !== undefined ? String(req.body.reason).trim().slice(0, 500) : null;

    if (!contentType || !looksLikeUUID(contentID)) {
      return res.status(400).json({ error: "invalid content_type or content_id" });
    }

    const NEEDS_REVIEW_MAX_PER_HOUR = 20;

    const rate = await withTimeout(
      pool.query(
        `
        select count(*)::int as c
        from library_moderation_actions
        where actor_user_id = $1
          and action = 'needs_review'
          and created_at > now() - interval '1 hour'
        `,
        [actorUserID]
      ),
      8000,
      "db-needs-review-rate"
    );

    const c = rate.rows?.[0]?.c ?? 0;
    if (c >= NEEDS_REVIEW_MAX_PER_HOUR) {
      return res.status(429).json({
        error: "rate_limited",
        action: "needs_review",
        window_sec: 3600,
        limit: NEEDS_REVIEW_MAX_PER_HOUR
      });
    }

    const client = await pool.connect();
    try {
      await client.query(`set statement_timeout = 8000;`);
      await client.query(`set lock_timeout = 2000;`);
      await client.query("BEGIN");

      const r = await client.query(
        `
        select
          id,
          content_type,
          content_id,
          audience,
          global_state,
          operational_status,
          owner_user_id,
          created_at,
          updated_at
        from library_registry_items
        where content_type = $1 and content_id = $2
        for update
        `,
        [contentType, contentID]
      );

      const item = r.rows?.[0];
      if (!item?.id) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "registry item not found" });
      }

      const isOwner = String(item.owner_user_id) === String(actorUserID);
      if (!req.user.isRootAdmin && !req.user.isTeacher && !isOwner) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "not authorized to flag needs_review" });
      }

      if (String(item.operational_status) === "under_review") {
        await client.query("COMMIT");
        return res.json({ ok: true, already_under_review: true });
      }

      const beforeSnapshot = {
        registry_item_id: item.id,
        content_type: item.content_type,
        content_id: item.content_id,
        audience: item.audience,
        global_state: item.global_state,
        operational_status: item.operational_status,
        owner_user_id: item.owner_user_id,
        created_at: item.created_at,
        updated_at: item.updated_at
      };

      const updated = await client.query(
        `
        update library_registry_items
        set operational_status = 'under_review',
            updated_at = now()
        where id = $1
        returning
          id,
          content_type,
          content_id,
          audience,
          global_state,
          operational_status,
          owner_user_id,
          created_at,
          updated_at
        `,
        [item.id]
      );

      const after = updated.rows?.[0];
      const afterSnapshot = {
        registry_item_id: after.id,
        content_type: after.content_type,
        content_id: after.content_id,
        audience: after.audience,
        global_state: after.global_state,
        operational_status: after.operational_status,
        owner_user_id: after.owner_user_id,
        created_at: after.created_at,
        updated_at: after.updated_at
      };

      const existingRQ = await client.query(
        `
        select id
        from library_review_queue
        where registry_item_id = $1
          and resolved_at is null
        limit 1
        `,
        [item.id]
      );

      if (!existingRQ.rows?.length) {
        await client.query(
          `
          insert into library_review_queue (
            registry_item_id,
            flagged_by_user_id,
            flagged_at,
            reason,
            prior_snapshot
          )
          values ($1, $2, now(), $3, $4)
          `,
          [item.id, actorUserID, reason, beforeSnapshot]
        );
      }

      await client.query(
        `
        insert into library_moderation_actions (
          content_type,
          content_id,
          actor_user_id,
          action,
          reason,
          before_snapshot,
          after_snapshot,
          meta
        )
        values ($1,$2,$3,'needs_review',$4,$5,$6,$7)
        `,
        [contentType, contentID, actorUserID, reason, beforeSnapshot, afterSnapshot, { rid }]
      );

      await client.query("COMMIT");

      logger.info("[/v1/library/needs-review][ok]", {
        rid,
        actorUserID,
        contentType,
        contentID,
        registry_item_id: item.id
      });

      return res.json({ ok: true, registry_item_id: item.id });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/needs-review] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-needs-review-rate")) {
      logger.error("timeout:db-needs-review-rate", { rid: req._rid });
      return res.status(503).json({ error: "db timeout rate limiting" });
    }

    if (msg.includes("timeout:") || msg.includes("statement timeout") || msg.includes("lock timeout")) {
      return res.status(503).json({ error: "db timeout" });
    }

    return res.status(500).json({ error: "needs_review failed" });
  }
});

module.exports = router;