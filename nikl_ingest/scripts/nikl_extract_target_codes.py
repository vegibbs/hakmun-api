#!/usr/bin/env python3
from __future__ import annotations

import csv
import os
import re
import sys
import uuid
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple
from xml.etree import ElementTree as ET

import boto3
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv


@dataclass
class ManifestRow:
    snapshot_id: str
    endpoint: str
    lemma: str
    query: str
    object_key: str
    sha256: str
    bytes: int
    fetched_at: str
    http_status: int


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]  # .../hakmun-api


def _manifest_path(root: Path) -> Path:
    return root / "nikl_ingest" / "output" / "search_manifest.csv"


def _output_path(root: Path) -> Path:
    return root / "nikl_ingest" / "output" / "target_codes_unique.csv"


def _read_manifest(path: Path) -> List[ManifestRow]:
    if not path.exists():
        raise FileNotFoundError(f"Manifest not found: {path}")
    rows: List[ManifestRow] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        required = ["snapshot_id", "endpoint", "lemma", "query", "object_key", "sha256", "bytes", "fetched_at", "http_status"]
        missing = [c for c in required if c not in (r.fieldnames or [])]
        if missing:
            raise ValueError(f"Manifest missing columns: {missing}. Found: {r.fieldnames}")
        for row in r:
            rows.append(ManifestRow(
                snapshot_id=row["snapshot_id"].strip(),
                endpoint=row["endpoint"].strip(),
                lemma=row["lemma"].strip(),
                query=row["query"].strip(),
                object_key=row["object_key"].strip(),
                sha256=row["sha256"].strip(),
                bytes=int(row["bytes"]),
                fetched_at=row["fetched_at"].strip(),
                http_status=int(row["http_status"]),
            ))
    return rows


def _s3_client(endpoint: str, access_key: str, secret_key: str, region: str) -> boto3.client:
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=BotoConfig(signature_version="s3v4"),
    )


def _download_object(s3, bucket: str, object_key: str) -> bytes:
    resp = s3.get_object(Bucket=bucket, Key=object_key)
    return resp["Body"].read()


def _extract_target_codes_from_search_xml(xml_bytes: bytes) -> List[int]:
    """
    Parses NIKL /api/search XML and returns all <target_code> integers found under <item>.
    """
    # Some responses include leading BOM or whitespace; ElementTree handles bytes.
    root = ET.fromstring(xml_bytes)

    codes: List[int] = []
    # In search XML, items are direct children of <channel>.
    for item in root.findall("./item"):
        tc = item.findtext("target_code")
        if tc and tc.strip().isdigit():
            codes.append(int(tc.strip()))
    return codes


def main() -> int:
    root = _project_root()
    manifest_csv = _manifest_path(root)
    out_csv = _output_path(root)

    load_dotenv(override=False)

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

    rows = _read_manifest(manifest_csv)
    rows = [r for r in rows if r.endpoint == "search" and r.http_status == 200]

    s3 = _s3_client(endpoint=endpoint, access_key=access_key, secret_key=secret_key, region=region)

    # Deduped target_code registry
    seen: Dict[int, Tuple[str, str, str]] = {}  # target_code -> (snapshot_id, lemma, object_key)
    total_found = 0

    for r in rows:
        xml_bytes = _download_object(s3, bucket=bucket, object_key=r.object_key)
        codes = _extract_target_codes_from_search_xml(xml_bytes)
        total_found += len(codes)
        for tc in codes:
            if tc not in seen:
                seen[tc] = (r.snapshot_id, r.lemma, r.object_key)

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["target_code", "first_seen_snapshot_id", "first_seen_lemma", "first_seen_object_key"])
        for tc in sorted(seen.keys()):
            snap_id, lemma, obj_key = seen[tc]
            w.writerow([tc, snap_id, lemma, obj_key])

    print(f"Done.")
    print(f"- Search snapshots processed: {len(rows)}")
    print(f"- Total <target_code> occurrences found: {total_found}")
    print(f"- Unique target_codes: {len(seen)}")
    print(f"- Output: {out_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())