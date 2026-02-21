// FILE: hakmun-api/routes/nikl_fetch_on_demand.js
// PURPOSE: Fetch a KRDICT /api/view entry on demand, upload XML to S3,
//   do a lightweight parse into nikl_entries/senses/translations so the
//   teaching vocab editor can use it immediately.
// ENDPOINT:
//   POST /v1/nikl/fetch-on-demand  { target_code: 12345 }

const express = require("express");
const router = express.Router();
const https = require("https");
const crypto = require("crypto");

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { requireSession, requireEntitlement } = require("../auth/session");
const db = require("../db/pool");

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

const NIKL_API_KEY = process.env.NIKL_OPEN_API_KEY || "";
const BASE_VIEW_URL = "https://krdict.korean.go.kr/api/view";
const PROVIDER = "krdict";

// S3 setup (same pattern as routes/assets.js)
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

function getBucket() {
  return process.env.OBJECT_STORAGE_BUCKET;
}

// Minimal XML helpers (same as nikl_api_search.js)
function xmlText(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlBlocks(xml, tag) {
  const blocks = [];
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let idx = 0;
  while (true) {
    const start = xml.indexOf(openTag, idx);
    if (start === -1) break;
    const contentStart = start + openTag.length;
    const end = xml.indexOf(closeTag, contentStart);
    if (end === -1) break;
    blocks.push(xml.slice(contentStart, end));
    idx = end + closeTag.length;
  }
  return blocks;
}

function httpsGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ body: Buffer.concat(chunks), statusCode: res.statusCode }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("NIKL view API request timed out"));
    });
  });
}

const LANG_MAP = {
  "영어": "en", "일본어": "ja", "중국어": "zh", "프랑스어": "fr",
  "스페인어": "es", "독일어": "de", "러시아어": "ru", "베트남어": "vi",
  "몽골어": "mn", "아랍어": "ar", "태국어": "th", "인도네시아어": "id",
};

/**
 * Lightweight parse of KRDICT /api/view XML.
 * Extracts just: entry (headword, pos_ko) + senses (definition_ko) + translations.
 */
function parseViewXml(xmlStr) {
  // Find the <item> block
  const itemXml = xmlText(xmlStr, "item");
  if (!itemXml) throw new Error("Missing <item> in view XML");

  const targetCode = xmlText(itemXml, "target_code");
  if (!targetCode) throw new Error("Missing <target_code> in view XML");

  const wordInfoXml = xmlText(itemXml, "word_info");
  if (!wordInfoXml) throw new Error("Missing <word_info> in view XML");

  const headword = xmlText(wordInfoXml, "word") || "";
  const posKo = xmlText(wordInfoXml, "pos") || null;

  // Parse senses
  const senseBlocks = xmlBlocks(wordInfoXml, "sense_info");
  const senses = [];

  for (const senseXml of senseBlocks) {
    const senseNo = parseInt(xmlText(senseXml, "sense_no") || "0", 10);
    if (!senseNo) continue;
    const definitionKo = xmlText(senseXml, "definition") || "";

    // Parse translations within the sense
    const translations = [];
    const transBlocks = xmlBlocks(senseXml, "translation");
    for (let idx = 0; idx < transBlocks.length; idx++) {
      const tXml = transBlocks[idx];
      const transLangRaw = xmlText(tXml, "trans_lang") || "";
      const lang = LANG_MAP[transLangRaw] || null;
      const transWord = xmlText(tXml, "trans_word") || null;
      const transDef = xmlText(tXml, "trans_dfn") || null;

      translations.push({
        idx: idx + 1,
        lang,
        trans_lang_raw: transLangRaw,
        trans_word: transWord,
        trans_definition: transDef,
      });
    }

    senses.push({ sense_no: senseNo, definition_ko: definitionKo, translations });
  }

  return { target_code: targetCode, headword, pos_ko: posKo, senses };
}

// POST /v1/nikl/fetch-on-demand
router.post(
  "/v1/nikl/fetch-on-demand",
  requireSession,
  requireEntitlement("approver:content"),
  async (req, res) => {
    try {
      const targetCode = parseInt(req.body?.target_code, 10);
      if (!targetCode || isNaN(targetCode)) {
        return res.status(400).json({ ok: false, error: "MISSING_TARGET_CODE" });
      }
      if (!NIKL_API_KEY) {
        return res.status(503).json({ ok: false, error: "NIKL_API_KEY_NOT_CONFIGURED" });
      }

      // Check if already in DB
      const existCheck = await dbQuery(
        `SELECT ne.provider_target_code, ne.headword, ne.pos_ko
         FROM nikl_entries ne
         WHERE ne.provider = $1 AND ne.provider_target_code = $2`,
        [PROVIDER, String(targetCode)]
      );

      if (existCheck.rows.length > 0) {
        // Already fetched — return existing entry + senses
        const entry = existCheck.rows[0];
        const { rows: senseRows } = await dbQuery(
          `SELECT ns.sense_no, ns.definition_ko,
                  st.trans_word AS trans_word_en,
                  st.trans_definition AS trans_definition_en
           FROM nikl_senses ns
           LEFT JOIN nikl_sense_translations st
             ON st.provider = ns.provider
            AND st.provider_target_code = ns.provider_target_code
            AND st.sense_no = ns.sense_no
            AND st.lang = 'en'
            AND st.idx = 1
           WHERE ns.provider = $1
             AND ns.provider_target_code = $2
           ORDER BY ns.sense_no`,
          [PROVIDER, String(targetCode)]
        );

        return res.json({
          ok: true,
          already_existed: true,
          entry: {
            provider_target_code: targetCode,
            headword: entry.headword,
            pos_ko: entry.pos_ko,
            senses: senseRows.map((s) => ({
              sense_no: s.sense_no,
              definition_ko: s.definition_ko,
              trans_word_en: s.trans_word_en || null,
              trans_definition_en: s.trans_definition_en || null,
              provider_target_code: targetCode,
            })),
          },
        });
      }

      // Fetch from KRDICT view API
      const params = new URLSearchParams({
        key: NIKL_API_KEY,
        method: "target_code",
        q: String(targetCode),
        translated: "y",
        trans_lang: "0", // all languages
      });

      const { body: xmlBuffer, statusCode } = await httpsGet(
        `${BASE_VIEW_URL}?${params.toString()}`
      );

      if (statusCode !== 200) {
        return res.status(502).json({
          ok: false,
          error: "NIKL_API_ERROR",
          nikl_status: statusCode,
        });
      }

      const xmlStr = xmlBuffer.toString("utf-8");
      const sha256 = crypto.createHash("sha256").update(xmlBuffer).digest("hex");

      // Upload to S3
      const snapshotId = crypto.randomUUID();
      const fetchedAt = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
      const objectKey = `nikl/xml/view/target_code=${targetCode}/${fetchedAt}_${snapshotId}.xml`;

      const s3 = makeS3Client();
      await s3.send(
        new PutObjectCommand({
          Bucket: getBucket(),
          Key: objectKey,
          Body: xmlBuffer,
          ContentType: "application/xml",
        })
      );

      // Insert nikl_snapshots (upsert on endpoint+target_code)
      await dbQuery(
        `INSERT INTO nikl_snapshots
          (snapshot_id, endpoint, target_code, object_key, sha256, bytes, http_status, fetched_at)
         VALUES ($1, 'view', $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (endpoint, target_code)
         DO UPDATE SET
           snapshot_id = EXCLUDED.snapshot_id,
           object_key = EXCLUDED.object_key,
           sha256 = EXCLUDED.sha256,
           bytes = EXCLUDED.bytes,
           http_status = EXCLUDED.http_status,
           fetched_at = NOW(),
           parsed_at = NULL,
           parse_error = NULL`,
        [snapshotId, targetCode, objectKey, sha256, xmlBuffer.length, statusCode]
      );

      // Lightweight parse
      const parsed = parseViewXml(xmlStr);

      // Upsert nikl_entries
      await dbQuery(
        `INSERT INTO nikl_entries
          (provider, provider_target_code, headword, pos_ko, raw_snapshot_id)
         VALUES ($1, $2, $3, $4, $5::uuid)
         ON CONFLICT (provider, provider_target_code)
         DO UPDATE SET
           headword = EXCLUDED.headword,
           pos_ko = EXCLUDED.pos_ko,
           raw_snapshot_id = EXCLUDED.raw_snapshot_id,
           parsed_at = NOW()`,
        [PROVIDER, parsed.target_code, parsed.headword, parsed.pos_ko, snapshotId]
      );

      // Delete existing senses/translations for this entry (cascade handles translations)
      await dbQuery(
        `DELETE FROM nikl_senses WHERE provider = $1 AND provider_target_code = $2`,
        [PROVIDER, parsed.target_code]
      );

      // Insert senses + translations
      for (const sense of parsed.senses) {
        await dbQuery(
          `INSERT INTO nikl_senses
            (provider, provider_target_code, sense_no, definition_ko, raw_snapshot_id)
           VALUES ($1, $2, $3, $4, $5::uuid)`,
          [PROVIDER, parsed.target_code, sense.sense_no, sense.definition_ko, snapshotId]
        );

        for (const t of sense.translations) {
          await dbQuery(
            `INSERT INTO nikl_sense_translations
              (provider, provider_target_code, sense_no, idx, lang, trans_lang_raw, trans_word, trans_definition, raw_snapshot_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid)`,
            [
              PROVIDER,
              parsed.target_code,
              sense.sense_no,
              t.idx,
              t.lang,
              t.trans_lang_raw,
              t.trans_word,
              t.trans_definition,
              snapshotId,
            ]
          );
        }
      }

      // Mark snapshot as parsed
      await dbQuery(
        `UPDATE nikl_snapshots SET parsed_at = NOW() WHERE snapshot_id = $1`,
        [snapshotId]
      );

      // Build response in same shape as nikl_search
      const englishSenses = parsed.senses.map((s) => {
        const enTrans = s.translations.find((t) => t.lang === "en");
        return {
          sense_no: s.sense_no,
          definition_ko: s.definition_ko,
          trans_word_en: enTrans?.trans_word || null,
          trans_definition_en: enTrans?.trans_definition || null,
          provider_target_code: targetCode,
        };
      });

      return res.json({
        ok: true,
        already_existed: false,
        entry: {
          provider_target_code: targetCode,
          headword: parsed.headword,
          pos_ko: parsed.pos_ko,
          senses: englishSenses,
        },
      });
    } catch (err) {
      console.error("nikl fetch-on-demand POST failed:", err);
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

module.exports = router;
