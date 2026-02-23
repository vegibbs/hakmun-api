// util/document_helpers.js — HakMun API
// Shared functions for document management.
// Used by google_docs_commit.js and practice_lists.js.

const crypto = require("crypto");

const { pool } = require("../db/pool");
const { withTimeout } = require("./time");

const QUERY_TIMEOUT_MS = 8000;

function looksLikeUUID(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));
}

function cleanString(v, maxLen = 2000) {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * Ensure a documents row exists for the given Google Doc URL and user.
 * Returns the document_id (existing or newly created).
 *
 * @param {Object} opts
 * @param {string} opts.userId - User UUID
 * @param {string} opts.googleDocUrl - Full Google Doc URL
 * @param {string} opts.snapshotAssetId - Snapshot asset UUID (required for new rows)
 * @param {string} opts.title - Document title
 * @returns {string} document_id UUID
 */
async function ensureGoogleDocumentRow({ userId, googleDocUrl, snapshotAssetId, title }) {
  const r = await withTimeout(
    pool.query(
      `SELECT document_id
         FROM documents
        WHERE owner_user_id = $1::uuid
          AND source_kind = 'google_doc'
          AND source_uri = $2
        LIMIT 1`,
      [userId, googleDocUrl]
    ),
    QUERY_TIMEOUT_MS,
    "db-find-document"
  );

  const existing = r.rows?.[0]?.document_id || null;
  if (existing) return existing;

  if (!looksLikeUUID(snapshotAssetId)) {
    throw new Error("SNAPSHOT_ASSET_ID_REQUIRED");
  }

  const documentId = crypto.randomUUID();
  const t = cleanString(title, 140) || "Google Doc";

  await withTimeout(
    pool.query(
      `INSERT INTO documents (
         document_id, owner_user_id, asset_id, source_kind, source_uri, title, ingest_status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'google_doc', $4, $5, 'verified'
       )`,
      [documentId, userId, snapshotAssetId, googleDocUrl, t]
    ),
    QUERY_TIMEOUT_MS,
    "db-insert-document"
  );

  return documentId;
}

module.exports = {
  ensureGoogleDocumentRow,
  looksLikeUUID,
  cleanString
};
