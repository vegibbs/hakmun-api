#!/usr/bin/env python3
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import boto3
import requests
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv

BASE_VIEW_URL = "https://krdict.korean.go.kr/api/view"

def utcstamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

def main() -> int:
    load_dotenv(override=False)

    nikl_key = (os.environ.get("NIKL_OPEN_API_KEY") or "").strip()
    if not nikl_key:
        raise SystemExit("Missing NIKL_OPEN_API_KEY")

    access_key = (os.environ.get("OBJECT_STORAGE_ACCESS_KEY_ID") or "").strip()
    secret_key = (os.environ.get("OBJECT_STORAGE_SECRET_ACCESS_KEY") or "").strip()
    bucket = (os.environ.get("OBJECT_STORAGE_BUCKET") or "").strip()
    endpoint = (os.environ.get("OBJECT_STORAGE_ENDPOINT") or "").strip()
    region = (os.environ.get("OBJECT_STORAGE_REGION") or "auto").strip()
    if not all([access_key, secret_key, bucket, endpoint]):
        raise SystemExit("Missing one or more OBJECT_STORAGE_* env vars")

    target_code = 27500
    snapshot_id = str(uuid.uuid4())
    fetched_at = utcstamp()

    # Fetch view XML (in-memory)
    params = {
        "key": nikl_key,
        "method": "target_code",
        "q": str(target_code),
        "translated": "y",
        "trans_lang": "1",
    }
    url = BASE_VIEW_URL + "?" + urlencode(params, safe=",:", encoding="utf-8")
    resp = requests.get(url, timeout=30, headers={"User-Agent": "HakMun-NIKL-Ingest/0.1"})
    resp.raise_for_status()
    xml_bytes = resp.content

    # Upload to private bucket
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=BotoConfig(signature_version="s3v4"),
    )
    object_key = f"nikl/xml/view/target_code={target_code}/{fetched_at}_{snapshot_id}.xml"
    s3.put_object(Bucket=bucket, Key=object_key, Body=xml_bytes, ContentType="application/xml; charset=utf-8")

    # Save local copy into project
    project_root = Path(__file__).resolve().parents[2]  # .../hakmun-api if placed under nikl_ingest/scripts/
    out_dir = project_root / "nikl_ingest" / "nikl_xml_samples"
    out_dir.mkdir(parents=True, exist_ok=True)
    local_path = out_dir / f"{fetched_at}_{snapshot_id}_target_code_{target_code}.xml"
    local_path.write_bytes(xml_bytes)

    print("Uploaded object_key:", object_key)
    print("Saved local:", local_path, f"({local_path.stat().st_size} bytes)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())