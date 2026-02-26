// routes/vocab_images.js — Vocab image review endpoints

const express = require("express");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");

const router = express.Router();
const QUERY_TIMEOUT_MS = 8000;

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION || "auto",
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

function bucketName() {
  return process.env.OBJECT_STORAGE_BUCKET;
}

/* ------------------------------------------------------------------
   GET /v1/vocab-images/batches
   Lists all batches with status counts.
------------------------------------------------------------------ */
router.get("/v1/vocab-images/batches", requireSession, async (req, res) => {
  try {
    const r = await withTimeout(
      pool.query(`
        SELECT batch_number,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          MIN(created_at) AS created_at
        FROM vocab_image_assets
        GROUP BY batch_number
        ORDER BY batch_number
      `),
      QUERY_TIMEOUT_MS,
      "db-vocab-image-batches"
    );

    return res.json({ batches: r.rows });
  } catch (err) {
    logger.error("[vocab-images] batches failed", { err: String(err?.message || err) });
    return res.status(500).json({ error: "failed to list batches" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/vocab-images/batch/:batch_number
   Returns images in a batch with signed S3 URLs.
------------------------------------------------------------------ */
router.get("/v1/vocab-images/batch/:batch_number", requireSession, async (req, res) => {
  try {
    const batchNumber = parseInt(req.params.batch_number, 10);
    if (isNaN(batchNumber)) {
      return res.status(400).json({ error: "invalid batch_number" });
    }

    const r = await withTimeout(
      pool.query(
        `SELECT id, vocab_id, lemma, gloss_en, pos_ko, cefr_level, subject, status, s3_key
         FROM vocab_image_assets
         WHERE batch_number = $1
         ORDER BY lemma`,
        [batchNumber]
      ),
      QUERY_TIMEOUT_MS,
      "db-vocab-image-batch"
    );

    if (r.rows.length === 0) {
      return res.json({ images: [] });
    }

    // Sign URLs for all images in the batch
    const s3 = makeS3Client();
    const bucket = bucketName();
    const images = await Promise.all(
      r.rows.map(async (row) => {
        let image_url = null;
        try {
          image_url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: bucket, Key: row.s3_key }),
            { expiresIn: 60 * 15 }
          );
        } catch (signErr) {
          logger.error("[vocab-images] sign failed", { key: row.s3_key, err: String(signErr?.message) });
        }
        return {
          id: row.id,
          vocab_id: row.vocab_id,
          lemma: row.lemma,
          gloss_en: row.gloss_en,
          pos_ko: row.pos_ko,
          cefr_level: row.cefr_level,
          subject: row.subject,
          status: row.status,
          image_url,
        };
      })
    );

    return res.json({ images });
  } catch (err) {
    logger.error("[vocab-images] batch failed", { err: String(err?.message || err) });
    return res.status(500).json({ error: "failed to list batch images" });
  }
});

/* ------------------------------------------------------------------
   PATCH /v1/vocab-images/:id/status
   Update image status (approve / reject).
------------------------------------------------------------------ */
router.patch("/v1/vocab-images/:id/status", requireSession, async (req, res) => {
  try {
    const imageId = String(req.params.id || "").trim();
    const { status } = req.body || {};

    if (!["approved", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ error: "status must be approved, rejected, or pending" });
    }

    const r = await withTimeout(
      pool.query(
        `UPDATE vocab_image_assets
         SET status = $1, reviewed_at = CASE WHEN $1 = 'pending' THEN NULL ELSE NOW() END
         WHERE id = $2
         RETURNING id, status`,
        [status, imageId]
      ),
      QUERY_TIMEOUT_MS,
      "db-vocab-image-status"
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ error: "image not found" });
    }

    return res.json(r.rows[0]);
  } catch (err) {
    logger.error("[vocab-images] status update failed", { err: String(err?.message || err) });
    return res.status(500).json({ error: "failed to update status" });
  }
});

/* ------------------------------------------------------------------
   PATCH /v1/vocab-images/batch/:batch_number/status
   Bulk update status for all images in a batch.
------------------------------------------------------------------ */
router.patch("/v1/vocab-images/batch/:batch_number/status", requireSession, async (req, res) => {
  try {
    const batchNumber = parseInt(req.params.batch_number, 10);
    if (isNaN(batchNumber)) {
      return res.status(400).json({ error: "invalid batch_number" });
    }

    const { status, only_pending } = req.body || {};
    if (!["approved", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ error: "status must be approved, rejected, or pending" });
    }

    const whereClause = only_pending
      ? `WHERE batch_number = $2 AND status = 'pending'`
      : `WHERE batch_number = $2`;

    const r = await withTimeout(
      pool.query(
        `UPDATE vocab_image_assets
         SET status = $1, reviewed_at = CASE WHEN $1 = 'pending' THEN NULL ELSE NOW() END
         ${whereClause}`,
        [status, batchNumber]
      ),
      QUERY_TIMEOUT_MS,
      "db-vocab-image-batch-status"
    );

    return res.json({ updated: r.rowCount });
  } catch (err) {
    logger.error("[vocab-images] batch status update failed", { err: String(err?.message || err) });
    return res.status(500).json({ error: "failed to update batch status" });
  }
});

module.exports = router;
