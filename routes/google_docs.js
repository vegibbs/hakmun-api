// FILE: hakmun-api/routes/google_docs.js
// PURPOSE: D2.1 – Google Docs link handling (parse/validate only, no OAuth yet)
// ENDPOINTS:
//   POST /v1/documents/google/parse-link
//
// Notes:
// - This does NOT fetch Google content.
// - This does NOT create documents/assets.
// - It only validates and extracts fileId deterministically.
// - Next step (D2.2) will add OAuth + export + evidence storage + enqueue parse job.

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");

function extractGoogleDocFileId(input) {
  // Accept common formats:
  // - https://docs.google.com/document/d/<FILE_ID>/edit
  // - https://docs.google.com/document/d/<FILE_ID>/view
  // - https://drive.google.com/open?id=<FILE_ID>
  // - raw <FILE_ID> (fallback)
  if (!input) return null;

  const s = String(input).trim();

  // docs.google.com/document/d/<id>/
  const m1 = s.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return m1[1];

  // drive.google.com/open?id=<id>
  const m2 = s.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return m2[1];

  // drive.google.com/file/d/<id>/  (not a doc, but allow for future)
  const m3 = s.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m3 && m3[1]) return m3[1];

  // raw id heuristic: Google file IDs are typically long and URL-safe
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;

  return null;
}

router.post("/v1/documents/google/parse-link", requireSession, async (req, res) => {
  const userId = req.user?.userID || req.userID || req.user?.user_id || null;
  if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

  const url = typeof req.body?.google_doc_url === "string" ? req.body.google_doc_url.trim() : "";
  if (!url) return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });

  const fileId = extractGoogleDocFileId(url);
  if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_GOOGLE_DOC_LINK" });

  return res.json({
    ok: true,
    file_id: fileId,
    // We keep the original URL as provided; later we can normalize/canonicalize.
    google_doc_url: url,
  });
});

module.exports = router;