// routes/media.js — General-purpose media upload endpoint
// Used by bug reports and collaboration messages.

const express = require("express");
const crypto = require("crypto");
const multer = require("multer");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");
const {
  storageConfigured,
  makeS3Client,
  bucketName,
  signImageUrl,
  PutObjectCommand,
} = require("../util/s3");

const router = express.Router();

/* ------------------------------------------------------------------
   Config
------------------------------------------------------------------ */

const ACCEPTED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/heic",
  "video/mp4",
  "video/quicktime", // .MOV
]);

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB

// Use the larger limit for multer; we validate per-type below
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
});

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function requireStorageOr503(res) {
  if (!storageConfigured()) {
    return res.status(503).json({ ok: false, error: "STORAGE_NOT_CONFIGURED" });
  }
  return null;
}

function isVideoType(ct) {
  return ct === "video/mp4" || ct === "video/quicktime";
}

function normalizeContentType(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (m === "image/jpg") return "image/jpeg";
  if (m === "image/heif") return "image/heic";
  if (ACCEPTED_TYPES.has(m)) return m;
  return null;
}

function extForType(ct) {
  switch (ct) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/heic": return "heic";
    case "video/mp4": return "mp4";
    case "video/quicktime": return "mov";
    default: return "bin";
  }
}

/* ------------------------------------------------------------------
   POST /v1/media
------------------------------------------------------------------ */

router.post("/v1/media", requireSession, upload.single("file"), async (req, res) => {
  const bail = requireStorageOr503(res);
  if (bail) return;

  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "FILE_REQUIRED" });
    }

    const context = String(req.body?.context || "").trim();
    if (!context || !["bug_report", "message"].includes(context)) {
      return res.status(400).json({ ok: false, error: "INVALID_CONTEXT" });
    }

    // Validate content type
    const contentType = normalizeContentType(req.file.mimetype);
    if (!contentType) {
      return res.status(400).json({ ok: false, error: "UNSUPPORTED_TYPE" });
    }

    // Validate size by type
    const sizeBytes = req.file.size;
    if (isVideoType(contentType) && sizeBytes > MAX_VIDEO_BYTES) {
      return res.status(400).json({ ok: false, error: "FILE_TOO_LARGE" });
    }
    if (!isVideoType(contentType) && sizeBytes > MAX_IMAGE_BYTES) {
      return res.status(400).json({ ok: false, error: "FILE_TOO_LARGE" });
    }

    // Build S3 key: media/{context}/{userId}/{uuid}.{ext}
    const fileId = crypto.randomUUID();
    const ext = extForType(contentType);
    const prefix = context === "bug_report" ? "media/bug_reports" : "media/messages";
    const objectKey = `${prefix}/${userId}/${fileId}.${ext}`;

    // Upload to S3
    const s3 = makeS3Client();
    await withTimeout(
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: req.file.buffer,
          ContentType: contentType,
          CacheControl: "no-store",
        })
      ),
      15000,
      "s3-put-media"
    );

    // Insert into media table
    const r = await withTimeout(
      pool.query(
        `INSERT INTO media (owner_user_id, context, object_key, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [userId, context, objectKey, contentType, sizeBytes]
      ),
      8000,
      "db-insert-media"
    );

    const row = r.rows[0];

    // Generate signed read URL
    const url = await signImageUrl(objectKey, 900);

    logger.info("[media-upload] ok", {
      rid: req._rid,
      userId,
      mediaId: row.id,
      context,
      contentType,
      sizeBytes,
    });

    return res.status(201).json({
      ok: true,
      media_id: row.id,
      url,
      content_type: contentType,
      size_bytes: sizeBytes,
      created_at: row.created_at,
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[media-upload] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put-media")) {
      return res.status(503).json({ ok: false, error: "STORAGE_TIMEOUT" });
    }
    return res.status(500).json({ ok: false, error: "UPLOAD_FAILED" });
  }
});

module.exports = router;
