#!/usr/bin/env bash
#
# Prune local MinIO bucket objects that are not referenced by any row in the
# `attachments` table. Used to clear E2E / abandoned-upload debris before
# scripts/sync-dev-to-vps.sh, without taking down keys that the app still
# considers live (status=ready / pending) or recoverable from the trash
# (status=hidden — the row carries a version_id pointing at a PUT version
# under the hide-induced delete marker, which the un-hide flow needs).
#
# Why this exists: the previous workflow recommended a recursive
# `mc rm --force local/projekt-manager/`, which deletes referenced keys too
# and leaves the gallery + Papierkorb broken until someone manually peels
# the delete markers off the affected version chains.
#
# Safety:
#   - Refuses to run unless the storage container's image is
#     quay.io/minio/minio, so it cannot point at B2 by accident.
#   - Refuses unless the compose project is `projekt-manager`.
#   - Default mode is a dry-run — no deletions happen without --apply.
#   - Deletes only at the current-version level (creates delete markers).
#     Object Lock + lifecycle reap historical versions in their own time.
#
# Usage:
#   scripts/clean-bucket-orphans.sh           # dry-run: print orphans + counts
#   scripts/clean-bucket-orphans.sh --apply   # delete the listed orphans

set -euo pipefail

COMPOSE_PROJECT="projekt-manager"
LOCAL_BUCKET="projekt-manager"
DB_CONTAINER="${COMPOSE_PROJECT}-db-1"
STORAGE_CONTAINER="${COMPOSE_PROJECT}-storage-1"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# Guard 1: storage container must be MinIO. The B2 path uses `mc` against an
# alias pointing at api.backblazeb2.com; if someone runs this from inside an
# environment whose `storage` service is a B2-pointing mc shim, we'd issue
# real delete calls against B2. Asserting the local image prevents that.
storage_image=$(docker inspect --format '{{.Config.Image}}' "$STORAGE_CONTAINER" 2>/dev/null || true)
case "$storage_image" in
  quay.io/minio/minio:*) ;;
  *)
    echo "ERROR: $STORAGE_CONTAINER image is '$storage_image', expected quay.io/minio/minio:*." >&2
    echo "  This script must only run against the local dev MinIO mirror." >&2
    exit 1
    ;;
esac

# Guard 2: refuse if the DB container is missing (script can't compute the
# preserved set without it, and a partial cleanup is worse than none).
if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: $DB_CONTAINER not running. Start the dev stack and retry." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "[1/3] Collecting DB-referenced keys..."
# Include rows of every status — `hidden` rows still hold a legitimate PUT
# version below the delete marker that the un-hide flow promotes back. The
# DB column is NOT NULL on original_key and NULLABLE on thumb_key, so the
# UNION skips NULL thumb_keys.
docker exec "$DB_CONTAINER" \
  psql -U pm -d projekt_manager -tAc \
  "SELECT original_key FROM attachments
   UNION
   SELECT thumb_key FROM attachments WHERE thumb_key IS NOT NULL" \
  | sort -u > "$tmp/db_keys"
db_count=$(wc -l < "$tmp/db_keys")

echo "[2/3] Listing current-version bucket keys..."
docker exec "$STORAGE_CONTAINER" sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
  mc ls --recursive --json "local/'"$LOCAL_BUCKET"'"
' | awk -F'"' '/"key":/ { for(i=1;i<=NF;i++) if($i=="key"){print $(i+2); break} }' \
  | sort -u > "$tmp/bucket_keys"
bucket_count=$(wc -l < "$tmp/bucket_keys")

# Orphans = bucket keys not in the DB-referenced set.
comm -23 "$tmp/bucket_keys" "$tmp/db_keys" > "$tmp/orphans"
orphan_count=$(wc -l < "$tmp/orphans")

echo
echo "Bucket keys:        $bucket_count"
echo "DB-referenced keys: $db_count"
echo "Orphans to remove:  $orphan_count"
echo

if [ "$orphan_count" = "0" ]; then
  echo "Nothing to do."
  exit 0
fi

if [ "$APPLY" != "1" ]; then
  echo "Dry-run — no deletions. Orphan keys:"
  sed 's/^/  /' "$tmp/orphans"
  echo
  echo "Re-run with --apply to delete."
  exit 0
fi

echo "[3/3] Deleting $orphan_count orphan keys..."
# Stream the orphan list into the storage container and delete one-by-one.
# `mc rm` without --versions creates a delete marker (versioning + Object
# Lock keep the underlying versions for R+L days, identical semantics to
# what the app's own delete flow uses).
docker exec -i "$STORAGE_CONTAINER" sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
  while IFS= read -r key; do
    mc rm "local/'"$LOCAL_BUCKET"'/$key"
  done
' < "$tmp/orphans"

echo "Done."
