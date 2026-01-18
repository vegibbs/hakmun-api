// routes/profile_photo.js — HakMun API (v0.12)
// Canonical profile photo metadata (users table) + upload/delete/signed-url

const express = require("express");
const multer = require("multer");

const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");

const router = express.Router();

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */
function safeMimeType(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (!m) return "image/jpeg";
  if (m === "image/jpeg" || m === "image/jpg") return "image/jpeg";
  if (m === "image/png") return "image/png";
  if (m === "image/webp") return "image/webp";
  if (m === "image/heic" || m === "image/heif") return "image/heic";
  return "image/jpeg";
}

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
   Multer (profile-photo upload)
------------------------------------------------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

/* ------------------------------------------------------------------
   Canonical profile photo metadata (users table)
------------------------------------------------------------------ */
async function getCanonicalProfilePhotoKey(userID) {
  const { rows } = await pool.query(
    `
    select profile_photo_object_key as key
    from users
    where user_id = $1
    limit 1
    `,
    [userID]
  );
  return rows?.[0]?.key || null;
}

async function setCanonicalProfilePhotoKey(userID, objectKey) {
  const r = await pool.query(
    `
    update users
    set profile_photo_object_key = $2,
        profile_photo_updated_at = now()
    where user_id = $1
    returning profile_photo_object_key, profile_photo_updated_at
    `,
    [userID, objectKey]
  );

  // Debug-only row dump (incident tooling)
  logger.debug("photo_key", "[photo-key][set]", {
    userID,
    key: objectKey,
    row: r.rows?.[0] || null,
    rowCount: Number(r.rowCount ?? 0)
  });

  if (!r.rowCount) {
    throw new Error("profile photo DB update affected 0 rows");
  }
}

async function clearCanonicalProfilePhotoKey(userID) {
  const r = await pool.query(
    `
    update users
    set profile_photo_object_key = null,
        profile_photo_updated_at = now()
    where user_id = $1
    returning profile_photo_object_key, profile_photo_updated_at
    `,
    [userID]
  );

  // Debug-only row dump (incident tooling)
  logger.debug("photo_key", "[photo-key][clear]", {
    userID,
    row: r.rows?.[0] || null,
    rowCount: Number(r.rowCount ?? 0)
  });

  if (!r.rowCount) {
    throw new Error("profile photo DB clear affected 0 rows");
  }
}

/* ------------------------------------------------------------------
   PUT /v1/me/profile-photo (upload)
------------------------------------------------------------------ */
router.put("/v1/me/profile-photo", requireSession, upload.single("photo"), async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "photo file required" });
    }

    const { userID } = req.user;

    const contentType = safeMimeType(req.file.mimetype);
    const ext =
      contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
        ? "webp"
        : contentType === "image/heic"
        ? "heic"
        : "jpg";

    const objectKey = `users/${userID}/profile.${ext}`;

    logger.info("[photo-upload][start]", {
      rid: req._rid,
      userID,
      objectKey,
      bytes: Number(req.file.size || 0),
      ct: contentType
    });

    const s3 = makeS3Client();

    // Stage 1: S3 upload (fail-fast)
    logger.info("[photo-upload][s3] begin", { rid: req._rid, userID });
    await withTimeout(
      s3.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: objectKey,
          Body: req.file.buffer,
          ContentType: contentType,
          CacheControl: "no-store"
        })
      ),
      15000,
      "s3-put"
    );
    logger.info("[photo-upload][s3] ok", { rid: req._rid, userID });

    // Stage 2: DB update (fail-fast)
    logger.info("[photo-upload][db] begin", { rid: req._rid, userID });
    await withTimeout(setCanonicalProfilePhotoKey(userID, objectKey), 8000, "db-set-photo-key");
    logger.info("[photo-upload][db] ok", { rid: req._rid, userID });

    return res.json({ ok: true });
  } catch (err) {
    const msg = String(err?.message || err);

    // Keep exact alert match strings from the epic.
    logger.error("[photo-upload][fail]", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:s3-put")) {
      return res.status(503).json({ error: "object storage timeout" });
    }
    if (msg.startsWith("timeout:db-set-photo-key")) {
      // Dedicated string for alert matching.
      logger.error("timeout:db-set-photo-key", { rid: req._rid });
      return res.status(503).json({ error: "db timeout setting photo key" });
    }

    return res.status(500).json({ error: "upload failed" });
  }
});

/* ------------------------------------------------------------------
   DELETE /v1/me/profile-photo (delete)
------------------------------------------------------------------ */
router.delete("/v1/me/profile-photo", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  try {
    const { userID } = req.user;

    const key = await getCanonicalProfilePhotoKey(userID);
    if (!key) return res.json({ ok: true });

    logger.info("[photo-delete]", { rid: req._rid, userID, key });

    const s3 = makeS3Client();
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
    } catch (err) {
      logger.warn("profile-photo delete object failed", { rid: req._rid, err: err?.message || String(err) });
    }

    await clearCanonicalProfilePhotoKey(userID);

    return res.json({ ok: true });
  } catch (err) {
    logger.error("profile-photo delete failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "delete failed" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/me/profile-photo-url (signed url)
------------------------------------------------------------------ */
router.get("/v1/me/profile-photo-url", requireSession, async (req, res) => {
  const maybe = requireStorageOr503(res);
  if (maybe) return;

  res.set("X-HakMun-PhotoURL", "v0.12-canonical");

  try {
    const { userID } = req.user;

    // Debug-only DB probe
    const { shouldLog, scopeEnabled } = logger;
    if (shouldLog("debug") && scopeEnabled("db_probe")) {
      const probe = await pool.query(
        "select profile_photo_object_key, profile_photo_updated_at from users where user_id = $1 limit 1",
        [userID]
      );
      logger.debug("db_probe", "[photo-url][probe]", { rid: req._rid, userID, row: probe.rows?.[0] || null });
    }

    const key = await getCanonicalProfilePhotoKey(userID);
    logger.info("[photo-url]", { rid: req._rid, userID, hasKey: Boolean(key) });

    if (!key) {
      return res.status(404).json({ error: "no profile photo" });
    }

    const s3 = makeS3Client();
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucketName(), Key: key }),
      { expiresIn: 60 * 15 }
    );

    return res.json({ url, expiresIn: 900 });
  } catch (err) {
    logger.error("profile-photo-url failed", { rid: req._rid, err: err?.message || String(err) });
    return res.status(500).json({ error: "failed to sign url" });
  }
});

module.exports = router;