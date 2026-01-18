// routes/assets.js — HakMun API (v0.12)
// STORAGE EPIC 1 — Assets (multipart + validation + S3 + DB) + read surfaces

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const { PutObjectCommand, GetObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");

const router = express.Router();

/* ------------------------------------------------------------------
   Secure object storage (S3-compatible)
------------------------------------------------------------------ */
function storageConfigured() {
  return Boolean(
    process.env.OBJECT_STORAGE_ENDPOINT &&
      process.env.OBJECT_STORAGE_BUCKET &&
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

function requireStorageOr503(res) {
  if (!storageConfigured()) {
    return res.status(503).json({ error: "object storage not configured" });
  }
  return null;
}

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION || "auto",
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
    },
    forcePathStyle: true
  });
}

function bucketName() {
  return process.env.OBJECT_STORAGE_BUCKET;
}

/* ------------------------------------------------------------------
   STORAGE EPIC 1 — Assets (multipart + validation + S3 + DB)
------------------------------------------------------------------ */

// NOTE: This is separate from the profile-photo "upload" middleware.
// We keep asset limits independent and explicit.
const uploadAsset = multer({
  storage: multer.memoryStorage(),
  // Allow the largest permitted asset through multer, then enforce per-type below.
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max gate
});

// Canonical allowlist (initial, per Storage EPIC 1 scope)
const ASSET_ALLOWED_MIME = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "application/pdf"
]);

// Size limits per mime family (bytes)
const ASSET_MAX_BYTES = {
  audio: 25 * 1024 * 1024, // 25MB
  pdf: 10 * 1024 * 1024 // 10MB
};

function assetFamilyForMime(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  return "other";
}

function assetExtForMime(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (m === "audio/mpeg") return "mp3";
  if (m === "audio/wav" || m === "audio/x-wav") return "wav";
  if (m === "audio/m4a") return "m4a";
  if (m === "application/pdf") return "pdf";
  return "bin";
}

function cleanOptionalText(v, maxLen) {
  const s = v === undefined || v === null ? "" : String(v).trim();
  if (!s) return null;
  if (typeof maxLen === "number" && maxLen > 0) return s.slice(0, maxLen);
  return s;
}

function cleanOptionalInt(v, min, max) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (typeof min === "number" && i < min) return null;
  if (typeof max === "number" && i > max) return null;
  return i;
}

// POST /v1/assets
router.post("/v1/assets", requireSession, uploadAsset.single("file"), async (req, res) => {
  // Storage must be configured for any asset work.
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "file required" });
    }

    const mime = String(req.file.mimetype || "").toLowerCase().trim();
    const sizeBytes = Number(req.file.size || 0);

    if (!mime || !ASSET_ALLOWED_MIME.has(mime)) {
      return res.status(415).json({ error: "unsupported media type", mime_type: mime || null });
    }

    const fam = assetFamilyForMime(mime);
    const maxBytes = ASSET_MAX_BYTES[fam];

    if (!maxBytes) {
      return res.status(415).json({ error: "unsupported media family", mime_type: mime });
    }

    if (sizeBytes > maxBytes) {
      return res.status(413).json({
        error: "file too large",
        mime_type: mime,
        size_bytes: sizeBytes,
        max_bytes: maxBytes
      });
    }

    const ownerUserID = req.user.userID;

    // Optional stable metadata (module meaning stays in use tables)
    const title = cleanOptionalText(req.body?.title, 140);
    const language = cleanOptionalText(req.body?.language, 32);
    const durationMs = cleanOptionalInt(req.body?.duration_ms, 0, 24 * 60 * 60 * 1000); // cap 24h

    // Deterministic object identity: asset_id is created server-side
    const assetID = crypto.randomUUID();
    const ext = assetExtForMime(mime);

    // Canonical object key scheme (private bucket)
    // NOTE: No URLs persisted; key is the only pointer (S2)
    const objectKey = `users/${ownerUserID}/assets/${assetID}.${ext}`;

    logger.info("[/v1/assets][start]", {
      rid: req._rid,
      ownerUserID,
      assetID,
      mime_type: mime,
      size_bytes: sizeBytes
    });

    // Stage 1: S3 PUT (fail-fast)
    const s3 = makeS3Client();
    await withTimeout(
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: req.file.buffer,
          ContentType: mime,
          CacheControl: "no-store"
        })
      ),
      15000,
      "s3-put-asset"
    );

    // Stage 2: DB insert (object_key ONLY)
    const inserted = await withTimeout(
      pool.query(
        `
        insert into media_assets (
          asset_id,
          owner_user_id,
          object_key,
          mime_type,
          size_bytes,
          title,
          language,
          duration_ms
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        returning asset_id, created_at
        `,
        [assetID, ownerUserID, objectKey, mime, sizeBytes, title, language, durationMs]
      ),
      8000,
      "db-insert-asset"
    );

    const row = inserted.rows?.[0];

    logger.info("[/v1/assets][ok]", {
      rid: req._rid,
      ownerUserID,
      assetID,
      object_key: objectKey
    });

    return res.status(201).json({
      asset_id: row?.asset_id || assetID,
      created_at: row?.created_at || null,
      mime_type: mime,
      size_bytes: sizeBytes
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/assets] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put-asset")) {
      return res.status(503).json({ error: "object storage timeout" });
    }
    if (msg.startsWith("timeout:db-insert-asset")) {
      logger.error("timeout:db-insert-asset", { rid: req._rid });
      return res.status(503).json({ error: "db timeout inserting asset" });
    }

    return res.status(500).json({ error: "asset upload failed" });
  }
});

/* ------------------------------------------------------------------
   STORAGE EPIC 1 — Assets (read surface)
------------------------------------------------------------------ */

// GET /v1/assets — list owned assets (no URLs; object_key not returned)
router.get("/v1/assets", requireSession, async (req, res) => {
  try {
    const ownerUserID = req.user.userID;

    const r = await withTimeout(
      pool.query(
        `
        select
          asset_id,
          mime_type,
          size_bytes,
          title,
          language,
          duration_ms,
          created_at,
          updated_at
        from media_assets
        where owner_user_id = $1
        order by created_at desc
        limit 200
        `,
        [ownerUserID]
      ),
      8000,
      "db-list-assets"
    );

    return res.json({ assets: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/assets][list] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-assets")) {
      logger.error("timeout:db-list-assets", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing assets" });
    }

    return res.status(500).json({ error: "list assets failed" });
  }
});

// GET /v1/assets/:asset_id/url — signed read URL (requires storage configured)
router.get("/v1/assets/:asset_id/url", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const ownerUserID = req.user.userID;
    const assetID = String(req.params.asset_id || "").trim();

    function looksLikeUUID(v) {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String(v || "")
      );
    }

    if (!looksLikeUUID(assetID)) {
      return res.status(400).json({ error: "invalid asset_id" });
    }

    const r = await withTimeout(
      pool.query(
        `
        select object_key, mime_type, size_bytes
        from media_assets
        where asset_id = $1 and owner_user_id = $2
        limit 1
        `,
        [assetID, ownerUserID]
      ),
      8000,
      "db-get-asset-key"
    );

    const row = r.rows?.[0];
    if (!row?.object_key) {
      return res.status(404).json({ error: "asset not found" });
    }

    const s3 = makeS3Client();
    const url = await withTimeout(
      getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucketName(), Key: row.object_key }),
        { expiresIn: 60 * 15 }
      ),
      8000,
      "sign-asset-url"
    );

    return res.json({
      url,
      expiresIn: 900,
      mime_type: row.mime_type || null,
      size_bytes: Number(row.size_bytes || 0)
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/assets][url] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-get-asset-key")) {
      logger.error("timeout:db-get-asset-key", { rid: req._rid });
      return res.status(503).json({ error: "db timeout resolving asset" });
    }
    if (msg.startsWith("timeout:sign-asset-url")) {
      return res.status(503).json({ error: "timeout signing url" });
    }

    return res.status(500).json({ error: "failed to sign url" });
  }
});

module.exports = router;