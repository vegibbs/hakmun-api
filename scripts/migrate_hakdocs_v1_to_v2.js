// Migrate HakDoc v1 (raw_text HTML) → v2 (HDM plain text in S3)
//
// Usage:
//   RAILWAY_ENVIRONMENT=sandbox railway run --service hakmun-api -- node scripts/migrate_hakdocs_v1_to_v2.js [--dry-run]
//   RAILWAY_ENVIRONMENT=production railway run --service hakmun-api -- node scripts/migrate_hakdocs_v1_to_v2.js [--dry-run]
//
// What it does:
//   1. Finds all hakdocs where content_format IS NULL or 'v1' AND raw_text IS NOT NULL
//   2. Strips HTML to plain text, preserving line structure
//   3. Converts date-like lines to "## date" session headers
//   4. Uploads converted HDM text to S3
//   5. Updates DB with content_key, content_version, content_format = 'hakdoc-v2'
//
// Best-effort — manual cleanup expected. Lines that can't be classified stay as plain text.

const { pool } = require("../db/pool");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const DRY_RUN = process.argv.includes("--dry-run");

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

const BUCKET = process.env.OBJECT_STORAGE_BUCKET;

// ---------------------------------------------------------------------------
// HTML → plain text conversion
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and decode entities, preserving line breaks.
 * NSAttributedString HTML uses <p> and <br> for line structure.
 */
function htmlToPlainText(html) {
  if (!html || typeof html !== "string") return "";

  let text = html;

  // Remove everything in <head>...</head> (contains style, meta, etc.)
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "");

  // Replace <br>, <br/>, <br /> with newline
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Replace closing block tags with newline (p, div, li, h1-h6)
  text = text.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");

  // Replace opening block tags (remove them, the closing ones add newlines)
  text = text.replace(/<(p|div|li|h[1-6]|tr|table|tbody|thead)[^>]*>/gi, "");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // Collapse multiple blank lines into at most two (one blank line between paragraphs)
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace
  text = text.trim();

  return text;
}

// ---------------------------------------------------------------------------
// Line classification (mirrors Swift LineParser)
// ---------------------------------------------------------------------------

const DATE_RE = /^\s*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s*$/;

function isDateLine(line) {
  const m = line.match(DATE_RE);
  if (!m) return false;
  const [, y, mo, d] = m;
  return (
    +y >= 2000 && +y <= 2100 && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31
  );
}

/**
 * Convert plain text lines to HDM format.
 * - Date lines become "## YYYY.M.D" session headers
 * - Everything else stays as-is (notes with // prefix, Korean text, plain text)
 */
function toHDM(plainText) {
  const lines = plainText.split("\n");
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (isDateLine(trimmed)) {
      // Convert to session header: ## YYYY.M.D
      const m = trimmed.match(DATE_RE);
      const [, y, mo, d] = m;
      out.push(`## ${y}.${Number(mo)}.${Number(d)}`);
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[migrate-v1-v2] Starting... ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}`);
  console.log(`[migrate-v1-v2] Bucket: ${BUCKET}`);

  // Find all v1 hakdocs with content
  const { rows } = await pool.query(`
    SELECT hakdoc_id, title, raw_text, content_version
      FROM hakdocs
     WHERE (content_format IS NULL OR content_format = 'v1')
       AND raw_text IS NOT NULL
       AND raw_text != ''
     ORDER BY created_at ASC
  `);

  console.log(`[migrate-v1-v2] Found ${rows.length} v1 hakdocs to migrate`);

  if (rows.length === 0) {
    console.log("[migrate-v1-v2] Nothing to do.");
    await pool.end();
    return;
  }

  const s3 = makeS3Client();
  let migrated = 0;
  let failed = 0;

  for (const row of rows) {
    const { hakdoc_id, title, raw_text, content_version } = row;
    const label = `"${title || "Untitled"}" (${hakdoc_id})`;

    try {
      // Step 1: HTML → plain text
      const plain = htmlToPlainText(raw_text);
      if (!plain) {
        console.log(`  SKIP ${label} — empty after stripping HTML`);
        continue;
      }

      // Step 2: plain text → HDM
      const hdm = toHDM(plain);

      // Step 3: upload to S3
      const nextVersion = (content_version || 0) + 1;
      const contentKey = `hakdocs/${hakdoc_id}/content-v${nextVersion}.txt`;

      if (DRY_RUN) {
        console.log(`  DRY ${label}`);
        console.log(`       Lines: ${hdm.split("\n").length}, Size: ${Buffer.byteLength(hdm, "utf-8")} bytes`);
        console.log(`       Key: ${contentKey}`);
        // Show first 3 lines of HDM
        const preview = hdm.split("\n").slice(0, 3).map((l) => `       > ${l}`).join("\n");
        console.log(preview);
        migrated++;
        continue;
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: contentKey,
          Body: Buffer.from(hdm, "utf-8"),
          ContentType: "text/plain; charset=utf-8",
        })
      );

      // Step 4: update DB
      await pool.query(
        `UPDATE hakdocs
            SET content_key = $1,
                content_version = $2,
                content_format = 'hakdoc-v2',
                updated_at = NOW()
          WHERE hakdoc_id = $3::uuid`,
        [contentKey, nextVersion, hakdoc_id]
      );

      console.log(`  OK   ${label} → v${nextVersion} (${Buffer.byteLength(hdm, "utf-8")} bytes)`);
      migrated++;
    } catch (err) {
      console.error(`  FAIL ${label}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\n[migrate-v1-v2] Done. Migrated: ${migrated}, Failed: ${failed}, Total: ${rows.length}`
  );
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate-v1-v2] Fatal:", err);
  process.exit(1);
});
