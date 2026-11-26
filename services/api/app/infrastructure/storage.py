from __future__ import annotations

import hashlib
import re

import boto3
from botocore.client import Config

from app.config import settings

_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_s3_singleton = None


def _s3_client():
    global _s3_singleton
    if _s3_singleton is None:
        _s3_singleton = boto3.client(
            "s3",
            endpoint_url=settings.objectstore_endpoint,
            aws_access_key_id=settings.objectstore_root_user,
            aws_secret_access_key=settings.objectstore_root_password,
            region_name=settings.objectstore_region,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                max_pool_connections=16,
            ),
        )
    return _s3_singleton


def sanitize_filename(name: str) -> str:
    base = name.split("/")[-1].split("\\")[-1]
    cleaned = _SAFE_FILENAME_RE.sub("_", base).strip("._")
    return (cleaned or "document.bin")[:120]


def put_private_bytes(
    *,
    tenant_id: str,
    category: str,
    resource_id: str,
    filename: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> tuple[str, str]:
    safe_name = sanitize_filename(filename)
    sha256_hex = "sha256:" + hashlib.sha256(data).hexdigest()
    object_key = f"{tenant_id}/{category}/{resource_id}/{safe_name}"
    client = _s3_client()
    client.put_object(
        Bucket=settings.objectstore_bucket,
        Key=object_key,
        Body=data,
        ContentType=content_type,
        Metadata={"tenant_id": tenant_id, "sha256": sha256_hex},
    )
    return object_key, sha256_hex


def get_private_bytes(*, tenant_id: str, object_key: str) -> bytes:
    if not object_key.startswith(f"{tenant_id}/"):
        raise PermissionError("Cross-tenant object storage access denied")
    client = _s3_client()
    obj = client.get_object(Bucket=settings.objectstore_bucket, Key=object_key)
    return obj["Body"].read()
