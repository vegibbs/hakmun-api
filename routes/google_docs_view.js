// FILE: hakmun-api/routes/google_docs_view.js
// PURPOSE: D2.3a — Read-only Google Doc viewer (Docs API)
// ENDPOINT:
//   GET /v1/documents/google/view?google_doc_url=...
//
// Behavior:
// - Requires user session (Bearer)
// - Uses per-user google_oauth_connections
// - Refreshes access token as needed
// - Fetches doc via Google Docs API
// - Returns a bounded, renderable block list + headings for navigation
//
// Sessions:
// - Derives sessions from HEADING_1 blocks whose text starts with YYYY.MM.DD
// - Adds session_date (YYYY-MM-DD) for each session
// - Supports filtering sessions via query params:
//
//   session_date=YYYY-MM-DD         (single day)
//   session_start=YYYY-MM-DD        (range start, inclusive)
//   session_end=YYYY-MM-DD          (range end, inclusive)
//   last_n_weeks=N                  (integer)
//
// Precedence:
// 1) session_date
// 2) session_start/session_end
// 3) last_n_weeks
// 4) none (all)
//
// Notes:
// - This does NOT export DOCX.
// - This is read-only and works for very large docs by returning a partial view.

const express = require("express");
const { requireSession } = require("../auth/session");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");

const router = express.Router();

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function extractGoogleDocFileId(input) {
  if (!input) return null;
  const s = String(input).trim();

  const m1 = s.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m1 && m1[1]) return m1[1];

  const m2 = s.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (m2 && m2[1]) return m2[1];

  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

async function refreshAccessToken(refreshToken) {
  const clientId = mustEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`google_refresh_failed:${JSON.stringify(json).slice(0, 500)}`);
  }

  return {
    access_token: json.access_token,
    expires_in: Number(json.expires_in || 0),
    scope: json.scope || null
  };
}

function paragraphText(paragraph) {
  const elems = paragraph?.elements || [];
  let out = "";
  for (const el of elems) {
    const tr = el?.textRun;
    const content = tr?.content;
    if (typeof content === "string") out += content;
  }
  return out;
}

function extractSessionDate(text) {
  const m = String(text || "").trim().match(/^(\d{4})\.(\d{2})\.(\d{2})\b/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function isSessionHeading(style, text) {
  if (typeof style !== "string") return false;
  if (style !== "HEADING_1") return false;
  const t = String(text || "").trim();
  // Session marker: starts with YYYY.MM.DD
  return /^\d{4}\.\d{2}\.\d{2}\b/.test(t);
}

function buildSessionsFromBlocks(blocks) {
  const sessionHeaders = [];
  for (const b of blocks) {
    if (isSessionHeading(b?.style, b?.text)) {
      const headingText = String(b.text || "").trim();
      sessionHeaders.push({
        heading_block_index: b.block_index,
        heading_text: headingText.slice(0, 140),
        session_date: extractSessionDate(headingText)
      });
    }
  }

  const sessions = [];
  for (let i = 0; i < sessionHeaders.length; i++) {
    const cur = sessionHeaders[i];
    const next = sessionHeaders[i + 1] || null;

    const start = cur.heading_block_index;
    const end = next ? (next.heading_block_index - 1) : (blocks.length - 1);

    sessions.push({
      session_index: i,
      session_date: cur.session_date,
      heading_block_index: cur.heading_block_index,
      heading_text: cur.heading_text,
      start_block_index: start,
      end_block_index: Math.max(start, end)
    });
  }

  return sessions;
}

function parseIsoDate(s) {
  const t = String(s || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(dateObj, days) {
  const ms = dateObj.getTime() + (days * 24 * 60 * 60 * 1000);
  return new Date(ms);
}

function filterSessions({ sessions, sessionDate, sessionStart, sessionEnd, lastNWeeks }) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];

  // 1) single date
  if (sessionDate) {
    return sessions.filter(s => s.session_date === sessionDate);
  }

  // 2) date range
  if (sessionStart || sessionEnd) {
    return sessions.filter(s => {
      const sd = s.session_date;
      if (!sd) return false;
      if (sessionStart && sd < sessionStart) return false;
      if (sessionEnd && sd > sessionEnd) return false;
      return true;
    });
  }

  // 3) last N weeks
  if (Number.isFinite(lastNWeeks) && lastNWeeks > 0) {
    const today = new Date();
    const todayUtcMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const cutoff = addDaysUtc(todayUtcMidnight, -(lastNWeeks * 7));
    const cutoffIso = toIsoDate(cutoff);

    return sessions.filter(s => (s.session_date || "") >= cutoffIso);
  }

  // 4) no filter
  return sessions;
}

router.get("/v1/documents/google/view", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const url = typeof req.query?.google_doc_url === "string" ? req.query.google_doc_url.trim() : "";
    if (!url) return res.status(400).json({ ok: false, error: "GOOGLE_DOC_URL_REQUIRED" });

    const fileId = extractGoogleDocFileId(url);
    if (!fileId) return res.status(400).json({ ok: false, error: "INVALID_GOOGLE_DOC_LINK" });

    // Load OAuth connection
    const connR = await withTimeout(
      pool.query(
        `SELECT refresh_token, access_token, access_token_expires_at, scopes
         FROM google_oauth_connections
         WHERE user_id = $1::uuid
         LIMIT 1`,
        [userId]
      ),
      8000,
      "db-get-google-conn"
    );

    const conn = connR.rows?.[0];
    if (!conn?.refresh_token) {
      return res.status(400).json({ ok: false, error: "GOOGLE_NOT_CONNECTED" });
    }

    // Access token validity check
    let accessToken = conn.access_token || null;
    const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
    const now = Date.now();
    const stillValid = accessToken && expiresAt && (expiresAt - now > 60_000);

    if (!stillValid) {
      const refreshed = await refreshAccessToken(conn.refresh_token);
      accessToken = refreshed.access_token;

      const expiresIso = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
      await withTimeout(
        pool.query(
          `UPDATE google_oauth_connections
             SET access_token = $2,
                 access_token_expires_at = $3::timestamptz,
                 scopes = COALESCE($4, scopes),
                 updated_at = now()
           WHERE user_id = $1::uuid`,
          [userId, accessToken, expiresIso, refreshed.scope]
        ),
        8000,
        "db-update-google-token"
      );
    }

    // Fetch doc structure via Google Docs API
    const docsUrl = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`;
    const docsResp = await fetch(docsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const docsJson = await docsResp.json().catch(() => ({}));
    if (!docsResp.ok) {
      logger.error("[google-view] docs api failed", {
        fileId,
        status: docsResp.status,
        body: JSON.stringify(docsJson).slice(0, 500)
      });
      return res.status(403).json({ ok: false, error: "GOOGLE_DOCS_GET_FAILED" });
    }

    const title = docsJson?.title || "Google Doc";

    // Build a bounded list of display blocks + headings for navigation
    const MAX_BLOCKS = 5000;
    const MAX_CHARS = 200000; // view budget (not parse budget)
    let chars = 0;

    const blocks = [];
    const headings = [];

    const body = docsJson?.body?.content || [];
    for (const c of body) {
      if (blocks.length >= MAX_BLOCKS) break;

      const p = c?.paragraph;
      if (!p) continue;

      let text = paragraphText(p).replace(/\r/g, "");
      text = text.trimEnd();

      if (!text.trim()) continue;

      const style = p?.paragraphStyle?.namedStyleType || "NORMAL_TEXT";
      const isHeading = typeof style === "string" && style.startsWith("HEADING_");

      // Budget
      if (chars + text.length > MAX_CHARS) {
        const remaining = MAX_CHARS - chars;
        if (remaining <= 0) break;
        text = text.slice(0, remaining);
      }

      const block = {
        block_index: blocks.length,
        style,
        text
      };
      blocks.push(block);
      chars += text.length;

      if (isHeading) {
        headings.push({
          block_index: block.block_index,
          style,
          text: text.slice(0, 140)
        });
      }

      if (chars >= MAX_CHARS) break;
    }

    const truncated = (blocks.length >= MAX_BLOCKS) || (chars >= MAX_CHARS);

    // Derived sessions
    const sessions = buildSessionsFromBlocks(blocks);

    // Optional session filters (server-side)
    const sessionDate = parseIsoDate(req.query?.session_date) ? String(req.query.session_date).trim() : null;

    const sessionStart = parseIsoDate(req.query?.session_start) ? String(req.query.session_start).trim() : null;
    const sessionEnd = parseIsoDate(req.query?.session_end) ? String(req.query.session_end).trim() : null;

    const lastNWeeksRaw = req.query?.last_n_weeks;
    const lastNWeeks =
      (lastNWeeksRaw !== undefined && lastNWeeksRaw !== null && String(lastNWeeksRaw).trim() !== "")
        ? Math.floor(Number(lastNWeeksRaw))
        : null;

    const sessionsFiltered = filterSessions({
      sessions,
      sessionDate,
      sessionStart,
      sessionEnd,
      lastNWeeks
    });

    return res.json({
      ok: true,
      file_id: fileId,
      google_doc_url: url,
      title,
      truncated,
      blocks,
      headings,
      sessions: sessionsFiltered
    });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[google-view] failed", { err: msg });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;