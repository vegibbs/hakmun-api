// Gate for v1→v2 hakdoc migration at deploy time.
// Set RUN_V1_MIGRATION=dry to dry-run, RUN_V1_MIGRATION=live to migrate.
// Remove the env var after migration is complete.

const mode = process.env.RUN_V1_MIGRATION;

if (!mode) {
  process.exit(0);
}

const { pool } = require("../db/pool");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const DRY_RUN = mode === "dry";

function htmlToPlainText(html) {
  if (!html || typeof html !== "string") return "";
  let text = html;
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  text = text.replace(/<(p|div|li|h[1-6]|tr|table|tbody|thead)[^>]*>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

const DATE_RE = /^\s*(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\s*$/;

function toHDM(plainText) {
  return plainText.split("\n").map((line) => {
    const m = line.trim().match(DATE_RE);
    if (m) {
      const [, y, mo, d] = m;
      if (+y >= 2000 && +y <= 2100 && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
        return `## ${y}.${Number(mo)}.${Number(d)}`;
      }
    }
    return line;
  }).join("\n");
}

async function main() {
  console.log(`[v1-migration] Starting... ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}`);

  const { rows } = await pool.query(`
    SELECT hakdoc_id, title, raw_text, content_version
      FROM hakdocs
     WHERE (content_format IS NULL OR content_format = 'v1')
       AND raw_text IS NOT NULL AND raw_text != ''
     ORDER BY created_at ASC
  `);

  console.log(`[v1-migration] Found ${rows.length} v1 hakdocs`);
  if (rows.length === 0) return;

  const s3 = new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION || "auto",
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  let migrated = 0, failed = 0;

  for (const row of rows) {
    const { hakdoc_id, title, raw_text, content_version } = row;
    const label = `"${title || "Untitled"}" (${hakdoc_id})`;
    try {
      const plain = htmlToPlainText(raw_text);
      if (!plain) { console.log(`  SKIP ${label} — empty`); continue; }

      const hdm = toHDM(plain);
      const nextVersion = (content_version || 0) + 1;
      const contentKey = `hakdocs/${hakdoc_id}/content-v${nextVersion}.txt`;

      if (DRY_RUN) {
        console.log(`  DRY  ${label} — ${hdm.split("\n").length} lines, ${Buffer.byteLength(hdm, "utf-8")} bytes → ${contentKey}`);
        const preview = hdm.split("\n").slice(0, 3).map((l) => `       > ${l}`).join("\n");
        console.log(preview);
        migrated++;
        continue;
      }

      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: contentKey,
        Body: Buffer.from(hdm, "utf-8"),
        ContentType: "text/plain; charset=utf-8",
      }));

      await pool.query(
        `UPDATE hakdocs
            SET content_key = $1, content_version = $2,
                content_format = 'hakdoc-v2', updated_at = NOW()
          WHERE hakdoc_id = $3::uuid`,
        [contentKey, nextVersion, hakdoc_id]
      );

      console.log(`  OK   ${label} → v${nextVersion}`);
      migrated++;
    } catch (err) {
      console.error(`  FAIL ${label}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[v1-migration] Done. Migrated: ${migrated}, Failed: ${failed}, Total: ${rows.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Log but don't block server start
    console.error("[v1-migration] Fatal (non-blocking):", err.message);
    process.exit(0);
  });
