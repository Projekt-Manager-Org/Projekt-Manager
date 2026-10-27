#!/usr/bin/env python3
# Tested with boto3 1.34.46 (Ubuntu noble `python3-boto3`, the VPS
# package). Newer boto3 (>= 1.36) adds CRC32 checksums by default; the
# explicit ContentMD5 below satisfies Object Lock either way.
"""
Write the sync's bucket dump to the target bucket, each object with its
metadata rebuilt from the restored DB (#627).

Every object the app writes is self-describing (AC-439, data-model.md
§5.13): its S3 user metadata carries the wrapped envelope of its DEK, the
envelope version and, on an invoice PDF, the invoice number. The bucket
dump crosses SSH as a plain directory, which holds none of that — and the
source-side metadata would be useless anyway, its envelope is wrapped to
the source key. The restored row already carries the envelope re-wrapped
to the target's recipient (rewrap-dek-envelopes.sh), so this script PUTs
each file with metadata rebuilt from its row: the original under
`wrapped_dek`, the thumbnail under `wrapped_thumb_dek`, the invoice PDF
with the number of the invoice it renders.

An invoice PDF also gets its own Compliance lock of the target's
INVOICE_OBJECT_LOCK_DAYS from the write, as the app and the takeout
import put on it (architecture.md §11.14); the rest keep the bucket
default. The target's config decides: a few days on staging, years on a
real deployment, none on dev.

Mirror semantics (replaces `mc mirror --overwrite --remove`):
  * a file with a row → PUT as a new version;
  * a file without a row → not shipped, WARN (an orphan: no envelope to
    rebuild, and the pollution check bounds how many there are);
  * a target key absent from the PUT set → version-less DeleteObject, a
    delete marker; no version is destroyed (ADR-0022);
  * the deploy-probe namespace (`__probe/`, RESERVED_KEY_PREFIXES in
    src/server/storage/keyNamespaces.ts) → neither shipped nor removed;
    the target's deploys own it.

Each PUT returns its VersionId, so the script also emits the UPDATEs that
point `version_id` / `thumb_version_id` at the new versions (rows whose
column was set; a `pending` row has none).

Inputs (env):
  B2_ENDPOINT, B2_BUCKET, B2_KEY, B2_SECRET   bucket connection
  SOURCE_DIR (path)                           the bucket dump
  OBJECTS_TSV (path)                          restored rows, one per
      attachment, in the form
        <id>\\t<original_key>\\t<thumb_key>\\t<wrapped_dek>\\t<wrapped_thumb_dek>
        \\t<wrapped_dek_version>\\t<invoice_number>\\t<version_id>\\t<thumb_version_id>
      (absent values empty)
  KEY_PREFIX (optional)                       key namespace, as the app's
                                              STORAGE_KEY_PREFIX; empty
                                              on the VPS, set by tests
  INVOICE_OBJECT_LOCK_DAYS (optional)         the target app's value;
                                              empty or 0 writes no lock

Output: SQL UPDATE statements on stdout (caller pipes to psql);
        progress + summary counts on stderr. Exits non-zero before any
        write if a row lacks the envelope its object needs.
"""

import base64
import csv
import hashlib
import os
import sys
from datetime import datetime, timedelta, timezone

import boto3
from botocore.config import Config

RESERVED_KEY_PREFIXES = ("__probe/",)
CIPHERTEXT_CONTENT_TYPE = "application/octet-stream"
# Wire names, as OBJECT_METADATA_KEYS in src/server/storage/objectMetadata.ts.
META_WRAPPED_DEK = "wrapped-dek"
META_WRAPPED_DEK_VERSION = "wrapped-dek-version"
META_INVOICE_NUMBER = "invoice-number"


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.stderr.write(f"ERROR: {name} must be set\n")
        sys.exit(1)
    return v


def fail(message: str) -> None:
    sys.stderr.write(f"ERROR: {message}\n")
    sys.exit(1)


B2_ENDPOINT = env("B2_ENDPOINT")
B2_BUCKET = env("B2_BUCKET")
B2_KEY = env("B2_KEY")
B2_SECRET = env("B2_SECRET")
SOURCE_DIR = env("SOURCE_DIR")
TSV_PATH = env("OBJECTS_TSV")
KEY_PREFIX = os.environ.get("KEY_PREFIX", "")
# Parsed like the app's INVOICE_OBJECT_LOCK_DAYS (src/server/config/env.ts):
# empty means 0; an integer 0..36525, as a Compliance lock cannot be
# shortened once written.
_lock_days = os.environ.get("INVOICE_OBJECT_LOCK_DAYS", "") or "0"
if not _lock_days.isdigit() or int(_lock_days) > 36525:
    fail(f"INVOICE_OBJECT_LOCK_DAYS {_lock_days!r} is not an integer in 0..36525")
INVOICE_LOCK_DAYS = int(_lock_days)

# Path-style, like the app client (forcePathStyle).
s3 = boto3.client(
    "s3",
    endpoint_url=B2_ENDPOINT,
    aws_access_key_id=B2_KEY,
    aws_secret_access_key=B2_SECRET,
    region_name="us-east-1",
    config=Config(s3={"addressing_style": "path"}),
)


def sql_quote(s: str) -> str:
    """Single-quote escape for inline SQL literals (UUID ids, provider
    versionIds — bounded charsets; this is defence-in-depth)."""
    return s.replace("'", "''")


def is_reserved(key: str) -> bool:
    return key.startswith(RESERVED_KEY_PREFIXES)


def lock_params(target: dict) -> dict:
    """The invoice PDF's own Compliance lock, as objectLockParams in
    src/server/storage/client.ts; nothing for other objects or 0 days."""
    if META_INVOICE_NUMBER not in target["metadata"] or INVOICE_LOCK_DAYS <= 0:
        return {}
    return {
        "ObjectLockMode": "COMPLIANCE",
        "ObjectLockRetainUntilDate": datetime.now(timezone.utc) + timedelta(days=INVOICE_LOCK_DAYS),
    }


def read_targets() -> dict[str, dict]:
    """Map each object key to the row it belongs to and its metadata."""
    targets: dict[str, dict] = {}
    with open(TSV_PATH, newline="") as f:
        for row in csv.reader(f, delimiter="\t"):
            if len(row) != 9:
                fail(f"malformed TSV row: {row!r}")
            (att_id, original_key, thumb_key, wrapped_dek, wrapped_thumb_dek,
             dek_version, invoice_number, version_id, thumb_version_id) = row
            if not dek_version.isdigit():
                fail(f"attachment {att_id}: wrapped_dek_version {dek_version!r} is not an integer")
            objects = [(original_key, "version_id", wrapped_dek, invoice_number, version_id)]
            if thumb_key:
                objects.append((thumb_key, "thumb_version_id", wrapped_thumb_dek, "", thumb_version_id))
            for key, column, wrapped, number, current in objects:
                if not wrapped:
                    fail(f"attachment {att_id}: no envelope for {key!r}")
                if key in targets:
                    fail(f"key {key!r} belongs to two rows")
                metadata = {META_WRAPPED_DEK: wrapped, META_WRAPPED_DEK_VERSION: dek_version}
                if number:
                    metadata[META_INVOICE_NUMBER] = number
                targets[key] = {
                    "id": att_id,
                    "column": column,
                    "metadata": metadata,
                    "had_version": bool(current),
                }
    return targets


def source_keys() -> list[str]:
    keys = []
    for root, _dirs, files in os.walk(SOURCE_DIR):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), SOURCE_DIR)
            keys.append(rel.replace(os.sep, "/"))
    return sorted(keys)


def main() -> int:
    targets = read_targets()

    # PUT every dumped file that has a row.
    written: set[str] = set()
    updates: dict[str, dict[str, str]] = {}
    orphans = 0
    locked = 0
    for key in source_keys():
        if is_reserved(key):
            continue
        target = targets.get(key)
        if target is None:
            sys.stderr.write(f"  WARN: no attachment row for {key!r} — not shipped\n")
            orphans += 1
            continue
        with open(os.path.join(SOURCE_DIR, key), "rb") as f:
            body = f.read()
        lock = lock_params(target)
        res = s3.put_object(
            Bucket=B2_BUCKET,
            Key=KEY_PREFIX + key,
            Body=body,
            ContentType=CIPHERTEXT_CONTENT_TYPE,
            # Object Lock (bucket-default retention, ADR-0022) requires
            # Content-MD5 or x-amz-checksum-* on every PutObject.
            ContentMD5=base64.b64encode(hashlib.md5(body).digest()).decode(),
            Metadata=target["metadata"],
            **lock,
        )
        written.add(key)
        if lock:
            locked += 1
        version_id = res.get("VersionId")
        if target["had_version"]:
            if not version_id:
                fail(f"PUT {key!r} returned no VersionId — is the bucket versioned?")
            updates.setdefault(target["id"], {})[target["column"]] = version_id

    for key, target in targets.items():
        if target["had_version"] and key not in written:
            # A ready row whose bytes the dump lacks; the storage layer's
            # HEAD probe surfaces it as 410 GONE at runtime.
            sys.stderr.write(f"  WARN: no file in the dump for {key!r} — row left unchanged\n")

    # Remove target keys the sync did not write: delete markers only.
    removed = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=B2_BUCKET, Prefix=KEY_PREFIX):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"][len(KEY_PREFIX):]
            if key in written or is_reserved(key):
                continue
            s3.delete_object(Bucket=B2_BUCKET, Key=obj["Key"])
            removed += 1

    for att_id, columns in updates.items():
        sets = ", ".join(
            f"{column}='{sql_quote(columns[column])}'"
            for column in ("version_id", "thumb_version_id")
            if column in columns
        )
        print(f"UPDATE public.attachments SET {sets} WHERE id='{sql_quote(att_id)}';")

    sys.stderr.write(
        f"  objects: written={len(written)} removed={removed} orphans={orphans} "
        f"locked={locked} ({INVOICE_LOCK_DAYS}d) rows updated={len(updates)}\n",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
