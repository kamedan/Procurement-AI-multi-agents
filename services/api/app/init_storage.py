from __future__ import annotations

import os
import sys
import time

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError


def init_private_bucket() -> None:
    endpoint = os.environ.get("OBJECTSTORE_ENDPOINT", "http://objectstore:9000")
    access_key = os.environ.get("OBJECTSTORE_ROOT_USER", "")
    secret_key = os.environ.get("OBJECTSTORE_ROOT_PASSWORD", "")
    bucket = os.environ.get("OBJECTSTORE_BUCKET", "procureai-private-documents")
    region = os.environ.get("OBJECTSTORE_REGION", "us-east-1")

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )

    last_err: Exception | None = None
    for attempt in range(1, 21):
        try:
            try:
                client.head_bucket(Bucket=bucket)
                print(f"Private bucket '{bucket}' already exists.", flush=True)
                return
            except ClientError as exc:
                code = str(exc.response.get("Error", {}).get("Code", ""))
                if code in ("404", "NoSuchBucket", "NotFound"):
                    client.create_bucket(Bucket=bucket)
                    print(f"Created private bucket '{bucket}'.", flush=True)
                    return
                raise
        except Exception as exc:
            last_err = exc
            print(f"Waiting for objectstore (attempt {attempt}/20): {exc}", flush=True)
            time.sleep(1.5)

    raise RuntimeError(f"Failed to initialize bucket '{bucket}': {last_err}")


if __name__ == "__main__":
    try:
        init_private_bucket()
    except Exception as exc:
        print(f"Object store initialization failed: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
