#!/usr/bin/env python3
"""
Split-aware KRDict linker for HakMun TOPIK teaching vocab (FULL FILE REWRITE).

Fix included:
- Handles Unicode normalization mismatches (NFC vs NFD) between teaching_vocab.lemma and krdict headword.
  We query candidates using BOTH NFC and NFD variants of each lemma.

WHAT THIS SCRIPT DOES:
- Reads teaching_vocab rows + primary EN gloss from vocab_glosses
- Pulls KRDict candidates for each lemma (match by normalized lemma key)
- Uses OpenAI to return 1+ senses per row
- If 1 sense: updates existing row canonical_ref + rewrites primary EN gloss
- If >1 sense: updates existing row for sense #1, then inserts new teaching_vocab rows + gloss rows
- Logs every decision + DB action to JSONL

ENV:
- /Users/vernongibbs/Documents/DevProjects/IdeaVault/VGC/.env
- OPENAI_API_KEY
- DATABASE_URL or DATABASE_PUBLIC_URL

DEPS:
  pip install python-dotenv psycopg2-binary requests

RUN:
  KRDICT_RESOLVE_DRY_RUN=true python3 resolve_teaching_vocab_krdict_split.py
  python3 resolve_teaching_vocab_krdict_split.py
"""

from __future__ import annotations

import json
import os
import time
import uuid
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2.extras import RealDictCursor
import requests
from dotenv import load_dotenv


# -----------------------
# CONFIG
# -----------------------
ENV_PATH = "/Users/vernongibbs/Documents/DevProjects/IdeaVault/VGC/.env"

TEACHING_TABLE = os.getenv("TEACHING_TABLE", "teaching_vocab")
GLOSSES_TABLE = os.getenv("GLOSSES_TABLE", "vocab_glosses")
KRDICT_TABLE = os.getenv("KRDICT_TABLE", "krdict_lexical_entry_fast")

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
OPENAI_ENDPOINT = "https://api.openai.com/v1/responses"

BATCH_SIZE = int(os.getenv("KRDICT_RESOLVE_BATCH_SIZE", "10"))
SLEEP_BETWEEN_CALLS_SEC = float(os.getenv("KRDICT_RESOLVE_SLEEP_SEC", "0.2"))

DRY_RUN = os.getenv("KRDICT_RESOLVE_DRY_RUN", "false").lower() in ("1", "true", "yes")
MAX_ROWS = int(os.getenv("KRDICT_RESOLVE_MAX_ROWS", "0"))  # 0 = no cap

# MODE:
# - "unlinked": only rows where canonical_ref IS NULL
# - "needs_work": rows where canonical_ref IS NULL OR gloss contains "," OR "~"
MODE = os.getenv("KRDICT_RESOLVE_MODE", "needs_work").strip().lower()

LOG_PATH = os.getenv("KRDICT_RESOLVE_LOG_PATH", "krdict_resolve_log.jsonl")


# -----------------------
# HELPERS
# -----------------------
def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def nfd(s: str) -> str:
    return unicodedata.normalize("NFD", s)


def lemma_key(raw: str) -> str:
    # match key used throughout: trim + NFC
    return nfc(raw.strip())


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_log(entry: Dict[str, Any]) -> None:
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# -----------------------
# DATA TYPES
# -----------------------
@dataclass
class TeachingRow:
    vocab_id: str
    lemma_raw: str
    lemma_key: str
    part_of_speech: Optional[str]
    level: Optional[str]
    tags: Any
    status: Optional[str]
    canonical_ref: Optional[str]
    pos_code: Optional[str]
    pos_label: Optional[str]
    gloss_en: Optional[str]
    has_primary_en_gloss: bool


@dataclass
class Candidate:
    krdict_id: str
    pos: Optional[str]
    en_lemma: Optional[str]


# -----------------------
# DB QUERIES
# -----------------------
def fetch_teaching_rows(cur) -> List[TeachingRow]:
    where = "tv.canonical_ref IS NULL" if MODE == "unlinked" else "(tv.canonical_ref IS NULL OR vg.text LIKE '%,%' OR vg.text LIKE '%~%')"

    sql = f"""
    SELECT
      tv.id::text AS vocab_id,
      tv.lemma::text AS lemma_raw,

      tv.part_of_speech,
      tv.level,
      tv.tags,
      tv.status,
      tv.canonical_ref,
      tv.pos_code,
      tv.pos_label,

      vg.text AS gloss_en,
      (vg.vocab_id IS NOT NULL) AS has_primary_en_gloss
    FROM public.{TEACHING_TABLE} tv
    LEFT JOIN public.{GLOSSES_TABLE} vg
      ON vg.vocab_id = tv.id
     AND vg.language = 'en'
     AND vg.is_primary = true
    WHERE {where}
    ORDER BY tv.lemma;
    """
    cur.execute(sql)
    rows: List[TeachingRow] = []
    for r in cur.fetchall():
        raw = r["lemma_raw"] or ""
        rows.append(
            TeachingRow(
                vocab_id=r["vocab_id"],
                lemma_raw=raw,
                lemma_key=lemma_key(raw),
                part_of_speech=r.get("part_of_speech"),
                level=r.get("level"),
                tags=r.get("tags"),
                status=r.get("status"),
                canonical_ref=r.get("canonical_ref"),
                pos_code=r.get("pos_code"),
                pos_label=r.get("pos_label"),
                gloss_en=r.get("gloss_en"),
                has_primary_en_gloss=bool(r.get("has_primary_en_gloss")),
            )
        )
    if MAX_ROWS and len(rows) > MAX_ROWS:
        return rows[:MAX_ROWS]
    return rows


def build_variant_list(keys: List[str]) -> List[str]:
    """
    For each lemma key (trim+NFC), generate query variants to match whatever normalization is stored in DB.
    """
    variants: List[str] = []
    seen = set()
    for k in keys:
        for v in (k, nfd(k), nfc(k)):
            vv = v.strip()
            if vv and vv not in seen:
                seen.add(vv)
                variants.append(vv)
    return variants


def fetch_candidates_for_lemma_keys(cur, keys: List[str]) -> Dict[str, List[Candidate]]:
    """
    Fetch candidates for lemma keys.
    We query krdict by btrim(headword) in BOTH NFC and NFD variants (generated in build_variant_list).

    Returns mapping: lemma_key (NFC) -> candidates
    """
    variants = build_variant_list(keys)

    sql = f"""
    SELECT
      kd.source_entry_id::text AS krdict_id,
      kd.pos,
      kd.en_lemma,
      kd.headword::text AS headword_raw
    FROM public.{KRDICT_TABLE} kd
    WHERE btrim(kd.headword) = ANY(%s);
    """
    cur.execute(sql, (variants,))
    out: Dict[str, List[Candidate]] = {}

    for r in cur.fetchall():
        hw_raw = (r.get("headword_raw") or "").strip()
        k = lemma_key(hw_raw)  # normalize fetched headword to match key space
        out.setdefault(k, []).append(
            Candidate(
                krdict_id=r["krdict_id"],
                pos=r.get("pos"),
                en_lemma=r.get("en_lemma"),
            )
        )

    for k in out:
        out[k].sort(key=lambda c: int(c.krdict_id) if c.krdict_id.isdigit() else c.krdict_id)

    return out


def upsert_primary_en_gloss(cur, vocab_id: str, text: str) -> None:
    sql_update = f"""
    UPDATE public.{GLOSSES_TABLE}
    SET text = %s
    WHERE vocab_id = %s::uuid
      AND language = 'en'
      AND is_primary = true;
    """
    cur.execute(sql_update, (text, vocab_id))
    if cur.rowcount == 0:
        sql_insert = f"""
        INSERT INTO public.{GLOSSES_TABLE} (vocab_id, language, text, is_primary)
        VALUES (%s::uuid, 'en', %s, true);
        """
        cur.execute(sql_insert, (vocab_id, text))


def update_canonical_ref(cur, vocab_id: str, krdict_id: str) -> None:
    sql = f"""
    UPDATE public.{TEACHING_TABLE}
    SET canonical_ref = %s,
        updated_at = now()
    WHERE id = %s::uuid;
    """
    cur.execute(sql, (krdict_id, vocab_id))


def insert_new_teaching_vocab_row(cur, src: TeachingRow, canonical_ref: str) -> str:
    new_id = str(uuid.uuid4())
    sql = f"""
    INSERT INTO public.{TEACHING_TABLE} (
      id, lemma, part_of_speech, level, tags, status, canonical_ref,
      created_at, updated_at, pos_code, pos_label
    )
    VALUES (
      %s::uuid,
      %s,
      %s,
      %s,
      %s,
      %s,
      %s,
      now(),
      now(),
      %s,
      %s
    );
    """
    cur.execute(
        sql,
        (
            new_id,
            src.lemma_raw,  # preserve stored lemma as-is
            src.part_of_speech,
            src.level,
            src.tags,
            src.status,
            canonical_ref,
            src.pos_code,
            src.pos_label,
        ),
    )
    return new_id


# -----------------------
# OPENAI CALL
# -----------------------
def openai_split_select(api_key: str, batch_rows: List[TeachingRow], candidates_by_key: Dict[str, List[Candidate]]) -> Dict[str, Any]:
    items = []
    for r in batch_rows:
        cands = candidates_by_key.get(r.lemma_key, [])
        items.append(
            {
                "vocab_id": r.vocab_id,
                "lemma": r.lemma_key,
                "gloss_en": r.gloss_en,
                "candidates": [{"krdict_id": c.krdict_id, "pos": c.pos, "en_lemma": c.en_lemma} for c in cands],
            }
        )

    system = (
        "You are resolving Korean TOPIK teaching vocabulary items to KRDict senses.\n"
        "For each item, output 1 or more SENSES.\n"
        "Each sense MUST map to exactly one candidate krdict_id from the provided candidate list.\n"
        "Only split into multiple senses if you can assign a DISTINCT candidate krdict_id to each sense.\n"
        "Use gloss_en as the primary signal. gloss_en may contain comma-separated synonyms or multiple meanings.\n"
        "Split only when multiple meanings correspond to distinct candidates. Otherwise keep ONE sense.\n"
        "Return JSON only. No explanations.\n"
    )

    req_body = {
        "model": OPENAI_MODEL,
        "input": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"level": "TOPIK I", "items": items}, ensure_ascii=False)},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "krdict_split_selection",
                "schema": {
                    "type": "object",
                    "properties": {
                        "results": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "vocab_id": {"type": "string"},
                                    "lemma": {"type": "string"},
                                    "senses": {
                                        "type": "array",
                                        "minItems": 1,
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "sense_label": {"type": "string"},
                                                "gloss_en": {"type": "string"},
                                                "krdict_id": {"type": "string"},
                                            },
                                            "required": ["sense_label", "gloss_en", "krdict_id"],
                                            "additionalProperties": False,
                                        },
                                    },
                                },
                                "required": ["vocab_id", "lemma", "senses"],
                                "additionalProperties": False,
                            },
                        }
                    },
                    "required": ["results"],
                    "additionalProperties": False,
                },
                "strict": True,
            }
        },
    }

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    resp = requests.post(OPENAI_ENDPOINT, headers=headers, data=json.dumps(req_body))
    if resp.status_code >= 300:
        raise RuntimeError(f"OpenAI API error {resp.status_code}: {resp.text[:1200]}")

    data = resp.json()

    text = ""
    for item in data.get("output", []):
        for c in item.get("content", []):
            if c.get("type") in ("output_text", "text"):
                text += c.get("text", "")

    text = text.strip()
    if not text:
        raise RuntimeError("OpenAI returned empty output text")

    try:
        return json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


def validate_model_output(
    out: Dict[str, Any],
    batch_rows: List[TeachingRow],
    candidates_by_key: Dict[str, List[Candidate]],
) -> Dict[str, List[Dict[str, str]]]:
    batch_vocab_ids = {r.vocab_id for r in batch_rows}
    row_by_id = {r.vocab_id: r for r in batch_rows}

    results = out.get("results", [])
    mapping: Dict[str, List[Dict[str, str]]] = {}

    for entry in results:
        vid = str(entry["vocab_id"])
        if vid not in batch_vocab_ids:
            raise ValueError(f"Model returned vocab_id not in batch: {vid}")

        row = row_by_id[vid]
        cand_ids = {c.krdict_id for c in candidates_by_key.get(row.lemma_key, [])}
        senses = entry["senses"]
        if not senses:
            raise ValueError(f"Model returned empty senses for vocab_id={vid}")

        used: set[str] = set()
        out_senses: List[Dict[str, str]] = []
        for s in senses:
            kid = str(s["krdict_id"])
            if kid not in cand_ids:
                raise ValueError(f"Model chose krdict_id not in candidates: vocab_id={vid} lemma={row.lemma_key} krdict_id={kid}")
            if kid in used:
                raise ValueError(f"Model repeated krdict_id within senses: vocab_id={vid} krdict_id={kid}")
            used.add(kid)
            out_senses.append(
                {
                    "sense_label": str(s["sense_label"]).strip(),
                    "gloss_en": str(s["gloss_en"]).strip(),
                    "krdict_id": kid,
                }
            )
        mapping[vid] = out_senses

    missing = [r.vocab_id for r in batch_rows if r.vocab_id not in mapping]
    if missing:
        raise RuntimeError(f"Model did not return results for vocab_id(s): {missing[:10]}{'...' if len(missing)>10 else ''}")

    return mapping


# -----------------------
# MAIN
# -----------------------
def main() -> None:
    load_dotenv(ENV_PATH)

    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("OPENAI_API_KEY missing in env/.env")

    db_url = (os.getenv("DATABASE_URL") or os.getenv("DATABASE_PUBLIC_URL") or "").strip()
    if not db_url:
        raise SystemExit("DATABASE_URL or DATABASE_PUBLIC_URL missing in env/.env")

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            rows = fetch_teaching_rows(cur)
            total = len(rows)
            print(f"Rows to process (MODE={MODE}): {total}")
            if total == 0:
                return

            processed = 0
            idx = 0

            while idx < total:
                batch = rows[idx : idx + BATCH_SIZE]
                idx += BATCH_SIZE

                keys = sorted({r.lemma_key for r in batch})
                candidates_by_key = fetch_candidates_for_lemma_keys(cur, keys)

                no_cands = [r.lemma_key for r in batch if not candidates_by_key.get(r.lemma_key)]
                if no_cands:
                    append_log(
                        {
                            "ts": utc_now_iso(),
                            "dry_run": DRY_RUN,
                            "error": "NO_KRDICT_CANDIDATES",
                            "lemmas": sorted(set(no_cands))[:200],
                        }
                    )
                    raise RuntimeError(f"No KRDict candidates for lemma(s): {sorted(set(no_cands))[:20]}")

                out = openai_split_select(api_key, batch, candidates_by_key)
                mapping = validate_model_output(out, batch, candidates_by_key)

                batch_log: Dict[str, Any] = {
                    "ts": utc_now_iso(),
                    "dry_run": DRY_RUN,
                    "model": OPENAI_MODEL,
                    "mode": MODE,
                    "batch_size": len(batch),
                    "actions": [],
                }

                for r in batch:
                    senses = mapping[r.vocab_id]
                    if len(senses) == 1:
                        s0 = senses[0]
                        batch_log["actions"].append(
                            {
                                "vocab_id": r.vocab_id,
                                "lemma_raw": r.lemma_raw,
                                "lemma_key": r.lemma_key,
                                "action": "single",
                                "set_canonical_ref": s0["krdict_id"],
                                "set_gloss_en": s0["gloss_en"],
                            }
                        )
                        if not DRY_RUN:
                            update_canonical_ref(cur, r.vocab_id, s0["krdict_id"])
                            upsert_primary_en_gloss(cur, r.vocab_id, s0["gloss_en"])
                    else:
                        s0 = senses[0]
                        inserts: List[Dict[str, str]] = []
                        batch_log["actions"].append(
                            {
                                "vocab_id": r.vocab_id,
                                "lemma_raw": r.lemma_raw,
                                "lemma_key": r.lemma_key,
                                "action": "split",
                                "primary": s0,
                                "inserts": inserts,
                            }
                        )
                        if not DRY_RUN:
                            update_canonical_ref(cur, r.vocab_id, s0["krdict_id"])
                            upsert_primary_en_gloss(cur, r.vocab_id, s0["gloss_en"])

                            for extra in senses[1:]:
                                new_id = insert_new_teaching_vocab_row(cur, r, extra["krdict_id"])
                                upsert_primary_en_gloss(cur, new_id, extra["gloss_en"])
                                inserts.append(
                                    {
                                        "new_vocab_id": new_id,
                                        "krdict_id": extra["krdict_id"],
                                        "gloss_en": extra["gloss_en"],
                                        "sense_label": extra["sense_label"],
                                    }
                                )

                append_log(batch_log)

                if not DRY_RUN:
                    conn.commit()

                processed += len(batch)
                print(f"Processed {processed}/{total}")
                time.sleep(SLEEP_BETWEEN_CALLS_SEC)

        with conn.cursor() as cur2:
            cur2.execute(f"SELECT COUNT(*) FROM public.{TEACHING_TABLE} WHERE canonical_ref IS NULL;")
            remaining = cur2.fetchone()[0]
            print(f"Remaining canonical_ref IS NULL: {remaining}")

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()