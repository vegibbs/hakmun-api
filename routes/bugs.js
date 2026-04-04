// routes/bugs.js — In-app bug reporting with GitHub Issue integration

const express = require("express");
const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");
const { signImageUrl } = require("../util/s3");

const router = express.Router();

const GITHUB_PAT = process.env.GITHUB_PAT || "";
const GITHUB_REPO_OWNER = "vegibbs";
const GITHUB_REPO_NAME = "HakMun";

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

/** Format tracking number as HM-NNNN */
function formatTrackingNumber(n) {
  return `HM-${String(n).padStart(4, "0")}`;
}

/** Get user's primary_language for translation. */
async function getUserAppLanguage(userId) {
  const r = await pool.query(
    `SELECT primary_language FROM users WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0]?.primary_language || null;
}

/** Call the local translate endpoint logic (inline, no HTTP round-trip). */
async function translateViaOpenAI(text, appLanguage, sourceLanguage, targetLanguage) {
  // Reuse the same pattern as routes/translate.js but inline for the submit flow
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const langNames = {
    en: "English", ko: "Korean", fr: "French", es: "Spanish",
    ja: "Japanese", zh: "Chinese", de: "German", pt: "Portuguese",
  };
  const ln = (code) => langNames[code] || code;

  const mismatchBlock =
    appLanguage && appLanguage !== sourceLanguage
      ? `- Because they are writing in a non-native language, their phrasing may
  reflect ${ln(appLanguage)} patterns. Interpret generously and produce a
  clear, natural translation in ${ln(targetLanguage)}.`
      : "";

  const systemPrompt = `You are translating a bug report for HakMun, a Korean language learning app.

About the author:
- Their primary (native) language is ${ln(appLanguage)}.
- They are writing in ${ln(sourceLanguage)}.
${mismatchBlock}

Rules:
- Preserve Korean example text exactly as-is when they appear as learning content examples.
- App feature names (Notebook, Writing Practice, Hanja, etc.) should remain in English.
- Technical terms should be translated naturally into ${ln(targetLanguage)}.
- Return ONLY the translation. No explanations.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`openai_translate_${resp.status}`);

  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("openai_translate_no_content");
  return content.trim();
}

/** Detect language of text via OpenAI. */
async function detectLanguage(text) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return "en";

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "Detect the primary language. Return ONLY a two-letter ISO 639-1 code (e.g. en, ko). Nothing else.",
        },
        { role: "user", content: text },
      ],
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) return "en";
  return (json?.choices?.[0]?.message?.content || "en").trim().toLowerCase().slice(0, 2);
}

/** Create a GitHub Issue from a bug report. */
async function createGitHubIssue(report, attachmentUrls) {
  if (!GITHUB_PAT) throw new Error("GITHUB_PAT not configured");

  const tn = formatTrackingNumber(report.tracking_number);
  const whatHappened = report.translated_what_happened || report.what_happened || "";
  const firstLine = whatHappened.split("\n")[0].slice(0, 80);

  const title = `[${tn}] ${firstLine}`;

  // Build body
  const sections = [];

  // Translated text
  if (report.translated_what_happened) {
    sections.push(`## What happened\n${report.translated_what_happened}`);
  } else {
    sections.push(`## What happened\n${report.what_happened || "(empty)"}`);
  }

  if (report.translated_what_expected) {
    sections.push(`## What was expected\n${report.translated_what_expected}`);
  } else if (report.what_expected) {
    sections.push(`## What was expected\n${report.what_expected}`);
  }

  // Original text (collapsible)
  if (report.translated_what_happened && report.what_happened) {
    const originalParts = [`**What happened (original):**\n${report.what_happened}`];
    if (report.what_expected) {
      originalParts.push(`**What was expected (original):**\n${report.what_expected}`);
    }
    sections.push(
      `<details>\n<summary>Original text (${report.original_language || "unknown"})</summary>\n\n${originalParts.join("\n\n")}\n</details>`
    );
  }

  // Context metadata
  if (report.app_context) {
    const ctx = report.app_context;
    const lines = [];
    if (ctx.module) lines.push(`- **Module:** ${ctx.module}`);
    if (ctx.platform) lines.push(`- **Platform:** ${ctx.platform}`);
    if (ctx.app_version) lines.push(`- **App Version:** ${ctx.app_version}`);
    if (ctx.os_version) lines.push(`- **OS Version:** ${ctx.os_version}`);
    if (lines.length) sections.push(`## Context\n${lines.join("\n")}`);
  }

  // Attachments
  if (attachmentUrls.length > 0) {
    const imgs = attachmentUrls.map((u, i) => `![Attachment ${i + 1}](${u})`);
    sections.push(`## Attachments\n${imgs.join("\n")}`);
  }

  sections.push(`---\n*Submitted via HakMun in-app reporter (${tn})*`);

  const body = sections.join("\n\n");

  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_PAT}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title,
        body,
        labels: ["bug", "in-app-report"],
      }),
    }
  );

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`github_issue_${resp.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }

  return {
    number: json.number,
    url: json.html_url,
  };
}

/* ------------------------------------------------------------------
   Enrich report with signed attachment URLs
------------------------------------------------------------------ */

async function enrichWithMedia(report) {
  const mediaR = await pool.query(
    `SELECT m.id, m.object_key, m.content_type, m.size_bytes, m.created_at
     FROM bug_report_media brm
     JOIN media m ON m.id = brm.media_id
     WHERE brm.bug_report_id = $1
     ORDER BY brm.sort_order`,
    [report.id]
  );

  const media = [];
  for (const row of mediaR.rows) {
    const url = await signImageUrl(row.object_key);
    media.push({
      media_id: row.id,
      url,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
    });
  }
  report.media = media;
  return report;
}

/* ------------------------------------------------------------------
   POST /v1/bugs — Create draft
------------------------------------------------------------------ */

router.post("/v1/bugs", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { what_happened, what_expected, app_context } = req.body || {};

    const r = await withTimeout(
      pool.query(
        `INSERT INTO bug_reports (owner_user_id, what_happened, what_expected, app_context)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tracking_number, status, created_at`,
        [userId, what_happened || null, what_expected || null, app_context ? JSON.stringify(app_context) : null]
      ),
      8000,
      "db-create-bug"
    );

    const row = r.rows[0];
    return res.status(201).json({
      ok: true,
      id: row.id,
      tracking_number: row.tracking_number,
      tracking_label: formatTrackingNumber(row.tracking_number),
      status: row.status,
      created_at: row.created_at,
    });
  } catch (err) {
    logger.error("[bugs] create failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/bugs/mine — List user's reports
------------------------------------------------------------------ */

router.get("/v1/bugs/mine", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(
        `SELECT id, tracking_number, status, what_happened, created_at, updated_at
         FROM bug_reports
         WHERE owner_user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      ),
      8000,
      "db-list-bugs"
    );

    const reports = r.rows.map((row) => ({
      id: row.id,
      tracking_number: row.tracking_number,
      tracking_label: formatTrackingNumber(row.tracking_number),
      status: row.status,
      summary: (row.what_happened || "").slice(0, 100),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return res.json({ ok: true, reports });
  } catch (err) {
    logger.error("[bugs] list failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   GET /v1/bugs/:id — Get report with attachments
------------------------------------------------------------------ */

router.get("/v1/bugs/:id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const r = await withTimeout(
      pool.query(
        `SELECT * FROM bug_reports WHERE id = $1 AND owner_user_id = $2`,
        [req.params.id, userId]
      ),
      8000,
      "db-get-bug"
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const report = r.rows[0];
    report.tracking_label = formatTrackingNumber(report.tracking_number);
    await enrichWithMedia(report);

    return res.json({ ok: true, report });
  } catch (err) {
    logger.error("[bugs] get failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   PUT /v1/bugs/:id — Update draft
------------------------------------------------------------------ */

router.put("/v1/bugs/:id", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    // Verify ownership and draft status
    const existing = await withTimeout(
      pool.query(
        `SELECT id, status FROM bug_reports WHERE id = $1 AND owner_user_id = $2`,
        [req.params.id, userId]
      ),
      8000,
      "db-check-bug"
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (existing.rows[0].status !== "draft") {
      return res.status(400).json({ ok: false, error: "CANNOT_EDIT_SUBMITTED" });
    }

    const { what_happened, what_expected, app_context } = req.body || {};

    const r = await withTimeout(
      pool.query(
        `UPDATE bug_reports
         SET what_happened = COALESCE($1, what_happened),
             what_expected = COALESCE($2, what_expected),
             app_context = COALESCE($3, app_context),
             updated_at = now()
         WHERE id = $4
         RETURNING id, tracking_number, status, what_happened, what_expected, app_context, updated_at`,
        [
          what_happened !== undefined ? what_happened : null,
          what_expected !== undefined ? what_expected : null,
          app_context ? JSON.stringify(app_context) : null,
          req.params.id,
        ]
      ),
      8000,
      "db-update-bug"
    );

    const row = r.rows[0];
    row.tracking_label = formatTrackingNumber(row.tracking_number);
    return res.json({ ok: true, report: row });
  } catch (err) {
    logger.error("[bugs] update failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/bugs/:id/media — Attach media to report
------------------------------------------------------------------ */

router.post("/v1/bugs/:id/media", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const { media_id } = req.body || {};
    if (!media_id) {
      return res.status(400).json({ ok: false, error: "MEDIA_ID_REQUIRED" });
    }

    // Verify report ownership and draft status
    const report = await withTimeout(
      pool.query(
        `SELECT id, status FROM bug_reports WHERE id = $1 AND owner_user_id = $2`,
        [req.params.id, userId]
      ),
      8000,
      "db-check-bug-media"
    );

    if (report.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (report.rows[0].status !== "draft") {
      return res.status(400).json({ ok: false, error: "CANNOT_EDIT_SUBMITTED" });
    }

    // Verify media ownership
    const media = await pool.query(
      `SELECT id FROM media WHERE id = $1 AND owner_user_id = $2`,
      [media_id, userId]
    );
    if (media.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "MEDIA_NOT_FOUND" });
    }

    // Get next sort order
    const orderR = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM bug_report_media WHERE bug_report_id = $1`,
      [req.params.id]
    );

    await pool.query(
      `INSERT INTO bug_report_media (bug_report_id, media_id, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, media_id, orderR.rows[0].next_order]
    );

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[bugs] attach media failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   DELETE /v1/bugs/:id/media/:mediaId — Remove attachment
------------------------------------------------------------------ */

router.delete("/v1/bugs/:id/media/:mediaId", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    // Verify report ownership and draft status
    const report = await pool.query(
      `SELECT id, status FROM bug_reports WHERE id = $1 AND owner_user_id = $2`,
      [req.params.id, userId]
    );
    if (report.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    if (report.rows[0].status !== "draft") {
      return res.status(400).json({ ok: false, error: "CANNOT_EDIT_SUBMITTED" });
    }

    await pool.query(
      `DELETE FROM bug_report_media WHERE bug_report_id = $1 AND media_id = $2`,
      [req.params.id, req.params.mediaId]
    );

    return res.json({ ok: true });
  } catch (err) {
    logger.error("[bugs] remove media failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

/* ------------------------------------------------------------------
   POST /v1/bugs/:id/submit — Translate + create GitHub Issue
------------------------------------------------------------------ */

router.post("/v1/bugs/:id/submit", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    // Fetch report
    const reportR = await withTimeout(
      pool.query(
        `SELECT * FROM bug_reports WHERE id = $1 AND owner_user_id = $2`,
        [req.params.id, userId]
      ),
      8000,
      "db-get-bug-submit"
    );

    if (reportR.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }

    const report = reportR.rows[0];

    if (report.status !== "draft") {
      return res.status(400).json({ ok: false, error: "ALREADY_SUBMITTED" });
    }
    if (!report.what_happened || !report.what_happened.trim()) {
      return res.status(400).json({ ok: false, error: "WHAT_HAPPENED_REQUIRED" });
    }

    // Detect language and translate if needed
    const appLanguage = await getUserAppLanguage(userId);
    const detectedLang = await withTimeout(
      detectLanguage(report.what_happened),
      15000,
      "detect-lang-bug"
    );

    let translatedWhat = null;
    let translatedExpected = null;

    if (detectedLang !== "en") {
      translatedWhat = await withTimeout(
        translateViaOpenAI(report.what_happened, appLanguage || "en", detectedLang, "en"),
        30000,
        "translate-what"
      );
      if (report.what_expected && report.what_expected.trim()) {
        translatedExpected = await withTimeout(
          translateViaOpenAI(report.what_expected, appLanguage || "en", detectedLang, "en"),
          30000,
          "translate-expected"
        );
      }
    }

    // Update report with translations and language
    await pool.query(
      `UPDATE bug_reports
       SET original_language = $1,
           translated_what_happened = $2,
           translated_what_expected = $3,
           updated_at = now()
       WHERE id = $4`,
      [detectedLang, translatedWhat, translatedExpected, report.id]
    );

    // Merge translations into report object for GitHub Issue creation
    report.original_language = detectedLang;
    report.translated_what_happened = translatedWhat;
    report.translated_what_expected = translatedExpected;

    // Get attachment URLs for the GitHub Issue body
    const mediaR = await pool.query(
      `SELECT m.object_key FROM bug_report_media brm
       JOIN media m ON m.id = brm.media_id
       WHERE brm.bug_report_id = $1
       ORDER BY brm.sort_order`,
      [report.id]
    );
    const attachmentUrls = [];
    for (const row of mediaR.rows) {
      // Use a long-lived signed URL for the GitHub Issue (24 hours)
      const url = await signImageUrl(row.object_key, 86400);
      if (url) attachmentUrls.push(url);
    }

    // Create GitHub Issue
    let githubIssueNumber = null;
    let githubIssueUrl = null;

    if (GITHUB_PAT) {
      const issue = await withTimeout(
        createGitHubIssue(report, attachmentUrls),
        15000,
        "github-create-issue"
      );
      githubIssueNumber = issue.number;
      githubIssueUrl = issue.url;
    } else {
      logger.warn("[bugs] GITHUB_PAT not set, skipping GitHub Issue creation");
    }

    // Update status to submitted
    await pool.query(
      `UPDATE bug_reports
       SET status = 'submitted',
           github_issue_number = $1,
           github_issue_url = $2,
           updated_at = now()
       WHERE id = $3`,
      [githubIssueNumber, githubIssueUrl, report.id]
    );

    logger.info("[bugs] submitted", {
      bugId: report.id,
      tracking: formatTrackingNumber(report.tracking_number),
      githubIssue: githubIssueNumber,
    });

    return res.json({
      ok: true,
      status: "submitted",
      tracking_label: formatTrackingNumber(report.tracking_number),
      github_issue_number: githubIssueNumber,
      github_issue_url: githubIssueUrl,
    });
  } catch (err) {
    logger.error("[bugs] submit failed", { err: String(err?.message || err) });
    return res.status(500).json({ ok: false, error: "SUBMIT_FAILED" });
  }
});

module.exports = router;
