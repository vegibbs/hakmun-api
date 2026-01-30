// FILE: hakmun-api/routes/dictionary_sets.js
// PURPOSE: Generic dictionary sets endpoints (no per-dataset endpoints)
// ENDPOINTS:
//   GET /v1/dictionary/sets
//   GET /v1/dictionary/sets/:set_id/items
//
// Set ID scheme (v0):
//   - teaching:ALL@<SNAPSHOT_VERSION>                 (Teaching Vocabulary universe, evolving)
//   - teaching:<SET_CODE>@<SNAPSHOT_VERSION>          (Fixed ordered lists like TOPIK_I)
//   - my_pins
//   - my_vocab
//
// Notes:
// - No schema changes.
// - For teaching:ALL, we return a deterministic ordinal (row_number by lemma) for UI numbering.
// - For teaching:<SET_CODE>, we use the stored ordinal from teaching_vocab_set_items.

const express = require("express");
const router = express.Router();

const { requireSession } = require("../auth/session");
const db = require("../db/pool");

function getUserId(req) {
  return req.user?.userID || req.userID || req.user?.user_id || null;
}

function dbQuery(sql, params) {
  if (db && typeof db.query === "function") return db.query(sql, params);
  if (db && db.pool && typeof db.pool.query === "function") return db.pool.query(sql, params);
  throw new Error("db/pool export does not provide query()");
}

function parseSetId(setId) {
  if (setId === "my_pins") return { kind: "my_pins" };
  if (setId === "my_vocab") return { kind: "my_vocab" };

  // teaching:<SET_CODE>@<SNAPSHOT_VERSION>
  if (setId.startsWith("teaching:")) {
    const rest = setId.slice("teaching:".length);
    const at = rest.lastIndexOf("@");
    if (at <= 0 || at === rest.length - 1) return null;
    const setCode = rest.slice(0, at);
    const snapshot = rest.slice(at + 1);
    return { kind: "teaching", setCode, snapshot };
  }

  return null;
}

// GET /v1/dictionary/sets
router.get("/v1/dictionary/sets", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    // Choose the "current" snapshot for teaching sets.
    // We use the max snapshot_version present in teaching_vocab_set_items.
    const snapSql = `SELECT MAX(snapshot_version) AS snapshot_version FROM teaching_vocab_set_items`;
    const snapRes = await dbQuery(snapSql, []);
    const currentSnapshot = snapRes.rows?.[0]?.snapshot_version || "2026-01";

    // Fixed teaching sets (distinct set_code + snapshot_version)
    const teachingSql = `
      SELECT DISTINCT set_code, snapshot_version
      FROM teaching_vocab_set_items
      ORDER BY set_code, snapshot_version
    `;
    const teaching = await dbQuery(teachingSql, []);

    // Teaching Vocabulary (All) is a separate concept from fixed lists.
    const teachingAllSet = {
      set_id: `teaching:ALL@${currentSnapshot}`,
      kind: "teaching",
      title: "Teaching Vocabulary",
      subtitle: `All words • ${currentSnapshot}`,
      set_code: "ALL",
      snapshot_version: currentSnapshot,
    };

    const teachingSets = (teaching.rows || []).map((r) => ({
      set_id: `teaching:${r.set_code}@${r.snapshot_version}`,
      kind: "teaching",
      // Title is the list name, not "Teaching Vocabulary — X"
      title: r.set_code.replace(/_/g, " "),
      subtitle: `Teaching list • ${r.snapshot_version}`,
      set_code: r.set_code,
      snapshot_version: r.snapshot_version,
    }));

    // Always-present user sets
    const userSets = [
      {
        set_id: "my_pins",
        kind: "my_pins",
        title: "My Dictionary",
        subtitle: "Pinned terms",
      },
      {
        set_id: "my_vocab",
        kind: "my_vocab",
        title: "My Vocabulary",
        subtitle: "Exposure list",
      },
    ];

    // Put Teaching Vocabulary (All) first, then teaching lists, then user sets.
    return res.json({ ok: true, sets: [teachingAllSet, ...teachingSets, ...userSets] });
  } catch (err) {
    console.error("dictionary sets GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

// GET /v1/dictionary/sets/:set_id/items
router.get("/v1/dictionary/sets/:set_id/items", requireSession, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "NO_SESSION" });

    const setId = req.params.set_id;
    const parsed = parseSetId(setId);
    if (!parsed) return res.status(400).json({ ok: false, error: "INVALID_SET_ID" });

    if (parsed.kind === "teaching") {
      const { setCode, snapshot } = parsed;

      // Teaching Vocabulary (All): all teaching_vocab rows (evolving).
      if (setCode === "ALL") {
        const sql = `
          SELECT
            ROW_NUMBER() OVER (ORDER BY tv.lemma) AS ordinal,
            tv.id AS vocab_id,
            tv.lemma,
            tv.part_of_speech,
            tv.pos_code,
            tv.pos_label,
            vg.text AS gloss_en
          FROM teaching_vocab tv
          LEFT JOIN vocab_glosses vg
            ON vg.vocab_id = tv.id
           AND vg.language = 'en'
           AND vg.is_primary = true
          ORDER BY tv.lemma
          LIMIT 50000
        `;
        const { rows } = await dbQuery(sql, []);
        return res.json({
          ok: true,
          set_id: setId,
          kind: "teaching",
          snapshot_version: snapshot,
          items: rows || [],
        });
      }

      // Fixed teaching lists (TOPIK_I etc.) use stored ordinal.
      const sql = `
        SELECT
          i.ordinal,
          tv.id AS vocab_id,
          tv.lemma,
          tv.part_of_speech,
          tv.pos_code,
          tv.pos_label,
          vg.text AS gloss_en
        FROM teaching_vocab_set_items i
        JOIN teaching_vocab tv ON tv.id = i.vocab_id
        LEFT JOIN vocab_glosses vg
          ON vg.vocab_id = tv.id
         AND vg.language = 'en'
         AND vg.is_primary = true
        WHERE i.set_code = $1::text
          AND i.snapshot_version = $2::text
        ORDER BY i.ordinal
      `;
      const { rows } = await dbQuery(sql, [setCode, snapshot]);

      return res.json({
        ok: true,
        set_id: setId,
        kind: "teaching",
        snapshot_version: snapshot,
        items: rows || [],
      });
    }

    if (parsed.kind === "my_pins") {
      const sql = `
        SELECT
          p.created_at,
          p.headword,
          p.vocab_id,
          tv.lemma,
          tv.part_of_speech,
          tv.pos_code,
          tv.pos_label,
          vg.text AS gloss_en
        FROM user_dictionary_pins p
        LEFT JOIN teaching_vocab tv
          ON tv.id = p.vocab_id
        LEFT JOIN vocab_glosses vg
          ON vg.vocab_id = tv.id
         AND vg.language = 'en'
         AND vg.is_primary = true
        WHERE p.user_id = $1::uuid
        ORDER BY p.created_at DESC
      `;
      const { rows } = await dbQuery(sql, [userId]);

      return res.json({
        ok: true,
        set_id: setId,
        kind: "my_pins",
        items: rows || [],
      });
    }

    if (parsed.kind === "my_vocab") {
      const sql = `
        SELECT
          uvi.lemma,
          uvi.vocab_id,
          uvi.first_seen_at,
          uvi.last_seen_at,
          uvi.seen_count,
          uvi.rotation_level_computed,
          uvi.rotation_level_override,
          uvi.status,

          tv.part_of_speech,
          tv.pos_code,
          tv.pos_label,
          vg.text AS gloss_en
        FROM user_vocab_items uvi
        LEFT JOIN teaching_vocab tv
          ON tv.id = uvi.vocab_id
        LEFT JOIN vocab_glosses vg
          ON vg.vocab_id = tv.id
         AND vg.language = 'en'
         AND vg.is_primary = true
        WHERE uvi.user_id = $1::uuid
          AND uvi.is_archived = false
        ORDER BY uvi.last_seen_at DESC
        LIMIT 1000
      `;
      const { rows } = await dbQuery(sql, [userId]);

      return res.json({
        ok: true,
        set_id: setId,
        kind: "my_vocab",
        items: rows || [],
      });
    }

    return res.status(400).json({ ok: false, error: "UNSUPPORTED_SET_KIND" });
  } catch (err) {
    console.error("dictionary set items GET failed:", err);
    return res.status(500).json({ ok: false, error: "INTERNAL" });
  }
});

module.exports = router;