#!/usr/bin/env bash
#
# VPS side of scripts/sync-vps-to-dev.sh. Not intended to be run directly.
# The orchestrator streams this script over SSH (`ssh hetzner bash -s`) with
# these env vars set. Dumps the VPS DB and bucket into $REMOTE_TMP so the
# orchestrator can rsync them down.
#
# Env contract:
#   REMOTE_TMP       directory on VPS to write dumps into
#   MC_IMAGE         mc image ref, passed by scripts/sync-vps-to-dev.sh
#   COMPOSE_PROJECT  compose project name (projekt-manager) — used to find
#                    the running containers. The bucket itself lives at
#                    Backblaze B2 since the ddff944 topology switch (ADR-0022);
#                    this script reads B2 credentials, endpoint, and bucket
#                    name from the running app container's env.
#
# This script does NOT stop the app — pg_dump holds a consistent snapshot in
# a single transaction by default, and B2 is versioned + content-addressed so
# a concurrent write at most produces a fresh version the next sync will pick
# up. No trap needed because nothing is being stopped or mutated.

set -euo pipefail

: "${REMOTE_TMP:?REMOTE_TMP must be set}"
: "${MC_IMAGE:?MC_IMAGE must be set}"
: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set}"

DB_CONTAINER="${COMPOSE_PROJECT}-db-1"
APP_CONTAINER="${COMPOSE_PROJECT}-app-1"

mkdir -p "$REMOTE_TMP/bucket"

# Dump DB with the same flags the orchestrator uses on the local side.
# pg_dump defaults to a single transaction (serializable snapshot) so no lock
# is needed.
docker exec "$DB_CONTAINER" \
  pg_dump -U pm -d projekt_manager \
  --clean --if-exists --no-owner --no-acl \
  > "$REMOTE_TMP/db.sql"

# Read B2 credentials, endpoint, and bucket name from the running app
# container's env. The container is the authoritative source for the live
# config (compose interpolates from .env + secrets.env.age into its
# `environment:` block at startup) — avoids re-parsing those files here, and
# avoids prompting for the secrets.env.age passphrase. ADR-0022 and
# docs/ops/object-storage-provisioning.md cover the env layout.
B2_ENDPOINT=$(docker exec "$APP_CONTAINER" printenv STORAGE_ENDPOINT)
B2_BUCKET=$(docker exec "$APP_CONTAINER" printenv STORAGE_BUCKET)
B2_KEY=$(docker exec "$APP_CONTAINER" printenv STORAGE_ACCESS_KEY)
B2_SECRET=$(docker exec "$APP_CONTAINER" printenv STORAGE_SECRET_KEY)

# Mirror the bucket into a filesystem directory. `mc alias set` avoids the
# URL-encoding pitfalls of `MC_HOST_*=` when an applicationKey contains `+`
# or `/` (B2 keys are base64-shaped). `--overwrite --remove` keeps the dump
# directory an exact mirror of the bucket across repeated runs, matching the
# forward path's semantics. On B2 with versioning + Compliance Object Lock,
# `--remove` issues version-less DeleteObject which creates delete markers
# rather than destroying versions — safe under ADR-0022's capability split
# (the app key has writeFiles but not deleteFiles).
docker run --rm \
  -v "$REMOTE_TMP/bucket:/data" \
  -e B2_ENDPOINT="$B2_ENDPOINT" \
  -e B2_KEY="$B2_KEY" \
  -e B2_SECRET="$B2_SECRET" \
  -e B2_BUCKET="$B2_BUCKET" \
  --entrypoint sh \
  "$MC_IMAGE" \
  -c '
    mc alias set b2 "$B2_ENDPOINT" "$B2_KEY" "$B2_SECRET" --api S3v4 >/dev/null
    mc mirror --overwrite --remove "b2/$B2_BUCKET" /data
  ' >/dev/null
