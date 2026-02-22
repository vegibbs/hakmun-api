// FILE: hakmun-api/routes/hakdoc.js
// PURPOSE: CRUD for HakDoc — native document editor for language teaching.
// Three entities: hakdocs → hakdoc_sessions → hakdoc_blocks.

const express = require("express");
const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

// ===========================================================================
// HAKDOCS
// ===========================================================================

// POST /v1/hakdocs — create a new hakdoc
router.post("/v1/hakdocs", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const title = (req.body?.title || "Untitled").trim();
    const studentId = req.body?.student_id || null;
    const classCode = req.body?.class_code || null;

    const r = await withTimeout(
      pool.query(
        `INSERT INTO hakdocs (teacher_id, title, student_id, class_code)
         VALUES ($1::uuid, $2, $3, $4)
         RETURNING hakdoc_id, teacher_id, title, student_id, class_code, created_at, updated_at`,
        [userId, title, studentId, classCode]
      ),
      8000,
      "db-create-hakdoc"
    );

    return res.status(201).json({ ok: true, hakdoc: r.rows[0] });
  } catch (err) {
    logger.error("[hakdoc] create failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /v1/hakdocs — list teacher's hakdocs (summary)
router.get("/v1/hakdocs", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(
        `SELECT h.hakdoc_id, h.title, h.student_id, h.class_code,
                h.created_at, h.updated_at,
                COUNT(s.session_id)::int AS session_count
           FROM hakdocs h
           LEFT JOIN hakdoc_sessions s ON s.hakdoc_id = h.hakdoc_id
          WHERE h.teacher_id = $1::uuid
          GROUP BY h.hakdoc_id
          ORDER BY h.updated_at DESC`,
        [userId]
      ),
      8000,
      "db-list-hakdocs"
    );

    return res.json({ ok: true, hakdocs: r.rows });
  } catch (err) {
    logger.error("[hakdoc] list failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /v1/hakdocs/:hakdocId — full hakdoc with nested sessions + blocks
router.get("/v1/hakdocs/:hakdocId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId } = req.params;

    // Fetch hakdoc
    const docR = await withTimeout(
      pool.query(
        `SELECT hakdoc_id, teacher_id, title, student_id, class_code, created_at, updated_at
           FROM hakdocs
          WHERE hakdoc_id = $1::uuid AND teacher_id = $2::uuid`,
        [hakdocId, userId]
      ),
      8000,
      "db-get-hakdoc"
    );
    if (docR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    const hakdoc = docR.rows[0];

    // Fetch sessions
    const sessR = await withTimeout(
      pool.query(
        `SELECT session_id, hakdoc_id, session_date, session_number, topic, created_at, updated_at
           FROM hakdoc_sessions
          WHERE hakdoc_id = $1::uuid
          ORDER BY session_date DESC, session_number DESC`,
        [hakdocId]
      ),
      8000,
      "db-get-hakdoc-sessions"
    );

    // Fetch all blocks for this hakdoc's sessions in one query
    const sessionIds = sessR.rows.map((s) => s.session_id);
    let blocksBySession = {};
    if (sessionIds.length > 0) {
      const blockR = await withTimeout(
        pool.query(
          `SELECT block_id, session_id, block_type, sort_order, content,
                  importance, audio_url, audio_status, created_at, updated_at
             FROM hakdoc_blocks
            WHERE session_id = ANY($1::uuid[])
            ORDER BY sort_order ASC, created_at ASC`,
          [sessionIds]
        ),
        8000,
        "db-get-hakdoc-blocks"
      );
      for (const block of blockR.rows) {
        if (!blocksBySession[block.session_id]) blocksBySession[block.session_id] = [];
        blocksBySession[block.session_id].push(block);
      }
    }

    // Assemble nested response
    hakdoc.sessions = sessR.rows.map((s) => ({
      ...s,
      blocks: blocksBySession[s.session_id] || [],
    }));

    return res.json({ ok: true, hakdoc });
  } catch (err) {
    logger.error("[hakdoc] get failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// PUT /v1/hakdocs/:hakdocId — update hakdoc metadata
router.put("/v1/hakdocs/:hakdocId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId } = req.params;
    const body = req.body || {};

    const sets = [];
    const params = [hakdocId, userId];
    let idx = 3;

    if (typeof body.title === "string" && body.title.trim()) {
      sets.push(`title = $${idx++}`);
      params.push(body.title.trim());
    }
    if (body.student_id !== undefined) {
      sets.push(`student_id = $${idx++}::uuid`);
      params.push(body.student_id || null);
    }
    if (body.class_code !== undefined) {
      sets.push(`class_code = $${idx++}`);
      params.push(body.class_code || null);
    }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_FIELDS" });
    }
    sets.push(`updated_at = NOW()`);

    const r = await withTimeout(
      pool.query(
        `UPDATE hakdocs
            SET ${sets.join(", ")}
          WHERE hakdoc_id = $1::uuid AND teacher_id = $2::uuid
         RETURNING hakdoc_id, teacher_id, title, student_id, class_code, created_at, updated_at`,
        params
      ),
      8000,
      "db-update-hakdoc"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true, hakdoc: r.rows[0] });
  } catch (err) {
    logger.error("[hakdoc] update failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/hakdocs/:hakdocId — delete hakdoc (cascades sessions + blocks)
router.delete("/v1/hakdocs/:hakdocId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId } = req.params;

    const r = await withTimeout(
      pool.query(
        `DELETE FROM hakdocs WHERE hakdoc_id = $1::uuid AND teacher_id = $2::uuid`,
        [hakdocId, userId]
      ),
      8000,
      "db-delete-hakdoc"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[hakdoc] delete failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ===========================================================================
// SESSIONS
// ===========================================================================

// POST /v1/hakdocs/:hakdocId/sessions — create a session
router.post("/v1/hakdocs/:hakdocId/sessions", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId } = req.params;

    // Verify ownership
    const docR = await withTimeout(
      pool.query(
        `SELECT hakdoc_id FROM hakdocs WHERE hakdoc_id = $1::uuid AND teacher_id = $2::uuid`,
        [hakdocId, userId]
      ),
      8000,
      "db-check-hakdoc-owner"
    );
    if (docR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "HAKDOC_NOT_FOUND" });
    }

    const sessionDate = req.body?.session_date || new Date().toISOString().slice(0, 10);
    const topic = req.body?.topic || null;

    // Auto-increment session_number
    const numR = await pool.query(
      `SELECT COALESCE(MAX(session_number), 0) + 1 AS next_num
         FROM hakdoc_sessions WHERE hakdoc_id = $1::uuid`,
      [hakdocId]
    );
    const sessionNumber = numR.rows[0].next_num;

    const r = await withTimeout(
      pool.query(
        `INSERT INTO hakdoc_sessions (hakdoc_id, session_date, session_number, topic)
         VALUES ($1::uuid, $2::date, $3, $4)
         RETURNING session_id, hakdoc_id, session_date, session_number, topic, created_at, updated_at`,
        [hakdocId, sessionDate, sessionNumber, topic]
      ),
      8000,
      "db-create-session"
    );

    // Touch hakdoc updated_at
    await pool.query(
      `UPDATE hakdocs SET updated_at = NOW() WHERE hakdoc_id = $1::uuid`,
      [hakdocId]
    );

    return res.status(201).json({ ok: true, session: r.rows[0] });
  } catch (err) {
    const msg = String(err?.message || err);
    // Handle duplicate date
    if (msg.includes("idx_hakdoc_sessions_doc_date")) {
      return res.status(409).json({ ok: false, error: "SESSION_DATE_EXISTS" });
    }
    logger.error("[hakdoc] create session failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// PUT /v1/hakdocs/:hakdocId/sessions/:sessionId — update a session
router.put("/v1/hakdocs/:hakdocId/sessions/:sessionId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId, sessionId } = req.params;
    const body = req.body || {};

    const sets = [];
    const params = [sessionId, hakdocId, userId];
    let idx = 4;

    if (body.topic !== undefined) {
      sets.push(`topic = $${idx++}`);
      params.push(body.topic || null);
    }
    if (body.session_date) {
      sets.push(`session_date = $${idx++}::date`);
      params.push(body.session_date);
    }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_FIELDS" });
    }
    sets.push(`updated_at = NOW()`);

    const r = await withTimeout(
      pool.query(
        `UPDATE hakdoc_sessions
            SET ${sets.join(", ")}
          WHERE session_id = $1::uuid
            AND hakdoc_id = $2::uuid
            AND hakdoc_id IN (SELECT hakdoc_id FROM hakdocs WHERE teacher_id = $3::uuid)
         RETURNING session_id, hakdoc_id, session_date, session_number, topic, created_at, updated_at`,
        params
      ),
      8000,
      "db-update-session"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true, session: r.rows[0] });
  } catch (err) {
    logger.error("[hakdoc] update session failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/hakdocs/:hakdocId/sessions/:sessionId — delete a session
router.delete("/v1/hakdocs/:hakdocId/sessions/:sessionId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId, sessionId } = req.params;

    const r = await withTimeout(
      pool.query(
        `DELETE FROM hakdoc_sessions
          WHERE session_id = $1::uuid
            AND hakdoc_id = $2::uuid
            AND hakdoc_id IN (SELECT hakdoc_id FROM hakdocs WHERE teacher_id = $3::uuid)`,
        [sessionId, hakdocId, userId]
      ),
      8000,
      "db-delete-session"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[hakdoc] delete session failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ===========================================================================
// BLOCKS
// ===========================================================================

// POST /v1/hakdocs/:hakdocId/sessions/:sessionId/blocks — create a block
router.post("/v1/hakdocs/:hakdocId/sessions/:sessionId/blocks", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId, sessionId } = req.params;

    // Verify ownership chain
    const ownerR = await withTimeout(
      pool.query(
        `SELECT s.session_id
           FROM hakdoc_sessions s
           JOIN hakdocs h ON h.hakdoc_id = s.hakdoc_id
          WHERE s.session_id = $1::uuid
            AND s.hakdoc_id = $2::uuid
            AND h.teacher_id = $3::uuid`,
        [sessionId, hakdocId, userId]
      ),
      8000,
      "db-check-session-owner"
    );
    if (ownerR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });
    }

    const blockType = req.body?.block_type || "teacher_note";
    const content = req.body?.content || {};
    const importance = req.body?.importance || 0;

    // Auto-increment sort_order
    const orderR = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM hakdoc_blocks WHERE session_id = $1::uuid`,
      [sessionId]
    );
    const sortOrder = orderR.rows[0].next_order;

    const r = await withTimeout(
      pool.query(
        `INSERT INTO hakdoc_blocks (session_id, block_type, sort_order, content, importance)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
         RETURNING block_id, session_id, block_type, sort_order, content,
                   importance, audio_url, audio_status, created_at, updated_at`,
        [sessionId, blockType, sortOrder, JSON.stringify(content), importance]
      ),
      8000,
      "db-create-block"
    );

    // Touch hakdoc updated_at
    await pool.query(
      `UPDATE hakdocs SET updated_at = NOW() WHERE hakdoc_id = $1::uuid`,
      [hakdocId]
    );

    return res.status(201).json({ ok: true, block: r.rows[0] });
  } catch (err) {
    logger.error("[hakdoc] create block failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// PUT /v1/hakdocs/:hakdocId/sessions/:sessionId/blocks/:blockId — update a block
router.put("/v1/hakdocs/:hakdocId/sessions/:sessionId/blocks/:blockId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId, sessionId, blockId } = req.params;
    const body = req.body || {};

    const sets = [];
    const params = [blockId, sessionId];
    let idx = 3;

    if (body.content !== undefined) {
      sets.push(`content = $${idx++}::jsonb`);
      params.push(JSON.stringify(body.content));
    }
    if (body.block_type !== undefined) {
      sets.push(`block_type = $${idx++}`);
      params.push(body.block_type);
    }
    if (body.importance !== undefined) {
      sets.push(`importance = $${idx++}`);
      params.push(body.importance);
    }
    if (body.sort_order !== undefined) {
      sets.push(`sort_order = $${idx++}`);
      params.push(body.sort_order);
    }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_FIELDS" });
    }
    sets.push(`updated_at = NOW()`);

    // Verify ownership via join — userId is parameterized
    params.push(userId);
    const userIdx = idx;
    const r = await withTimeout(
      pool.query(
        `UPDATE hakdoc_blocks b
            SET ${sets.join(", ")}
           FROM hakdoc_sessions s
           JOIN hakdocs h ON h.hakdoc_id = s.hakdoc_id
          WHERE b.block_id = $1::uuid
            AND b.session_id = $2::uuid
            AND s.session_id = b.session_id
            AND h.teacher_id = $${userIdx}::uuid
         RETURNING b.block_id, b.session_id, b.block_type, b.sort_order, b.content,
                   b.importance, b.audio_url, b.audio_status, b.created_at, b.updated_at`,
        params
      ),
      8000,
      "db-update-block"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    // Touch hakdoc updated_at
    await pool.query(
      `UPDATE hakdocs SET updated_at = NOW() WHERE hakdoc_id = $1::uuid`,
      [hakdocId]
    );

    return res.json({ ok: true, block: r.rows[0] });
  } catch (err) {
    logger.error("[hakdoc] update block failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// DELETE /v1/hakdocs/:hakdocId/sessions/:sessionId/blocks/:blockId — delete a block
router.delete("/v1/hakdocs/:hakdocId/sessions/:sessionId/blocks/:blockId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId, sessionId, blockId } = req.params;

    // Verify ownership via subquery
    const r = await withTimeout(
      pool.query(
        `DELETE FROM hakdoc_blocks
          WHERE block_id = $1::uuid
            AND session_id = $2::uuid
            AND session_id IN (
              SELECT s.session_id FROM hakdoc_sessions s
              JOIN hakdocs h ON h.hakdoc_id = s.hakdoc_id
              WHERE h.teacher_id = $3::uuid
            )`,
        [blockId, sessionId, userId]
      ),
      8000,
      "db-delete-block"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[hakdoc] delete block failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// PATCH /v1/hakdocs/:hakdocId/sessions/:sessionId/blocks/reorder — reorder blocks
router.patch("/v1/hakdocs/:hakdocId/sessions/:sessionId/blocks/reorder", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { hakdocId, sessionId } = req.params;
    const blockIds = Array.isArray(req.body?.block_ids) ? req.body.block_ids : [];
    if (blockIds.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_BLOCK_IDS" });
    }

    // Verify ownership
    const ownerR = await withTimeout(
      pool.query(
        `SELECT s.session_id
           FROM hakdoc_sessions s
           JOIN hakdocs h ON h.hakdoc_id = s.hakdoc_id
          WHERE s.session_id = $1::uuid
            AND s.hakdoc_id = $2::uuid
            AND h.teacher_id = $3::uuid`,
        [sessionId, hakdocId, userId]
      ),
      8000,
      "db-check-reorder-owner"
    );
    if (ownerR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });
    }

    // Update sort_order for each block
    for (let i = 0; i < blockIds.length; i++) {
      await pool.query(
        `UPDATE hakdoc_blocks SET sort_order = $1, updated_at = NOW()
          WHERE block_id = $2::uuid AND session_id = $3::uuid`,
        [i, blockIds[i], sessionId]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[hakdoc] reorder blocks failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
