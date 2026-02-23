// FILE: hakmun-api/routes/classes.js
// PURPOSE: CRUD for classes — containers that group documents, lists, and students.

const express = require("express");
const crypto = require("crypto");
const { requireSession, requireRole } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

// ===========================================================================
// JOIN BY CODE (must be before /:classId routes)
// ===========================================================================

// POST /v1/classes/join — student joins a class by enrollment code
router.post("/v1/classes/join", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ ok: false, error: "CODE_REQUIRED" });
    }

    // Find class with valid (non-expired) code
    const classR = await withTimeout(
      pool.query(
        `SELECT class_id, teacher_id, name, description, is_active,
                enrollment_code, enrollment_code_expires_at,
                created_at, updated_at
           FROM classes
          WHERE enrollment_code = $1
            AND enrollment_code_expires_at > NOW()`,
        [code]
      ),
      8000,
      "db-join-by-code-lookup"
    );

    if (classR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "INVALID_OR_EXPIRED_CODE" });
    }

    const cls = classR.rows[0];

    // Don't let teacher join their own class as member
    if (cls.teacher_id === userId) {
      return res.status(400).json({ ok: false, error: "OWNER_CANNOT_JOIN" });
    }

    // Insert as student
    const r = await withTimeout(
      pool.query(
        `INSERT INTO class_members (class_id, user_id, role)
         VALUES ($1::uuid, $2::uuid, 'student')
         ON CONFLICT (class_id, user_id) DO NOTHING
         RETURNING id, class_id, user_id, role, joined_at`,
        [cls.class_id, userId]
      ),
      8000,
      "db-join-by-code-insert"
    );

    if (r.rows.length === 0) {
      return res.json({ ok: true, class_info: cls, note: "ALREADY_MEMBER" });
    }

    return res.status(201).json({ ok: true, class_info: cls });
  } catch (err) {
    logger.error("[classes] join by code failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

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
                c.enrollment_code, c.enrollment_code_expires_at,
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
                      THEN (SELECT ds.title FROM saved_document_sources ds WHERE ds.saved_source_id = cd.document_id::uuid)
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

// POST /v1/classes/:classId/enrollment-code — generate enrollment code (owner only)
router.post("/v1/classes/:classId/enrollment-code", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;
    const durationHours = Math.min(Math.max(Number(req.body?.duration_hours) || 24, 1), 720); // 1h–30d

    // Generate unique code, retry on collision
    let code;
    let attempts = 0;
    while (attempts < 5) {
      code = generateCode();
      try {
        const r = await withTimeout(
          pool.query(
            `UPDATE classes
                SET enrollment_code = $3,
                    enrollment_code_expires_at = NOW() + INTERVAL '1 hour' * $4
              WHERE class_id = $1::uuid AND teacher_id = $2::uuid
             RETURNING class_id, teacher_id, name, description, is_active,
                       enrollment_code, enrollment_code_expires_at,
                       created_at, updated_at`,
            [classId, userId, code, durationHours]
          ),
          8000,
          "db-generate-enrollment-code"
        );

        if (r.rows.length === 0) {
          return res.status(404).json({ ok: false, error: "NOT_FOUND" });
        }

        return res.json({ ok: true, class_info: r.rows[0] });
      } catch (e) {
        if (e.code === "23505" && e.constraint === "idx_classes_enrollment_code") {
          attempts++;
          continue; // collision, retry
        }
        throw e;
      }
    }

    return res.status(500).json({ ok: false, error: "CODE_GENERATION_FAILED" });
  } catch (err) {
    logger.error("[classes] generate enrollment code failed", {
      err: String(err?.message || err),
    });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/classes/:classId/enrollment-code — close enrollment (owner only)
router.delete("/v1/classes/:classId/enrollment-code", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { classId } = req.params;

    const r = await withTimeout(
      pool.query(
        `UPDATE classes
            SET enrollment_code = NULL,
                enrollment_code_expires_at = NULL
          WHERE class_id = $1::uuid AND teacher_id = $2::uuid
         RETURNING class_id, teacher_id, name, description, is_active,
                   enrollment_code, enrollment_code_expires_at,
                   created_at, updated_at`,
        [classId, userId]
      ),
      8000,
      "db-close-enrollment"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true, class_info: r.rows[0] });
  } catch (err) {
    logger.error("[classes] close enrollment failed", {
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

// GET /v1/classes/:classId/lists/:listId/items — view list items (any class member)
router.get(
  "/v1/classes/:classId/lists/:listId/items",
  requireSession,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId)
        return res.status(401).json({ ok: false, error: "NO_SESSION" });

      const { classId, listId } = req.params;

      // Verify user is teacher or member
      const memberCheck = await withTimeout(
        pool.query(
          `SELECT 1 FROM classes WHERE class_id = $1::uuid AND teacher_id = $2::uuid
           UNION ALL
           SELECT 1 FROM class_members WHERE class_id = $1::uuid AND user_id = $2::uuid
           LIMIT 1`,
          [classId, userId]
        ),
        8000,
        "db-class-member-check"
      );

      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ ok: false, error: "NOT_MEMBER" });
      }

      // Verify list is attached to this class
      const attachCheck = await withTimeout(
        pool.query(
          `SELECT 1 FROM class_lists WHERE class_id = $1::uuid AND list_id = $2::uuid`,
          [classId, listId]
        ),
        8000,
        "db-class-list-attach-check"
      );

      if (attachCheck.rows.length === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // Fetch list metadata
      const listR = await withTimeout(
        pool.query(
          `SELECT id, name, description, global_weight, is_active, created_at, updated_at
             FROM lists WHERE id = $1::uuid`,
          [listId]
        ),
        8000,
        "db-class-list-meta"
      );

      if (listR.rows.length === 0) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND" });
      }

      // Fetch items with enriched content (same JOIN as GET /v1/lists/:id)
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
             ON lri.content_id = ci.content_item_id
            AND lri.content_type = ci.content_type
            AND lri.owner_user_id = $2::uuid
           WHERE li.list_id = $1::uuid
           ORDER BY li.position ASC, li.added_at ASC`,
          [listId, userId]
        ),
        8000,
        "db-class-list-items"
      );

      return res.json({
        ok: true,
        list: listR.rows[0],
        items: itemsR.rows || [],
      });
    } catch (err) {
      logger.error("[classes] list items failed", {
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
          `SELECT title FROM saved_document_sources WHERE saved_source_id = $1::uuid`,
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
