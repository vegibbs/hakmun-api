#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path

import boto3
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv


def main() -> int:
    # Load .env from project root or environment
    load_dotenv(override=False)

    bucket = (os.environ.get("OBJECT_STORAGE_BUCKET") or "").strip()
    endpoint = (os.environ.get("OBJECT_STORAGE_ENDPOINT") or "").strip()
    region = (os.environ.get("OBJECT_STORAGE_REGION") or "auto").strip()
    access_key = (os.environ.get("OBJECT_STORAGE_ACCESS_KEY_ID") or "").strip()
    secret_key = (os.environ.get("OBJECT_STORAGE_SECRET_ACCESS_KEY") or "").strip()

    missing = [k for k, v in [
        ("OBJECT_STORAGE_BUCKET", bucket),
        ("OBJECT_STORAGE_ENDPOINT", endpoint),
        ("OBJECT_STORAGE_ACCESS_KEY_ID", access_key),
        ("OBJECT_STORAGE_SECRET_ACCESS_KEY", secret_key),
    ] if not v]
    if missing:
        raise SystemExit(f"Missing env vars: {', '.join(missing)}")

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=BotoConfig(signature_version="s3v4"),
    )

    # Add/remove keys as needed
    keys = [
        "nikl/xml/view/target_code=14842/20260206T030423Z_c01eded6-26ea-4e9a-a2b6-b8ee9ede35c7.xml",
        "nikl/xml/view/target_code=14844/20260206T030424Z_13852f8c-9ebf-43fe-9365-4b494dd60e33.xml",
        "nikl/xml/view/target_code=14639/20260206T030419Z_7baeec61-0399-48cd-8c48-172d238562c1.xml",
        "nikl/xml/view/target_code=15047/20260206T030430Z_1cdcc307-68fb-4235-95a1-82a9a59f3358.xml",
        "nikl/xml/view/target_code=15065/20260206T030431Z_dbafc650-1a4b-475a-b645-0b110a907cfd.xml",
    ]

    project_root = Path(__file__).resolve().parents[2]  # .../hakmun-api
    out_dir = project_root / "nikl_ingest" / "nikl_xml_samples"

    for k in keys:
        out_path = out_dir / Path(k).name
        s3.download_file(bucket, k, str(out_path))
        print(f"Downloaded {k} -> {out_path} ({out_path.stat().st_size} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())