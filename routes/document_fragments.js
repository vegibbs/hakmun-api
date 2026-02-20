// FILE: hakmun-api/routes/document_fragments.js
// PURPOSE: CRUD for document fragments — blobs of teaching material tied to a document.
// Fragments are document-scoped and never appear in the content items pool.

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
// GET /v1/documents/:documentId/fragments — list fragments for a document
// ---------------------------------------------------------------------------
router.get("/v1/documents/:documentId/fragments", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const documentId = req.params.documentId;
    const sessionDate = req.query.session_date || null;

    let sql = `
      SELECT df.fragment_id, df.document_id, df.session_date,
             df.text, df.label, df.created_at, df.updated_at
        FROM document_fragments df
        JOIN documents d ON d.document_id = df.document_id
       WHERE df.document_id = $1::uuid
         AND d.owner_user_id = $2::uuid`;
    const params = [documentId, userId];

    if (sessionDate) {
      sql += ` AND df.session_date = $3::date`;
      params.push(sessionDate);
    }

    sql += ` ORDER BY df.session_date DESC NULLS LAST, df.created_at ASC`;

    const r = await withTimeout(pool.query(sql, params), 8000, "db-list-fragments");

    return res.json({ ok: true, fragments: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[fragments] list failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/documents/:documentId/fragments — create fragment(s)
// ---------------------------------------------------------------------------
router.post("/v1/documents/:documentId/fragments", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const documentId = req.params.documentId;

    // Verify document ownership
    const docR = await withTimeout(
      pool.query(
        `SELECT document_id FROM documents WHERE document_id = $1::uuid AND owner_user_id = $2::uuid`,
        [documentId, userId]
      ),
      8000,
      "db-check-doc-owner"
    );
    if (docR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "DOCUMENT_NOT_FOUND" });
    }

    // Accept single fragment or array
    let items = Array.isArray(req.body?.fragments) ? req.body.fragments : [];
    if (items.length === 0 && typeof req.body?.text === "string") {
      items = [{ text: req.body.text, label: req.body.label, session_date: req.body.session_date }];
    }
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_FRAGMENTS" });
    }

    const created = [];
    for (const item of items) {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!text) continue;

      const label = typeof item.label === "string" ? item.label.trim() || null : null;
      const sessionDate = typeof item.session_date === "string" ? item.session_date.trim() || null : null;

      try {
        const r = await pool.query(
          `INSERT INTO document_fragments (document_id, owner_user_id, session_date, text, label)
           VALUES ($1::uuid, $2::uuid, $3::date, $4, $5)
           RETURNING fragment_id, document_id, session_date, text, label, created_at, updated_at`,
          [documentId, userId, sessionDate, text, label]
        );
        if (r.rows.length > 0) created.push(r.rows[0]);
      } catch (insertErr) {
        logger.warn("[fragments] insert skipped", { err: String(insertErr?.message || insertErr) });
      }
    }

    return res.status(201).json({ ok: true, fragments: created, created_count: created.length });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[fragments] create failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// PUT /v1/documents/:documentId/fragments/:fragmentId — update a fragment
// ---------------------------------------------------------------------------
router.put("/v1/documents/:documentId/fragments/:fragmentId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { documentId, fragmentId } = req.params;
    const body = req.body || {};

    const sets = [];
    const params = [fragmentId, userId];
    let idx = 3;

    if (typeof body.text === "string" && body.text.trim()) {
      sets.push(`text = $${idx++}`);
      params.push(body.text.trim());
    }
    if (body.label !== undefined) {
      const label = typeof body.label === "string" ? body.label.trim() || null : null;
      sets.push(`label = $${idx++}`);
      params.push(label);
    }
    if (body.session_date !== undefined) {
      const sd = typeof body.session_date === "string" ? body.session_date.trim() || null : null;
      sets.push(`session_date = $${idx++}::date`);
      params.push(sd);
    }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_FIELDS" });
    }

    sets.push(`updated_at = NOW()`);

    const r = await withTimeout(
      pool.query(
        `UPDATE document_fragments
            SET ${sets.join(", ")}
          WHERE fragment_id = $1::uuid AND owner_user_id = $2::uuid
         RETURNING fragment_id, document_id, session_date, text, label, created_at, updated_at`,
        params
      ),
      8000,
      "db-update-fragment"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true, fragment: r.rows[0] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[fragments] update failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/documents/:documentId/fragments/:fragmentId — delete a fragment
// ---------------------------------------------------------------------------
router.delete("/v1/documents/:documentId/fragments/:fragmentId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { documentId, fragmentId } = req.params;

    const r = await withTimeout(
      pool.query(
        `DELETE FROM document_fragments
          WHERE fragment_id = $1::uuid
            AND document_id = $2::uuid
            AND owner_user_id = $3::uuid`,
        [fragmentId, documentId, userId]
      ),
      8000,
      "db-delete-fragment"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    return res.json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[fragments] delete failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/documents/:documentId/fragments — bulk delete fragments
// ---------------------------------------------------------------------------
router.delete("/v1/documents/:documentId/fragments", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const documentId = req.params.documentId;
    const fragmentIds = Array.isArray(req.body?.fragment_ids) ? req.body.fragment_ids : [];
    if (fragmentIds.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_FRAGMENT_IDS" });
    }

    const r = await withTimeout(
      pool.query(
        `DELETE FROM document_fragments
          WHERE fragment_id = ANY($1::uuid[])
            AND document_id = $2::uuid
            AND owner_user_id = $3::uuid`,
        [fragmentIds, documentId, userId]
      ),
      8000,
      "db-bulk-delete-fragments"
    );

    return res.json({ ok: true, deleted_count: r.rowCount });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[fragments] bulk delete failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;
