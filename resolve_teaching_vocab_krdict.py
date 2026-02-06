#!/usr/bin/env python3
"""
Resolve teaching_vocab.canonical_ref for rows where it is NULL by selecting the best
KRDict lexical entry (krdict_lexical_entry_fast.source_entry_id) using OpenAI.

Key points (updated):
- English gloss is NOT in teaching_vocab; it comes from vocab_glosses (language='en', is_primary=true)
- We pass that gloss to the model as the primary disambiguation signal.
- canonical_ref is TEXT; we store chosen KRDict source_entry_id as string.

Env:
- Loads .env from: /Users/vernongibbs/Documents/DevProjects/IdeaVault/VGC/.env
- Needs: OPENAI_API_KEY and (DATABASE_URL or DATABASE_PUBLIC_URL)

Deps:
  pip install python-dotenv psycopg2-binary requests
Run:
  # dry run (no DB writes)
  KRDICT_RESOLVE_DRY_RUN=true python3 resolve_teaching_vocab_krdict.py

  # real run
  python3 resolve_teaching_vocab_krdict.py
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv


ENV_PATH = "/Users/vernongibbs/Documents/DevProjects/IdeaVault/VGC/.env"

# ---------- OpenAI ----------
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")  # override if you want
OPENAI_ENDPOINT = "https://api.openai.com/v1/responses"

# ---------- Behavior ----------
BATCH_SIZE = int(os.getenv("KRDICT_RESOLVE_BATCH_SIZE", "15"))
SLEEP_BETWEEN_CALLS_SEC = float(os.getenv("KRDICT_RESOLVE_SLEEP_SEC", "0.2"))
DRY_RUN = os.getenv("KRDICT_RESOLVE_DRY_RUN", "false").lower() in ("1", "true", "yes")
MAX_ROWS = int(os.getenv("KRDICT_RESOLVE_MAX_ROWS", "0"))  # 0 = no cap
LOG_PATH = os.getenv("KRDICT_RESOLVE_LOG_PATH", "krdict_resolve_log.jsonl")

# ---------- Tables ----------
TEACHING_TABLE = os.getenv("TEACHING_TABLE", "teaching_vocab")
GLOSSES_TABLE = os.getenv("GLOSSES_TABLE", "vocab_glosses")
KRDICT_TABLE = os.getenv("KRDICT_TABLE", "krdict_lexical_entry_fast")


@dataclass
class RowToResolve:
    vocab_id: str
    lemma: str
    topik_gloss: Optional[str]
    candidates: List[Dict[str, Any]]  # {krdict_id, pos, en_lemma}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_log(entry: Dict[str, Any]) -> None:
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def fetch_rows_to_resolve(cur) -> List[RowToResolve]:
    """
    Pull unresolved teaching vocab rows, join to vocab_glosses for TOPIK English gloss,
    and gather KRDict candidates by headword match.
    """
    sql = f"""
    SELECT
      tv.id::text AS vocab_id,
      tv.lemma::text AS lemma,
      vg.text::text AS topik_gloss,
      json_agg(
        json_build_object(
          'krdict_id', kd.source_entry_id::text,
          'pos', kd.pos,
          'en_lemma', kd.en_lemma
        )
        ORDER BY kd.source_entry_id
      ) AS candidates
    FROM public.{TEACHING_TABLE} tv
    LEFT JOIN public.{GLOSSES_TABLE} vg
      ON vg.vocab_id = tv.id
     AND vg.language = 'en'
     AND vg.is_primary = true
    JOIN public.{KRDICT_TABLE} kd
      ON kd.headword = tv.lemma
    WHERE tv.canonical_ref IS NULL
    GROUP BY tv.id, tv.lemma, vg.text
    ORDER BY tv.lemma;
    """
    cur.execute(sql)
    rows = []
    for r in cur.fetchall():
        candidates = r["candidates"] or []
        clean_candidates = [
            {
                "krdict_id": str(c.get("krdict_id")),
                "pos": c.get("pos"),
                "en_lemma": c.get("en_lemma"),
            }
            for c in candidates
        ]
        rows.append(
            RowToResolve(
                vocab_id=r["vocab_id"],
                lemma=r["lemma"],
                topik_gloss=r.get("topik_gloss"),
                candidates=clean_candidates,
            )
        )

    if MAX_ROWS and len(rows) > MAX_ROWS:
        rows = rows[:MAX_ROWS]
    return rows


def validate_choice(row: RowToResolve, chosen_id: str) -> None:
    candidate_ids = {c["krdict_id"] for c in row.candidates}
    if chosen_id not in candidate_ids:
        raise ValueError(
            f"Chosen krdict_id {chosen_id} not in candidates for vocab_id={row.vocab_id} lemma={row.lemma}"
        )


def update_canonical_ref(cur, vocab_id: str, chosen_krdict_id: str) -> None:
    sql = f"""
    UPDATE public.{TEACHING_TABLE}
    SET canonical_ref = %s
    WHERE id::text = %s;
    """
    cur.execute(sql, (chosen_krdict_id, vocab_id))


def openai_select_krdict_ids(api_key: str, batch: List[RowToResolve]) -> Dict[str, str]:
    """
    Returns mapping vocab_id -> chosen_krdict_id (as string)
    """

    items = []
    for r in batch:
        items.append(
            {
                "vocab_id": r.vocab_id,
                "lemma": r.lemma,
                "topik_gloss": r.topik_gloss,
                "candidates": r.candidates,
            }
        )

    system = (
        "You are selecting the correct KRDict lexical entry for TOPIK I teaching vocabulary.\n"
        "PRIMARY signal: topik_gloss (English teaching gloss).\n"
        "Choose exactly ONE candidate per item.\n"
        "Return JSON only in this exact schema:\n"
        '{ "selections": [ {"vocab_id":"...","krdict_id":"..."}, ... ] }\n'
        "Rules:\n"
        "- krdict_id MUST be one of the candidate krdict_id values.\n"
        "- Prefer the candidate whose en_lemma best matches topik_gloss.\n"
        "- If topik_gloss is missing, use the most common everyday meaning (TOPIK I).\n"
        "- No extra keys. No explanations."
    )

    req_body = {
        "model": OPENAI_MODEL,
        "input": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"level": "TOPIK I", "items": items}, ensure_ascii=False)},
        ],

    }

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    resp = requests.post(OPENAI_ENDPOINT, headers=headers, data=json.dumps(req_body))
    if resp.status_code >= 300:
        raise RuntimeError(f"OpenAI API error {resp.status_code}: {resp.text[:800]}")

    data = resp.json()

    # Extract output_text
    text = ""
    for item in data.get("output", []):
        for c in item.get("content", []):
            if c.get("type") in ("output_text", "text"):
                text += c.get("text", "")

    text = text.strip()
    if not text:
        raise RuntimeError("OpenAI returned empty output text")

    try:
        out = json.loads(text)
    except Exception:
        # best-effort JSON substring recovery
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            out = json.loads(text[start : end + 1])
        else:
            raise

    selections = out.get("selections", [])
    result: Dict[str, str] = {}
    for s in selections:
        result[str(s["vocab_id"])] = str(s["krdict_id"])
    return result


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
            rows = fetch_rows_to_resolve(cur)
            total = len(rows)
            print(f"Rows to resolve (canonical_ref IS NULL): {total}")
            if total == 0:
                return

            resolved = 0
            idx = 0
            while idx < total:
                batch = rows[idx : idx + BATCH_SIZE]
                idx += BATCH_SIZE

                selections = openai_select_krdict_ids(api_key, batch)

                for r in batch:
                    chosen = selections.get(r.vocab_id)
                    if not chosen:
                        raise RuntimeError(f"Missing selection for vocab_id={r.vocab_id} lemma={r.lemma}")

                    validate_choice(r, chosen)

                    log_entry = {
                        "ts": utc_now_iso(),
                        "vocab_id": r.vocab_id,
                        "lemma": r.lemma,
                        "topik_gloss": r.topik_gloss,
                        "chosen_krdict_id": chosen,
                        "candidates": r.candidates,
                        "model": OPENAI_MODEL,
                        "dry_run": DRY_RUN,
                    }
                    append_log(log_entry)

                    if not DRY_RUN:
                        update_canonical_ref(cur, r.vocab_id, chosen)

                    resolved += 1

                if not DRY_RUN:
                    conn.commit()

                print(f"Resolved {resolved}/{total}")
                time.sleep(SLEEP_BETWEEN_CALLS_SEC)

        with conn.cursor() as cur2:
            cur2.execute(f"SELECT COUNT(*) FROM public.{TEACHING_TABLE} WHERE canonical_ref IS NULL;")
            remaining = cur2.fetchone()[0]
            print(f"Remaining unresolved: {remaining}")

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()