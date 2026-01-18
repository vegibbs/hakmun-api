// routes/library/listing.js — HakMun API (v0.12)
// Registry/listing read surfaces (global, inbox, history, my-content, shared-with-*)
// No behavior changes; same paths as original.

const express = require("express");

const { pool } = require("../../db/pool");
const { logger } = require("../../util/log");
const { withTimeout } = require("../../util/time");
const { requireSession } = require("../../auth/session");

const router = express.Router();

function requireRootAdmin(req, res, next) {
  if (!req.user?.capabilities?.canAdminUsers) {
    return res.status(403).json({ error: "root admin required" });
  }
  return next();
}

function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

// GET /v1/library/shared-with-me
router.get("/v1/library/shared-with-me", requireSession, async (req, res) => {
  try {
    const userID = req.user.userID;

    const r = await withTimeout(
      pool.query(
        `
        select
          sg.id as share_grant_id,
          sg.content_type,
          sg.content_id,
          sg.granted_by_user_id,
          sg.created_at as granted_at,

          ri.id as registry_item_id,
          ri.audience,
          ri.global_state,
          ri.operational_status,
          ri.owner_user_id as registry_owner_user_id

        from library_share_grants sg
        left join library_registry_items ri
          on ri.content_type = sg.content_type
         and ri.content_id = sg.content_id

        where sg.grant_type = 'user'
          and sg.grantee_id = $1
          and sg.revoked_at is null
          and (ri.id is null or ri.operational_status <> 'under_review')

        order by sg.created_at desc
        limit 200
        `,
        [userID]
      ),
      8000,
      "db-list-shared-with-me"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/shared-with-me] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-shared-with-me")) {
      logger.error("timeout:db-list-shared-with-me", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing shared items" });
    }

    return res.status(500).json({ error: "list shared items failed" });
  }
});

// GET /v1/library/shared-with-class?class_id=<uuid>
router.get("/v1/library/shared-with-class", requireSession, async (req, res) => {
  try {
    const userID = req.user.userID;
    const classID = String(req.query?.class_id || "").trim();

    if (!looksLikeUUID(classID)) {
      return res.status(400).json({ error: "class_id (uuid) is required" });
    }

    if (!req.user?.capabilities?.canAdminUsers) {
      try {
        const m = await withTimeout(
          pool.query(
            `
            select 1
            from class_memberships
            where class_id = $1
              and user_id = $2
              and (revoked_at is null)
            limit 1
            `,
            [classID, userID]
          ),
          8000,
          "db-class-membership-check"
        );

        if (!m.rows || m.rows.length === 0) {
          return res.status(403).json({ error: "not a member of this class" });
        }
      } catch (err) {
        if (String(err?.code || "") === "42P01") {
          return res.status(501).json({ error: "class membership not implemented on server" });
        }
        throw err;
      }
    }

    const r = await withTimeout(
      pool.query(
        `
        select
          sg.id as share_grant_id,
          sg.content_type,
          sg.content_id,
          sg.granted_by_user_id,
          sg.created_at as granted_at,

          ri.id as registry_item_id,
          ri.audience,
          ri.global_state,
          ri.operational_status,
          ri.owner_user_id as registry_owner_user_id

        from library_share_grants sg
        left join library_registry_items ri
          on ri.content_type = sg.content_type
         and ri.content_id = sg.content_id

        where sg.grant_type = 'class'
          and sg.grantee_id = $1
          and sg.revoked_at is null
          and (ri.id is null or ri.operational_status <> 'under_review')

        order by sg.created_at desc
        limit 200
        `,
        [classID]
      ),
      8000,
      "db-list-shared-with-class"
    );

    return res.json({ class_id: classID, items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/shared-with-class] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-class-membership-check")) {
      logger.error("timeout:db-class-membership-check", { rid: req._rid });
      return res.status(503).json({ error: "db timeout checking class membership" });
    }
    if (msg.startsWith("timeout:db-list-shared-with-class")) {
      logger.error("timeout:db-list-shared-with-class", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing class shared items" });
    }

    return res.status(500).json({ error: "list class shared items failed" });
  }
});

// GET /v1/library/my-content
router.get("/v1/library/my-content", requireSession, async (req, res) => {
  try {
    const ownerUserID = req.user.userID;

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
        where owner_user_id = $1
          and operational_status = 'active'
        order by created_at desc
        limit 500
        `,
        [ownerUserID]
      ),
      8000,
      "db-list-my-content"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/my-content] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-my-content")) {
      logger.error("timeout:db-list-my-content", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing owned content" });
    }

    return res.status(500).json({ error: "list my content failed" });
  }
});

// GET /v1/library/global
router.get("/v1/library/global", requireSession, async (req, res) => {
  try {
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
        where audience = 'global'
          and operational_status = 'active'
          and global_state in ('preliminary', 'approved')
        order by created_at desc
        limit 200
        `
      ),
      8000,
      "db-list-global-library"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/global] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-global-library")) {
      logger.error("timeout:db-list-global-library", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing global library" });
    }

    return res.status(500).json({ error: "list global library failed" });
  }
});

// GET /v1/library/review-inbox (root-admin-only)
router.get("/v1/library/review-inbox", requireSession, requireRootAdmin, async (req, res) => {
  try {
    const r = await withTimeout(
      pool.query(
        `
        select
          rq.id as review_queue_id,
          rq.registry_item_id,
          rq.flagged_by_user_id,
          rq.flagged_at,
          rq.reason,
          rq.prior_snapshot,

          ri.content_type,
          ri.content_id,
          ri.audience,
          ri.global_state,
          ri.operational_status,
          ri.owner_user_id,
          ri.created_at,
          ri.updated_at
        from library_review_queue rq
        join library_registry_items ri
          on ri.id = rq.registry_item_id
        where ri.operational_status = 'under_review'
          and rq.resolved_at is null
        order by rq.flagged_at desc
        limit 200
        `
      ),
      8000,
      "db-list-review-inbox"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/review-inbox] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-review-inbox")) {
      logger.error("timeout:db-list-review-inbox", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing review inbox" });
    }

    return res.status(500).json({ error: "list review inbox failed" });
  }
});

// GET /v1/library/review-inbox/history?limit=50 (root-admin-only)
router.get("/v1/library/review-inbox/history", requireSession, requireRootAdmin, async (req, res) => {
  const rid = req._rid;
  const limit = Math.min(Math.max(parseInt(req.query?.limit || "50", 10), 1), 200);

  try {
    const r = await withTimeout(
      pool.query(
        `
        select
          ma.action,
          ma.created_at as action_at,
          ma.actor_user_id,
          ma.content_type,
          ma.content_id,
          rq.id as review_queue_id,
          rq.resolved_at,
          ri.owner_user_id,
          ri.audience,
          ri.global_state,
          ri.operational_status
        from library_moderation_actions ma
        left join library_registry_items ri
          on ri.content_type = ma.content_type
         and ri.content_id = ma.content_id
        left join library_review_queue rq
          on rq.registry_item_id = ri.id
        where ma.action in ('restore','approve','reject')
          and rq.resolved_at is not null
        order by ma.created_at desc
        limit $1
        `,
        [limit]
      ),
      8000,
      "db-list-review-inbox-history"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/review-inbox/history] failed", { rid, err: msg });

    if (msg.startsWith("timeout:db-list-review-inbox-history")) {
      logger.error("timeout:db-list-review-inbox-history", { rid });
      return res.status(503).json({ error: "db timeout listing review history" });
    }

    return res.status(500).json({ error: "review history failed" });
  }
});

module.exports = router;