// FILE: hakmun-api/routes/nikl_api_search.js
// PURPOSE: Proxy search to KRDICT API for words NOT in local nikl_entries.
// ENDPOINT:
//   GET /v1/nikl/api-search?headword=...

const express = require("express");
const router = express.Router();
const https = require("https");

const { requireSession, requireEntitlement } = require("../auth/session");

const NIKL_API_KEY = process.env.NIKL_OPEN_API_KEY || "";
const BASE_SEARCH_URL = "https://krdict.korean.go.kr/api/search";

/**
 * Fetch URL and return body as a string.
 * Uses Node built-in https (no extra dependency).
 */
function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("NIKL API request timed out"));
    });
  });
}

/**
 * Minimal XML text extractor — no dependency needed for the flat KRDICT search XML.
 * Extracts text content of a tag like <target_code>12345</target_code>.
 */
function xmlText(xml, tag) {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Extract all occurrences of a tag block.
 * Returns an array of inner XML strings.
 */
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

// GET /v1/nikl/api-search?headword=...
router.get(
  "/v1/nikl/api-search",
  requireSession,
  requireEntitlement("approver:content"),
  async (req, res) => {
    try {
      const headword = (req.query.headword || "").trim();
      if (!headword) {
        return res.status(400).json({ ok: false, error: "MISSING_HEADWORD" });
      }
      if (!NIKL_API_KEY) {
        return res.status(503).json({ ok: false, error: "NIKL_API_KEY_NOT_CONFIGURED" });
      }

      const params = new URLSearchParams({
        key: NIKL_API_KEY,
        q: headword,
        method: "exact",
        part: "word",
        num: "20",
        translated: "y",
        trans_lang: "1", // English
      });

      const url = `${BASE_SEARCH_URL}?${params.toString()}`;
      const xml = await httpsGet(url);

      // Parse items from the search response XML
      const items = xmlBlocks(xml, "item");
      const entriesByCode = new Map();

      for (const itemXml of items) {
        const targetCode = parseInt(xmlText(itemXml, "target_code") || "0", 10);
        if (!targetCode) continue;

        const word = xmlText(itemXml, "word") || "";
        const posKo = xmlText(itemXml, "pos") || null;

        if (!entriesByCode.has(targetCode)) {
          entriesByCode.set(targetCode, {
            provider_target_code: targetCode,
            headword: word,
            pos_ko: posKo,
            senses: [],
          });
        }

        // Each <item> in search results corresponds to one sense
        const senseNo = parseInt(xmlText(itemXml, "sense_no") || "1", 10);
        const definitionKo = xmlText(itemXml, "definition") || "";

        // Parse translation blocks
        let transWordEn = null;
        let transDefEn = null;
        const transBlocks = xmlBlocks(itemXml, "translation");
        for (const tXml of transBlocks) {
          const lang = xmlText(tXml, "trans_lang") || "";
          if (lang === "영어" || lang === "English") {
            transWordEn = xmlText(tXml, "trans_word") || null;
            transDefEn = xmlText(tXml, "trans_dfn") || null;
            break;
          }
        }

        entriesByCode.get(targetCode).senses.push({
          sense_no: senseNo,
          definition_ko: definitionKo,
          trans_word_en: transWordEn,
          trans_definition_en: transDefEn,
          provider_target_code: targetCode,
        });
      }

      const entries = Array.from(entriesByCode.values());

      return res.json({ ok: true, entries });
    } catch (err) {
      console.error("nikl api-search GET failed:", err);
      return res.status(500).json({ ok: false, error: "INTERNAL" });
    }
  }
);

module.exports = router;
