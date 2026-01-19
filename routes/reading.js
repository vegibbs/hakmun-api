// routes/reading.js — HakMun API (v0.12)
// Reading item creation (v0) + global reading coverage (registry-gated)

const express = require("express");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const { logger } = require("../util/log");
const { withTimeout } = require("../util/time");
const { requireSession } = require("../auth/session");

const router = express.Router();

/* ------------------------------------------------------------------
   REGISTRY EPIC 4 — Reading Item Creation (v0, minimal write surface)
   - Creates a Reading item (module table) AND its registry row (personal + active)
   - No audio attachment, no sharing, no promotion
   - Deterministic: single TX; fail-fast timeouts; no partial creates
------------------------------------------------------------------ */

// POST /v1/reading/items
// Body: { text, language?, notes?, unit_type? }
router.post("/v1/reading/items", requireSession, async (req, res) => {
  const rid = req._rid;

  try {
    const ownerUserID = req.user.userID;

    const text = String(req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    const language = String(req.body?.language || "ko").trim().slice(0, 32) || "ko";
    const notesRaw = req.body?.notes !== undefined ? String(req.body.notes).trim() : "";
    const notes = notesRaw ? notesRaw.slice(0, 500) : null;

    const unitTypeRaw = req.body?.unit_type !== undefined ? String(req.body.unit_type).trim() : "";
    const unitType = unitTypeRaw ? unitTypeRaw.slice(0, 32) : "sentence";

    const readingItemID = crypto.randomUUID();

    const client = await pool.connect();
    try {
      await client.query(`set statement_timeout = 8000;`);
      await client.query(`set lock_timeout = 2000;`);
      await client.query("BEGIN");

      // 1) Create module item (Reading)
      await client.query(
        `
        insert into reading_items (
          reading_item_id,
          unit_type,
          text,
          language,
          notes
        )
        values ($1, $2, $3, $4, $5)
        `,
        [readingItemID, unitType, text, language, notes]
      );

      // 2) Create registry row (personal + active)
      await client.query(
        `
        insert into library_registry_items (
          content_type,
          content_id,
          owner_user_id,
          audience,
          global_state,
          operational_status
        )
        values ('reading_item', $1, $2, 'personal', null, 'active')
        on conflict (content_type, content_id) do nothing
        `,
        [readingItemID, ownerUserID]
      );

      // 3) Return registry-backed response
      const reg = await client.query(
        `
        select
          id as registry_item_id,
          content_type,
          content_id,
          audience,
          global_state,
          operational_status,
          owner_user_id,
          created_at,
          updated_at
        from library_registry_items
        where content_type = 'reading_item'
          and content_id = $1
        limit 1
        `,
        [readingItemID]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        reading_item: {
          reading_item_id: readingItemID,
          unit_type: unitType,
          text,
          language,
          notes
        },
        registry_item: reg.rows?.[0] || null
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/reading/items] failed", { rid, err: msg });

    if (String(err?.code || "") === "42P01") {
      // undefined_table
      return res.status(501).json({ error: "reading items table not implemented on server" });
    }

    if (msg.includes("timeout:") || msg.includes("statement timeout") || msg.includes("lock timeout")) {
      return res.status(503).json({ error: "db timeout" });
    }

    return res.status(500).json({ error: "create reading item failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 4 — Personal Reading Items (read surface)
   - Lists the caller's personal Reading items (text included)
   - Registry-gated: only items with registry row active are served
   - No global items, no sharing surfaces
------------------------------------------------------------------ */

// GET /v1/reading/items — personal reading items owned by the caller
router.get("/v1/reading/items", requireSession, async (req, res) => {
  const rid = req._rid;

  try {
    const ownerUserID = req.user.userID;

    const r = await withTimeout(
      pool.query(
        `
        select
          ri.reading_item_id,
          ri.unit_type,
          ri.text,
          ri.language,
          ri.notes,
          ri.created_at,
          ri.updated_at,

          lri.id as registry_item_id,
          lri.content_type,
          lri.content_id,
          lri.audience,
          lri.global_state,
          lri.operational_status,
          lri.owner_user_id

        from reading_items ri
        join library_registry_items lri
          on lri.content_type = 'reading_item'
         and lri.content_id = ri.reading_item_id

        where lri.owner_user_id = $1
          and lri.audience = 'personal'
          and lri.operational_status = 'active'

        order by ri.created_at desc
        limit 500
        `,
        [ownerUserID]
      ),
      8000,
      "db-list-reading-items-personal"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/reading/items GET] failed", { rid, err: msg });

    if (String(err?.code || "") === "42P01") {
      // undefined_table
      return res.status(501).json({ error: "reading items table not implemented on server" });
    }

    if (
      msg.startsWith("timeout:db-list-reading-items-personal") ||
      msg.includes("statement timeout") ||
      msg.includes("lock timeout")
    ) {
      logger.error("timeout:db-list-reading-items-personal", { rid });
      return res.status(503).json({ error: "db timeout listing personal reading items" });
    }

    return res.status(500).json({ error: "list reading items failed" });
  }
});

/* ------------------------------------------------------------------
   REGISTRY EPIC 1 — Reading Coverage (registry-gated read surface)
   - Coverage applies ONLY to global + active items
   - Global state: preliminary | approved
   - Under Review items are excluded
------------------------------------------------------------------ */

// GET /v1/reading-items/coverage — global reading items with variant matrix
router.get("/v1/reading-items/coverage", requireSession, async (req, res) => {
  try {
    const r = await withTimeout(
      pool.query(
        `
        select
          ric.reading_item_id,
          ric.unit_type,
          ric.text,
          ric.language,
          ric.notes,
          ric.created_at,
          ric.updated_at,

          ric.female_slow_asset_id,
          ric.female_moderate_asset_id,
          ric.female_native_asset_id,

          ric.male_slow_asset_id,
          ric.male_moderate_asset_id,
          ric.male_native_asset_id,

          ric.variants_count
        from reading_items_coverage ric
        join library_registry_items lri
          on lri.content_type = 'reading_item'
         and lri.content_id = ric.reading_item_id
        where lri.audience = 'global'
          and lri.operational_status = 'active'
          and lri.global_state in ('preliminary', 'approved')
        order by ric.created_at desc
        limit 500
        `
      ),
      8000,
      "db-list-reading-coverage-global"
    );

    return res.json({ items: r.rows || [] });
  } catch (err) {
    const msg = String(err?.message || err);
    logger.error("[/v1/reading-items/coverage] failed", { rid: req._rid, err: msg });

    if (msg.startsWith("timeout:db-list-reading-coverage-global")) {
      logger.error("timeout:db-list-reading-coverage-global", { rid: req._rid });
      return res.status(503).json({ error: "db timeout listing reading coverage" });
    }

    return res.status(500).json({ error: "list reading coverage failed" });
  }
});

module.exports = router;