// util/s3.js — Shared S3 helpers (client, bucket, URL signing)

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function storageConfigured() {
  return Boolean(
    process.env.OBJECT_STORAGE_ENDPOINT &&
      process.env.OBJECT_STORAGE_BUCKET &&
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID &&
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  );
}

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

/**
 * Sign an S3 object key into a short-lived read URL.
 * Returns null if s3Key is falsy.
 * @param {string|null} s3Key
 * @param {number} [expiresIn=900] seconds (default 15 min)
 * @returns {Promise<string|null>}
 */
async function signImageUrl(s3Key, expiresIn = 900) {
  if (!s3Key) return null;
  const s3 = makeS3Client();
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucketName(), Key: s3Key }),
    { expiresIn }
  );
}

/**
 * Sign an array of objects that have an `image_s3_key` property.
 * Adds `image_url` to each object (signed URL or null).
 * Mutates and returns the array.
 */
async function signImageUrls(rows, keyField = "image_s3_key") {
  if (!rows || rows.length === 0) return rows;
  await Promise.all(
    rows.map(async (row) => {
      row.image_url = await signImageUrl(row[keyField]);
    })
  );
  return rows;
}

module.exports = {
  storageConfigured,
  makeS3Client,
  bucketName,
  signImageUrl,
  signImageUrls,
  GetObjectCommand,
  PutObjectCommand,
};
