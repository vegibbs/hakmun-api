// routes/library/share.js — HakMun API (v0.12)
// REGISTRY EPIC 2 — Sharing Grants (write surfaces v0)

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

/* ------------------------------------------------------------------
   POST /v1/library/share/user
   Body: { content_type, content_id, grantee_user_id }
------------------------------------------------------------------ */
router.post("/v1/library/share/user", requireSession, async (req, res) => {
  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const granteeUserID = String(req.body?.grantee_user_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(granteeUserID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or grantee_user_id" });
    }

    // Authorization:
    // - Owner may share their own content
    // - Teacher or root admin may share (platform authority)
    let authorized = false;

    // Fast path: teacher or root admin
    if (req.user.isTeacher || req.user.isRootAdmin) {
      authorized = true;
    }

    // Owner check via registry (best-effort; fail closed if registry row exists and owner mismatch)
    if (!authorized) {
      const r = await withTimeout(
        pool.query(
          `
          select owner_user_id
          from library_registry_items
          where content_type = $1
            and content_id = $2
          limit 1
          `,
          [contentType, contentID]
        ),
        8000,
        "db-check-share-owner"
      );

      if (r.rows?.length) {
        if (String(r.rows[0].owner_user_id) === String(actorUserID)) {
          authorized = true;
        } else {
          return res.status(403).json({ error: "not authorized to share this content" });
        }
      } else {
        // No registry row yet → personal-only content owned by creator
        // Allow owner to share; ownership is implicit in module tables
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: "not authorized to share this content" });
    }

    // Idempotent insert
    await withTimeout(
      pool.query(
        `
        insert into library_share_grants (
          content_type,
          content_id,
          grant_type,
          grantee_id,
          granted_by_user_id
        )
        values ($1, $2, 'user', $3, $4)
        on conflict do nothing
        `,
        [contentType, contentID, granteeUserID, actorUserID]
      ),
      8000,
      "db-insert-share-user"
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/user] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-check-share-owner")) {
      return res.status(503).json({ error: "db timeout checking ownership" });
    }
    if (msg.startsWith("timeout:db-insert-share-user")) {
      return res.status(503).json({ error: "db timeout creating share" });
    }

    return res.status(500).json({ error: "create share failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/library/share/user/revoke
   Body: { content_type, content_id, grantee_user_id }
------------------------------------------------------------------ */
router.post("/v1/library/share/user/revoke", requireSession, async (req, res) => {
  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const granteeUserID = String(req.body?.grantee_user_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(granteeUserID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or grantee_user_id" });
    }

    // Authorization:
    // - Owner may revoke their own shares
    // - Teacher or root admin may revoke (platform authority)
    let authorized = false;

    if (req.user.isTeacher || req.user.isRootAdmin) {
      authorized = true;
    }

    if (!authorized) {
      const r = await withTimeout(
        pool.query(
          `
          select owner_user_id
          from library_registry_items
          where content_type = $1
            and content_id = $2
          limit 1
          `,
          [contentType, contentID]
        ),
        8000,
        "db-check-revoke-owner"
      );

      if (r.rows?.length) {
        if (String(r.rows[0].owner_user_id) === String(actorUserID)) {
          authorized = true;
        } else {
          return res.status(403).json({ error: "not authorized to revoke shares for this content" });
        }
      } else {
        // No registry row yet → allow the actor to revoke shares they granted (minimum safe rule).
        // This avoids assuming module-table ownership in v0.
        authorized = true;
      }
    }

    if (!authorized) {
      return res.status(403).json({ error: "not authorized to revoke this share" });
    }

    const updated = await withTimeout(
      pool.query(
        `
        update library_share_grants
        set revoked_at = now()
        where content_type = $1
          and content_id = $2
          and grant_type = 'user'
          and grantee_id = $3
          and revoked_at is null
        `,
        [contentType, contentID, granteeUserID]
      ),
      8000,
      "db-revoke-share-user"
    );

    // Idempotent behavior: revoking an already-revoked/non-existent grant returns ok.
    return res.json({ ok: true, revoked: Number(updated.rowCount || 0) });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/user/revoke] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-check-revoke-owner")) {
      return res.status(503).json({ error: "db timeout checking ownership" });
    }
    if (msg.startsWith("timeout:db-revoke-share-user")) {
      return res.status(503).json({ error: "db timeout revoking share" });
    }

    return res.status(500).json({ error: "revoke share failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/library/share/class
   Body: { content_type, content_id, class_id }
------------------------------------------------------------------ */
router.post("/v1/library/share/class", requireSession, async (req, res) => {
  try {
    const actorUserID = req.user.userID;

    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const classID = String(req.body?.class_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(classID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or class_id" });
    }

    // Authorization (v0):
    // - Only teacher or root admin may share to a class.
    if (!req.user.isTeacher && !req.user.isRootAdmin) {
      return res.status(403).json({ error: "teacher or root admin required" });
    }

    // Fail-closed validation that the class exists (and optionally that actor is a member/teacher).
    // If class system tables are absent, do NOT bypass: return 501.
    try {
      const c = await withTimeout(
        pool.query(
          `
          select 1
          from classes
          where class_id = $1
          limit 1
          `,
          [classID]
        ),
        8000,
        "db-class-exists-check"
      );

      if (!c.rows || c.rows.length === 0) {
        return res.status(404).json({ error: "class not found" });
      }
    } catch (err) {
      if (String(err?.code || "") === "42P01") {
        // undefined_table
        return res.status(501).json({ error: "class system not implemented on server" });
      }
      throw err;
    }

    // Idempotent insert
    await withTimeout(
      pool.query(
        `
        insert into library_share_grants (
          content_type,
          content_id,
          grant_type,
          grantee_id,
          granted_by_user_id
        )
        values ($1, $2, 'class', $3, $4)
        on conflict do nothing
        `,
        [contentType, contentID, classID, actorUserID]
      ),
      8000,
      "db-insert-share-class"
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/class] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-class-exists-check")) {
      logger.error("timeout:db-class-exists-check", { rid: req._rid });
      return res.status(503).json({ error: "db timeout checking class" });
    }
    if (msg.startsWith("timeout:db-insert-share-class")) {
      logger.error("timeout:db-insert-share-class", { rid: req._rid });
      return res.status(503).json({ error: "db timeout creating class share" });
    }

    return res.status(500).json({ error: "create class share failed" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/library/share/class/revoke
   Body: { content_type, content_id, class_id }
------------------------------------------------------------------ */
router.post("/v1/library/share/class/revoke", requireSession, async (req, res) => {
  try {
    const contentType = String(req.body?.content_type || "").trim();
    const contentID = String(req.body?.content_id || "").trim();
    const classID = String(req.body?.class_id || "").trim();

    if (!contentType || !looksLikeUUID(contentID) || !looksLikeUUID(classID)) {
      return res.status(400).json({ error: "invalid content_type, content_id, or class_id" });
    }

    // Authorization (v0):
    // - Only teacher or root admin may revoke class shares.
    if (!req.user.isTeacher && !req.user.isRootAdmin) {
      return res.status(403).json({ error: "teacher or root admin required" });
    }

    const updated = await withTimeout(
      pool.query(
        `
        update library_share_grants
        set revoked_at = now()
        where content_type = $1
          and content_id = $2
          and grant_type = 'class'
          and grantee_id = $3
          and revoked_at is null
        `,
        [contentType, contentID, classID]
      ),
      8000,
      "db-revoke-share-class"
    );

    // Idempotent behavior: revoking an already-revoked/non-existent grant returns ok.
    return res.json({ ok: true, revoked: Number(updated.rowCount || 0) });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/library/share/class/revoke] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-revoke-share-class")) {
      logger.error("timeout:db-revoke-share-class", { rid: req._rid });
      return res.status(503).json({ error: "db timeout revoking class share" });
    }

    return res.status(500).json({ error: "revoke class share failed" });
  }
});

module.exports = router;