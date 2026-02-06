#!/usr/bin/env python3
# nikl_fetch_view.py
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Optional, Tuple
from urllib.parse import urlencode

import boto3
import psycopg2
import psycopg2.extras
import requests
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv

BASE_VIEW_URL = "https://krdict.korean.go.kr/api/view"


def utcstamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def s3_client():
    endpoint = (os.environ.get("OBJECT_STORAGE_ENDPOINT") or "").strip()
    access_key = (os.environ.get("OBJECT_STORAGE_ACCESS_KEY_ID") or "").strip()
    secret_key = (os.environ.get("OBJECT_STORAGE_SECRET_ACCESS_KEY") or "").strip()
    region = (os.environ.get("OBJECT_STORAGE_REGION") or "auto").strip()

    missing = [k for k, v in [
        ("OBJECT_STORAGE_ENDPOINT", endpoint),
        ("OBJECT_STORAGE_ACCESS_KEY_ID", access_key),
        ("OBJECT_STORAGE_SECRET_ACCESS_KEY", secret_key),
    ] if not v]
    if missing:
        raise RuntimeError(f"Missing object storage env vars: {', '.join(missing)}")

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=BotoConfig(signature_version="s3v4"),
    )


def upload_xml(s3, object_key: str, xml_bytes: bytes) -> None:
    bucket = (os.environ.get("OBJECT_STORAGE_BUCKET") or "").strip()
    if not bucket:
        raise RuntimeError("Missing OBJECT_STORAGE_BUCKET")
    s3.put_object(
        Bucket=bucket,
        Key=object_key,
        Body=xml_bytes,
        ContentType="application/xml; charset=utf-8",
    )


def object_key_for_view(target_code: int, snapshot_id: str, fetched_at: str) -> str:
    return f"nikl/xml/view/target_code={target_code}/{fetched_at}_{snapshot_id}.xml"


def build_view_url(api_key: str, target_code: int, translated: str, trans_lang: str) -> str:
    params = {
        "key": api_key,
        "method": "target_code",
        "q": str(target_code),
        "translated": translated,
        "trans_lang": trans_lang,
    }
    return BASE_VIEW_URL + "?" + urlencode(params, safe=",:", encoding="utf-8")


def db_conn():
    db_url = (os.environ.get("DATABASE_URL") or "").strip()
    if not db_url:
        raise RuntimeError("Missing DATABASE_URL")
    return psycopg2.connect(db_url)


def db_count(cur, sql: str) -> int:
    cur.execute(sql)
    return int(cur.fetchone()[0])


def main() -> int:
    ap = argparse.ArgumentParser(description="Railway-safe NIKL /api/view runner: target_codes from Postgres, snapshots to Postgres, XML to bucket.")
    ap.add_argument("--limit", type=int, default=0, help="Max new views to fetch this run (0 = no limit).")
    ap.add_argument("--sleep", type=float, default=0.15, help="Sleep between calls.")
    ap.add_argument("--translated", type=str, default="y", choices=["y", "n"])
    ap.add_argument("--trans_lang", type=str, default="1", help="1=English")
    ap.add_argument("--progress-every", type=int, default=100)
    ap.add_argument("--max-calls", type=int, default=48000, help="Hard guard (keep under daily quota edge).")
    args = ap.parse_args()

    # Railway will provide env vars; local runs can use .env
    load_dotenv(override=False)

    nikl_key = (os.environ.get("NIKL_OPEN_API_KEY") or "").strip()
    if not nikl_key:
        print("ERROR: Missing NIKL_OPEN_API_KEY", file=sys.stderr)
        return 2

    s3 = s3_client()

    started = time.time()
    fetched = 0
    succeeded = 0
    failed = 0

    with db_conn() as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            total = db_count(cur, "SELECT COUNT(*) FROM nikl_target_codes;")
            done = db_count(cur, "SELECT COUNT(*) FROM nikl_snapshots WHERE endpoint='view' AND http_status=200;")
            print(f"[view] start total_target_codes={total} already_done_success={done}")

    # Stream target_codes from DB, skipping already-fetched
    # This avoids loading 33k into memory and is restart-safe.
    with db_conn() as conn:
        conn.autocommit = True
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:

            # Server-side cursor for streaming
            stream_name = f"tc_stream_{uuid.uuid4().hex}"
            stream = conn.cursor(name=stream_name)

            stream.itersize = 1000
            stream.execute("""
                SELECT t.target_code
                FROM nikl_target_codes t
                WHERE NOT EXISTS (
                    SELECT 1 FROM nikl_snapshots s
                    WHERE s.endpoint='view' AND s.target_code = t.target_code
                )
                ORDER BY t.target_code;
            """)

            for row in stream:
                tc = int(row[0])

                # hard limits
                if args.limit and succeeded >= args.limit:
                    break
                if succeeded >= args.max_calls:
                    print(f"[view] STOP: reached max-calls guard ({args.max_calls}).")
                    break

                snapshot_id = str(uuid.uuid4())
                fetched_at = utcstamp()
                url = build_view_url(nikl_key, tc, args.translated, args.trans_lang)

                try:
                    resp = requests.get(url, timeout=30, headers={"User-Agent": "HakMun-NIKL-Ingest/1.0"})
                    status = resp.status_code
                    xml_bytes = resp.content
                except Exception as e:
                    failed += 1
                    fetched += 1
                    print(f"[view ERROR] target_code={tc} request_err={e}", file=sys.stderr)
                    continue

                digest = sha256_bytes(xml_bytes)
                obj_key = object_key_for_view(tc, snapshot_id, fetched_at)

                try:
                    upload_xml(s3, obj_key, xml_bytes)
                except Exception as e:
                    failed += 1
                    fetched += 1
                    print(f"[view ERROR] target_code={tc} upload_err={e}", file=sys.stderr)
                    continue

                # Insert snapshot metadata into Postgres (no secrets)
                # If rerun, uniqueness on (endpoint,target_code) should prevent duplicates; we also pre-skip via NOT EXISTS.
                query_no_key = urlencode({
                    "method": "target_code",
                    "q": str(tc),
                    "translated": args.translated,
                    "trans_lang": args.trans_lang,
                }, safe=",:", encoding="utf-8")

                try:
                    cur.execute(
                        """
                        INSERT INTO nikl_snapshots (
                          snapshot_id, endpoint, target_code, query, object_key,
                          sha256, bytes, fetched_at, http_status
                        )
                        VALUES (%s,'view',%s,%s,%s,%s,%s,%s,to_timestamp(%s,'YYYYMMDD"T"HH24MISS"Z"'),%s)
                        ON CONFLICT DO NOTHING;
                        """,
                        (
                            snapshot_id,
                            tc,
                            query_no_key,
                            obj_key,
                            digest,
                            len(xml_bytes),
                            fetched_at,
                            status,
                        ),
                    )
                except Exception as e:
                    # XML is already in bucket; record failure but keep going.
                    failed += 1
                    fetched += 1
                    print(f"[view ERROR] target_code={tc} db_insert_err={e}", file=sys.stderr)
                    continue

                fetched += 1
                succeeded += 1

                if args.progress_every and (succeeded % args.progress_every == 0):
                    elapsed = time.time() - started
                    rate = succeeded / elapsed if elapsed > 0 else 0.0

                    # compute progress via DB counts (cheap-ish every 100)
                    cur.execute("SELECT COUNT(*) FROM nikl_snapshots WHERE endpoint='view';")
                    done_any = int(cur.fetchone()[0])

                    pct = (done_any / total * 100.0) if total else 0.0
                    print(f"[view] succeeded={succeeded} failed={failed} db_done={done_any}/{total} ({pct:.1f}%) rate={rate:.2f}/s last_target_code={tc}")

                time.sleep(args.sleep)

    elapsed = time.time() - started
    print(f"[view] DONE fetched={fetched} succeeded={succeeded} failed={failed} elapsed={elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())