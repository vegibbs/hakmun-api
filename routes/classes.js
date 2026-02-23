// FILE: hakmun-api/routes/classes.js
// PURPOSE: CRUD for classes — containers that group documents, lists, and students.

const express = require("express");
const { requireSession, requireRole } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// ===========================================================================
// USER SEARCH (must be before /:classId routes)
// ===========================================================================

// GET /v1/classes/search-users?q=... — search users by handle or display name
router.get(
  "/v1/classes/search-users",
  requireSession,
  requireRole("teacher", "approver", "admin"),
  async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) {
        return res.json({ ok: true, users: [] });
      }

      const pattern = `%${q}%`;
      const r = await withTimeout(
        pool.query(
          `SELECT u.user_id, u.display_name, uh.handle AS primary_handle, u.role
             FROM users u
             LEFT JOIN user_handles uh
               ON uh.user_id = u.user_id AND uh.kind = 'primary'
            WHERE u.is_active = true
              AND (uh.handle ILIKE $1 OR u.display_name ILIKE $1)
            ORDER BY u.display_name NULLS LAST
            LIMIT 20`,
          [pattern]
        ),
        8000,
        "db-search-users"
      );

      return res.json({ ok: true, users: r.rows });
    } catch (err) {
      logger.error("[classes] search-users failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// ===========================================================================
// CLASSES CRUD
// ===========================================================================

// GET /v1/classes — list classes (owned + enrolled)
router.get("/v1/classes", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(
        `SELECT c.class_id, c.name, c.description, c.is_active,
                c.teacher_id, c.created_at, c.updated_at,
                COALESCE(mc.cnt, 0)::int AS member_count,
                COALESCE(lc.cnt, 0)::int AS list_count,
                COALESCE(dc.cnt, 0)::int AS document_count
           FROM classes c
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS cnt FROM class_members WHERE class_id = c.class_id
           ) mc ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS cnt FROM class_lists WHERE class_id = c.class_id
           ) lc ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS cnt FROM class_documents WHERE class_id = c.class_id
           ) dc ON true
          WHERE c.teacher_id = $1::uuid
             OR c.class_id IN (
               SELECT cm.class_id FROM class_members cm WHERE cm.user_id = $1::uuid
             )
          ORDER BY c.updated_at DESC`,
        [userId]
      ),
      8000,
      "db-list-classes"
    );

    return res.json({ ok: true, classes: r.rows });
  } catch (err) {
    logger.error("[classes] list failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// POST /v1/classes — create a new class (teacher+ only)
router.post(
  "/v1/classes",
  requireSession,
  requireRole("teacher", "approver", "admin"),
  async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name)
        return res.status(400).json({ ok: false, error: "NAME_REQUIRED" });

      const description =
        typeof req.body?.description === "string"
          ? req.body.description.trim() || null
          : null;

      const r = await withTimeout(
        pool.query(
          `INSERT INTO classes (teacher_id, name, description)
           VALUES ($1::uuid, $2, $3)
           RETURNING class_id, teacher_id, name, description, is_active, created_at, updated_at`,
          [userId, name, description]
        ),
        8000,
        "db-create-class"
      );

      return res.status(201).json({ ok: true, class_info: r.rows[0] });
    } catch (err) {
      logger.error("[classes] create failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// GET /v1/classes/:classId — full detail (class + members + lists + documents)
router.get("/v1/classes/:classId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;

    // Verify access (owner or member)
    const classR = await withTimeout(
      pool.query(
        `SELECT c.class_id, c.teacher_id, c.name, c.description, c.is_active,
                c.created_at, c.updated_at
           FROM classes c
          WHERE c.class_id = $1::uuid
            AND (c.teacher_id = $2::uuid
                 OR EXISTS (
                   SELECT 1 FROM class_members cm
                    WHERE cm.class_id = c.class_id AND cm.user_id = $2::uuid
                 ))`,
        [classId, userId]
      ),
      8000,
      "db-get-class"
    );

    if (classR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    // Fetch members, lists, documents in parallel
    const [membersR, listsR, docsR] = await Promise.all([
      withTimeout(
        pool.query(
          `SELECT cm.id, cm.class_id, cm.user_id, cm.role, cm.joined_at,
                  u.display_name, uh.handle AS primary_handle
             FROM class_members cm
             JOIN users u ON u.user_id = cm.user_id
             LEFT JOIN user_handles uh
               ON uh.user_id = u.user_id AND uh.kind = 'primary'
            WHERE cm.class_id = $1::uuid
            ORDER BY cm.joined_at ASC`,
          [classId]
        ),
        8000,
        "db-get-class-members"
      ),
      withTimeout(
        pool.query(
          `SELECT cl.id, cl.class_id, cl.list_id, cl.attached_at,
                  l.name AS list_name,
                  COALESCE(ic.cnt, 0)::int AS item_count
             FROM class_lists cl
             JOIN lists l ON l.id = cl.list_id
             LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS cnt FROM list_items WHERE list_id = l.id
             ) ic ON true
            WHERE cl.class_id = $1::uuid
            ORDER BY cl.attached_at ASC`,
          [classId]
        ),
        8000,
        "db-get-class-lists"
      ),
      withTimeout(
        pool.query(
          `SELECT cd.id, cd.class_id, cd.document_type, cd.document_id,
                  cd.attached_at,
                  CASE
                    WHEN cd.document_type = 'hakdoc'
                      THEN (SELECT h.title FROM hakdocs h WHERE h.hakdoc_id = cd.document_id::uuid)
                    WHEN cd.document_type = 'google_doc'
                      THEN (SELECT ds.title FROM document_sources ds WHERE ds.saved_source_id = cd.document_id::uuid)
                  END AS title
             FROM class_documents cd
            WHERE cd.class_id = $1::uuid
            ORDER BY cd.attached_at ASC`,
          [classId]
        ),
        8000,
        "db-get-class-documents"
      ),
    ]);

    return res.json({
      ok: true,
      class_info: classR.rows[0],
      members: membersR.rows,
      lists: listsR.rows,
      documents: docsR.rows,
    });
  } catch (err) {
    logger.error("[classes] get detail failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// PUT /v1/classes/:classId — update class metadata (owner only)
router.put("/v1/classes/:classId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;
    const body = req.body || {};

    const sets = [];
    const params = [classId, userId];
    let idx = 3;

    if (typeof body.name === "string" && body.name.trim()) {
      sets.push(`name = $${idx++}`);
      params.push(body.name.trim());
    }
    if (body.description !== undefined) {
      const desc =
        typeof body.description === "string"
          ? body.description.trim() || null
          : null;
      sets.push(`description = $${idx++}`);
      params.push(desc);
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
        `UPDATE classes
            SET ${sets.join(", ")}
          WHERE class_id = $1::uuid AND teacher_id = $2::uuid
         RETURNING class_id, teacher_id, name, description, is_active, created_at, updated_at`,
        params
      ),
      8000,
      "db-update-class"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true, class_info: r.rows[0] });
  } catch (err) {
    logger.error("[classes] update failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/classes/:classId — delete class (owner only, cascades everything)
router.delete("/v1/classes/:classId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;

    const r = await withTimeout(
      pool.query(
        `DELETE FROM classes WHERE class_id = $1::uuid AND teacher_id = $2::uuid`,
        [classId, userId]
      ),
      8000,
      "db-delete-class"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[classes] delete failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ===========================================================================
// MEMBERS
// ===========================================================================

// POST /v1/classes/:classId/members — add a member (owner only)
router.post("/v1/classes/:classId/members", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;
    const memberUserId = req.body?.user_id;
    const role = req.body?.role || "student";

    if (!memberUserId) {
      return res.status(400).json({ ok: false, error: "USER_ID_REQUIRED" });
    }

    // Verify ownership
    const ownerR = await withTimeout(
      pool.query(
        `SELECT class_id FROM classes WHERE class_id = $1::uuid AND teacher_id = $2::uuid`,
        [classId, userId]
      ),
      8000,
      "db-check-class-owner"
    );
    if (ownerR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const r = await withTimeout(
      pool.query(
        `INSERT INTO class_members (class_id, user_id, role)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (class_id, user_id) DO NOTHING
         RETURNING id, class_id, user_id, role, joined_at`,
        [classId, memberUserId, role]
      ),
      8000,
      "db-add-class-member"
    );

    if (r.rows.length === 0) {
      return res.json({ ok: true, member: null, note: "ALREADY_MEMBER" });
    }

    // Fetch display info
    const infoR = await pool.query(
      `SELECT u.display_name, uh.handle AS primary_handle
         FROM users u
         LEFT JOIN user_handles uh ON uh.user_id = u.user_id AND uh.kind = 'primary'
        WHERE u.user_id = $1::uuid`,
      [memberUserId]
    );

    const member = {
      ...r.rows[0],
      display_name: infoR.rows[0]?.display_name || null,
      primary_handle: infoR.rows[0]?.primary_handle || null,
    };

    return res.status(201).json({ ok: true, member });
  } catch (err) {
    logger.error("[classes] add member failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/classes/:classId/members/:userId — remove a member (owner only)
router.delete(
  "/v1/classes/:classId/members/:userId",
  requireSession,
  async (req, res) => {
    try {
      const callerId = getUserId(req);
      if (!callerId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { classId, userId: memberUserId } = req.params;

      // Verify ownership
      const ownerR = await withTimeout(
        pool.query(
          `SELECT class_id FROM classes WHERE class_id = $1::uuid AND teacher_id = $2::uuid`,
          [classId, callerId]
        ),
        8000,
        "db-check-class-owner-rm"
      );
      if (ownerR.rows.length === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      const r = await withTimeout(
        pool.query(
          `DELETE FROM class_members
            WHERE class_id = $1::uuid AND user_id = $2::uuid`,
          [classId, memberUserId]
        ),
        8000,
        "db-remove-class-member"
      );

      if (r.rowCount === 0) {
        return res.status(404).json({ ok: false, error: "MEMBER_NOT_FOUND" });
      }

      return res.json({ ok: true });
    } catch (err) {
      logger.error("[classes] remove member failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// ===========================================================================
// LISTS (attach/detach)
// ===========================================================================

// POST /v1/classes/:classId/lists — attach a list
router.post("/v1/classes/:classId/lists", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;
    const listId = req.body?.list_id;
    if (!listId) {
      return res.status(400).json({ ok: false, error: "LIST_ID_REQUIRED" });
    }

    // Verify ownership
    const ownerR = await withTimeout(
      pool.query(
        `SELECT class_id FROM classes WHERE class_id = $1::uuid AND teacher_id = $2::uuid`,
        [classId, userId]
      ),
      8000,
      "db-check-class-owner-list"
    );
    if (ownerR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const r = await withTimeout(
      pool.query(
        `INSERT INTO class_lists (class_id, list_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (class_id, list_id) DO NOTHING
         RETURNING id, class_id, list_id, attached_at`,
        [classId, listId]
      ),
      8000,
      "db-attach-class-list"
    );

    if (r.rows.length === 0) {
      return res.json({ ok: true, attachment: null, note: "ALREADY_ATTACHED" });
    }

    // Fetch list info
    const listR = await pool.query(
      `SELECT l.name AS list_name,
              COALESCE((SELECT COUNT(*)::int FROM list_items WHERE list_id = l.id), 0) AS item_count
         FROM lists l WHERE l.id = $1::uuid`,
      [listId]
    );

    const attachment = {
      ...r.rows[0],
      list_name: listR.rows[0]?.list_name || null,
      item_count: listR.rows[0]?.item_count || 0,
    };

    return res.status(201).json({ ok: true, attachment });
  } catch (err) {
    logger.error("[classes] attach list failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/classes/:classId/lists/:attachmentId — detach a list
router.delete(
  "/v1/classes/:classId/lists/:attachmentId",
  requireSession,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { classId, attachmentId } = req.params;

      const r = await withTimeout(
        pool.query(
          `DELETE FROM class_lists cl
            USING classes c
            WHERE cl.id = $1::uuid
              AND cl.class_id = $2::uuid
              AND c.class_id = cl.class_id
              AND c.teacher_id = $3::uuid`,
          [attachmentId, classId, userId]
        ),
        8000,
        "db-detach-class-list"
      );

      if (r.rowCount === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      return res.json({ ok: true });
    } catch (err) {
      logger.error("[classes] detach list failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// ===========================================================================
// DOCUMENTS (attach/detach)
// ===========================================================================

// POST /v1/classes/:classId/documents — attach a document
router.post(
  "/v1/classes/:classId/documents",
  requireSession,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { classId } = req.params;
      const documentType = req.body?.document_type;
      const documentId = req.body?.document_id;

      if (
        !documentType ||
        !documentId ||
        !["hakdoc", "google_doc"].includes(documentType)
      ) {
        return res
          .status(400)
          .json({ ok: false, error: "DOCUMENT_TYPE_AND_ID_REQUIRED" });
      }

      // Verify ownership
      const ownerR = await withTimeout(
        pool.query(
          `SELECT class_id FROM classes WHERE class_id = $1::uuid AND teacher_id = $2::uuid`,
          [classId, userId]
        ),
        8000,
        "db-check-class-owner-doc"
      );
      if (ownerR.rows.length === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      const r = await withTimeout(
        pool.query(
          `INSERT INTO class_documents (class_id, document_type, document_id)
           VALUES ($1::uuid, $2, $3)
           ON CONFLICT (class_id, document_type, document_id) DO NOTHING
           RETURNING id, class_id, document_type, document_id, attached_at`,
          [classId, documentType, documentId]
        ),
        8000,
        "db-attach-class-document"
      );

      if (r.rows.length === 0) {
        return res.json({
          ok: true,
          attachment: null,
          note: "ALREADY_ATTACHED",
        });
      }

      // Resolve title
      let title = null;
      if (documentType === "hakdoc") {
        const tr = await pool.query(
          `SELECT title FROM hakdocs WHERE hakdoc_id = $1::uuid`,
          [documentId]
        );
        title = tr.rows[0]?.title || null;
      } else if (documentType === "google_doc") {
        const tr = await pool.query(
          `SELECT title FROM document_sources WHERE saved_source_id = $1::uuid`,
          [documentId]
        );
        title = tr.rows[0]?.title || null;
      }

      const attachment = { ...r.rows[0], title };

      return res.status(201).json({ ok: true, attachment });
    } catch (err) {
      logger.error("[classes] attach document failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

// DELETE /v1/classes/:classId/documents/:attachmentId — detach a document
router.delete(
  "/v1/classes/:classId/documents/:attachmentId",
  requireSession,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { classId, attachmentId } = req.params;

      const r = await withTimeout(
        pool.query(
          `DELETE FROM class_documents cd
            USING classes c
            WHERE cd.id = $1::uuid
              AND cd.class_id = $2::uuid
              AND c.class_id = cd.class_id
              AND c.teacher_id = $3::uuid`,
          [attachmentId, classId, userId]
        ),
        8000,
        "db-detach-class-document"
      );

      if (r.rowCount === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      return res.json({ ok: true });
    } catch (err) {
      logger.error("[classes] detach document failed", {
        err: String(err?.message || err),
      });
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

module.exports = router;
