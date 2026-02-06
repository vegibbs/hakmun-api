#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import os
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Set
from urllib.parse import urlencode, quote

import boto3
import requests
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv

BASE_SEARCH_URL = "https://krdict.korean.go.kr/api/search"


@dataclass(frozen=True)
class SearchParams:
    method: str         # exact | include | start | end
    part: str           # word | ip | dfn | exam
    num: int            # 10..100
    start: int          # 1..1000
    translated: str     # y|n
    trans_lang: str     # 0..11


def _utcstamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _read_seed_lemmas(csv_path: Path) -> list[str]:
    if not csv_path.exists():
        raise FileNotFoundError(f"Seed CSV not found: {csv_path}")
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        headers = [h.strip().lower() for h in (reader.fieldnames or [])]
        if "lemma" not in headers:
            raise ValueError(f'CSV must have a header named "lemma". Found headers: {reader.fieldnames}')
        lemmas: list[str] = []
        for row in reader:
            lemma = (row.get("lemma") or "").strip()
            if lemma:
                lemmas.append(lemma)
    return lemmas


def _manifest_path(project_root: Path) -> Path:
    out_dir = project_root / "nikl_ingest" / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / "search_manifest.csv"


def _load_manifest_seen(manifest_csv: Path) -> Set[str]:
    """
    Returns a set of lemmas already fetched (so you can resume safely).
    """
    if not manifest_csv.exists():
        return set()
    seen: Set[str] = set()
    with manifest_csv.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            lemma = (row.get("lemma") or "").strip()
            if lemma:
                seen.add(lemma)
    return seen


def _ensure_manifest_header(manifest_csv: Path) -> None:
    """
    SECURITY: This manifest intentionally does NOT store the full request URL,
    to avoid leaking NIKL keys (or other secrets) into files/logs.
    """
    if manifest_csv.exists():
        return
    manifest_csv.write_text(
        "snapshot_id,endpoint,lemma,query,object_key,sha256,bytes,fetched_at,http_status\n",
        encoding="utf-8",
    )


def _build_search_url(api_key: str, lemma: str, p: SearchParams) -> str:
    # Used only for the request; never written to manifest.
    params = {
        "key": api_key,
        "q": lemma,
        "part": p.part,
        "method": p.method,
        "num": str(p.num),
        "start": str(p.start),
        "translated": p.translated,
        "trans_lang": p.trans_lang,
    }
    return BASE_SEARCH_URL + "?" + urlencode(params, safe=",:", encoding="utf-8")


def _build_search_query_for_manifest(lemma: str, p: SearchParams) -> str:
    # No key=... in here.
    params = {
        "q": lemma,
        "part": p.part,
        "method": p.method,
        "num": str(p.num),
        "start": str(p.start),
        "translated": p.translated,
        "trans_lang": p.trans_lang,
    }
    return urlencode(params, safe=",:", encoding="utf-8")


def _s3_client(endpoint: str, access_key: str, secret_key: str, region: str) -> boto3.client:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=BotoConfig(signature_version="s3v4"),
    )


def _upload_xml(s3, bucket: str, object_key: str, xml_bytes: bytes) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=object_key,
        Body=xml_bytes,
        ContentType="application/xml; charset=utf-8",
    )


def _object_key_for_search(lemma: str, p: SearchParams, snapshot_id: str, fetched_at: str) -> str:
    lemma_safe = quote(lemma, safe="")
    return (
        f"nikl/xml/search/"
        f"lemma={lemma_safe}/"
        f"method={p.method}/part={p.part}/"
        f"start={p.start}/num={p.num}/"
        f"{fetched_at}_{snapshot_id}.xml"
    )


def _append_manifest_row(
    manifest_csv: Path,
    snapshot_id: str,
    lemma: str,
    query: str,
    object_key: str,
    sha256: str,
    nbytes: int,
    fetched_at: str,
    http_status: int,
) -> None:
    with manifest_csv.open("a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            snapshot_id,
            "search",
            lemma,
            query,
            object_key,
            sha256,
            nbytes,
            fetched_at,
            http_status,
        ])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch NIKL /api/search XML for lemmas, upload to Railway bucket, write a SAFE manifest (no API keys)."
    )
    parser.add_argument("--limit", type=int, default=10, help="Number of lemmas to process (default: 10).")
    parser.add_argument("--method", type=str, default="exact", choices=["exact", "include", "start", "end"])
    parser.add_argument("--part", type=str, default="word", choices=["word", "ip", "dfn", "exam"])
    parser.add_argument("--num", type=int, default=100)
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--translated", type=str, default="y", choices=["y", "n"])
    parser.add_argument("--trans_lang", type=str, default="1", help="Translation language: 1=English (default).")
    parser.add_argument("--sleep", type=float, default=0.15, help="Sleep between calls (seconds).")
    parser.add_argument("--no-resume", action="store_true", help="If set, do not skip lemmas already in manifest.")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[2]  # .../hakmun-api
    seed_csv = project_root / "nikl_ingest" / "wordlists" / "seed_6757.csv"
    manifest_csv = _manifest_path(project_root)

    # Load env (expects a .env in hakmun-api root or vars exported in shell/PyCharm)
    load_dotenv(override=False)

    api_key = (os.environ.get("NIKL_OPEN_API_KEY") or "").strip()
    if not api_key:
        print("ERROR: NIKL_OPEN_API_KEY is not set in environment.", file=sys.stderr)
        return 2

    access_key = (os.environ.get("OBJECT_STORAGE_ACCESS_KEY_ID") or "").strip()
    secret_key = (os.environ.get("OBJECT_STORAGE_SECRET_ACCESS_KEY") or "").strip()
    bucket = (os.environ.get("OBJECT_STORAGE_BUCKET") or "").strip()
    endpoint = (os.environ.get("OBJECT_STORAGE_ENDPOINT") or "").strip()
    region = (os.environ.get("OBJECT_STORAGE_REGION") or "auto").strip()

    missing = [k for k, v in [
        ("OBJECT_STORAGE_ACCESS_KEY_ID", access_key),
        ("OBJECT_STORAGE_SECRET_ACCESS_KEY", secret_key),
        ("OBJECT_STORAGE_BUCKET", bucket),
        ("OBJECT_STORAGE_ENDPOINT", endpoint),
    ] if not v]
    if missing:
        print(f"ERROR: Missing object storage env vars: {', '.join(missing)}", file=sys.stderr)
        return 2

    lemmas = _read_seed_lemmas(seed_csv)

    if args.limit <= 0:
        print("Nothing to do (--limit <= 0).")
        return 0

    p = SearchParams(
        method=args.method,
        part=args.part,
        num=args.num,
        start=args.start,
        translated=args.translated,
        trans_lang=str(args.trans_lang),
    )

    _ensure_manifest_header(manifest_csv)
    seen = set() if args.no_resume else _load_manifest_seen(manifest_csv)

    s3 = _s3_client(endpoint=endpoint, access_key=access_key, secret_key=secret_key, region=region)

    processed = 0
    for lemma in lemmas:
        if processed >= args.limit:
            break
        if lemma in seen:
            continue

        snapshot_id = str(uuid.uuid4())
        fetched_at = _utcstamp()

        url = _build_search_url(api_key=api_key, lemma=lemma, p=p)

        try:
            resp = requests.get(url, timeout=30, headers={"User-Agent": "HakMun-NIKL-Ingest/0.1"})
            status = resp.status_code
            xml_bytes = resp.content
        except Exception as e:
            print(f"FETCH ERROR lemma={lemma}: {e}", file=sys.stderr)
            continue

        digest = _sha256_bytes(xml_bytes)
        object_key = _object_key_for_search(lemma=lemma, p=p, snapshot_id=snapshot_id, fetched_at=fetched_at)

        try:
            _upload_xml(s3=s3, bucket=bucket, object_key=object_key, xml_bytes=xml_bytes)
        except Exception as e:
            print(f"UPLOAD ERROR lemma={lemma} object_key={object_key}: {e}", file=sys.stderr)
            continue

        query_for_manifest = _build_search_query_for_manifest(lemma=lemma, p=p)

        _append_manifest_row(
            manifest_csv=manifest_csv,
            snapshot_id=snapshot_id,
            lemma=lemma,
            query=query_for_manifest,
            object_key=object_key,
            sha256=digest,
            nbytes=len(xml_bytes),
            fetched_at=fetched_at,
            http_status=status,
        )

        processed += 1
        time.sleep(args.sleep)

    print(f"Done. Appended {processed} rows to {manifest_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())