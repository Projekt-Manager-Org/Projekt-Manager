#!/usr/bin/env bash
#
# Destructively overwrite the local dev Postgres database and MinIO bucket
# with whatever is currently on the VPS. Mirror of scripts/sync-dev-to-vps.sh
# for the opposite direction. See docs/ops/sync-vps-to-dev.md for the
# runbook, preconditions, and failure modes.
#
# Why this exists: reproducing a VPS-only bug locally, or resetting dev to
# a known-good deployed state without manually recreating users +
# re-uploading attachments.
#
# Topology note: prod's bucket is on Backblaze B2 since ddff944 (ADR-0022);
# the VPS-side dump helper reads B2 credentials from the running app
# container's env and pulls the bucket via mc. The local restore writes
# into the dev MinIO mirror (docker-compose.minio.yml).
#
# Usage:
#   scripts/sync-vps-to-dev.sh            # runs preflight only, then refuses
#   scripts/sync-vps-to-dev.sh --i-know   # proceeds after preflight
#
# Preconditions (enforced):
#   - ssh hetzner is reachable as the deploy user
#   - local docker compose stack has `db` and `storage` running (the
#     `storage` service is the dev MinIO mirror)
#   - the baseline migration hash matches between local and VPS
#   - the VPS DB has at least one user (would be pointless to pull an
#     empty/uninitialised DB over the top of local)
#
# What gets overwritten on LOCAL:
#   - Postgres database `projekt_manager` (all tables DROPped and recreated)
#   - Local MinIO bucket `projekt-manager` (objects absent on VPS are deleted)
#
# Stopping `npm run dev` first is optional. The script terminates any
# stray connections to projekt_manager before the DROP TABLE statements
# run; the dev app's pool absorbs the resulting client errors via the
# 'error' handler in src/server/db/connection.ts (attachPoolErrorHandler).
# Restart `npm run dev` afterwards if you want a clean log — the watch
# process keeps running, but transient query errors from the kill
# window will appear in its output before pool reconnect kicks in.

set -euo pipefail

SSH_TARGET="${SSH_TARGET:-hetzner}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Local MinIO bucket name — the VPS bucket name lives in the VPS app
# container's env (read by scripts/ops/sync-dump-vps.sh) since prod is
# Backblaze B2 with an operator-chosen bucket name (typically
# `prmng-object-storage`).
LOCAL_BUCKET="projekt-manager"
COMPOSE_PROJECT="projekt-manager"
# Must match docker/init-storage.sh. Used locally (for the restore mc run)
# and on the VPS (for the dump mc run). Tag drift would break both legs
# silently; kept literal to match the forward script.
MC_IMAGE="quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_TMP="/tmp/pm-rsync-$TS"
REMOTE_TMP="/tmp/pm-rsync-$TS"
REMOTE_SCRIPT="$REPO_DIR/scripts/ops/sync-dump-vps.sh"

I_KNOW=0
for arg in "$@"; do
  case "$arg" in
    --i-know) I_KNOW=1 ;;
    -h|--help)
      sed -n '3,34p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

cleanup() {
  rm -rf "$LOCAL_TMP" 2>/dev/null || true
  ssh -o BatchMode=yes "$SSH_TARGET" "rm -rf $REMOTE_TMP" 2>/dev/null || true
}
trap cleanup EXIT

echo "[1/7] SSH preflight ($SSH_TARGET)..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" true

echo "[2/7] Local stack check..."
# The dev `.env` sets COMPOSE_FILE so bare `docker compose` picks up the dev
# overlay triple automatically — no `-f` flags needed here.
cd "$REPO_DIR"
running_services=$(docker compose ps --services --status running 2>/dev/null || true)
for svc in db storage; do
  if ! echo "$running_services" | grep -qx "$svc"; then
    echo "ERROR: local service '$svc' is not running." >&2
    echo "  Start the dev stack:" >&2
    echo "    docker compose up -d" >&2
    exit 1
  fi
done

echo "[3/7] Schema parity check..."
local_hash=$(sha256sum "$REPO_DIR/src/server/db/migrations/0000_baseline.sql" | awk '{print $1}')
vps_hash=$(ssh "$SSH_TARGET" "sha256sum /opt/projekt-manager/src/server/db/migrations/0000_baseline.sql" | awk '{print $1}')
if [ "$local_hash" != "$vps_hash" ]; then
  cat <<ERR >&2
ERROR: schema hash mismatch — VPS and local are on incompatible schemas.
  local: $local_hash
  vps:   $vps_hash
Check out the matching commit locally (or deploy the matching commit to
the VPS) and retry.
ERR
  exit 1
fi

# Mirror of the forward script's "local DB non-empty" guard: refuse to
# pull from an empty/uninitialised VPS, which would silently wipe local
# state for nothing.
vps_users=$(ssh "$SSH_TARGET" \
  "docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc 'SELECT COUNT(*) FROM users;' 2>/dev/null || echo 0")
if [ -z "$vps_users" ] || [ "$vps_users" -lt 1 ]; then
  echo "ERROR: VPS users table is empty or DB is not initialised — nothing to pull." >&2
  exit 1
fi

if [ "$I_KNOW" != "1" ]; then
  cat <<MSG >&2
Preflight passed.

This command will DESTRUCTIVELY OVERWRITE LOCAL:
  - Postgres database: projekt_manager (all tables dropped and recreated)
  - MinIO bucket:      $LOCAL_BUCKET (objects absent on VPS are deleted)

Any local-only state will be lost. Stop 'npm run dev' first to release
DB connections, and restart it afterwards.

Re-run with --i-know to proceed.
MSG
  exit 1
fi

mkdir -p "$LOCAL_TMP"

echo "[4/7] Dumping VPS state..."
# Stream the remote dump script over SSH — same pattern as the forward
# script's restore helper. Env vars pass configuration. The script writes
# db.sql and bucket/ under $REMOTE_TMP on the VPS.
ssh "$SSH_TARGET" \
  "REMOTE_TMP='$REMOTE_TMP' MC_IMAGE='$MC_IMAGE' COMPOSE_PROJECT='$COMPOSE_PROJECT' bash -s" \
  < "$REMOTE_SCRIPT"

echo "[5/7] Transferring from VPS..."
rsync -az "$SSH_TARGET:$REMOTE_TMP/" "$LOCAL_TMP/"
echo "      db.sql: $(du -h "$LOCAL_TMP/db.sql" | awk '{print $1}')"
echo "      bucket: $(du -sh "$LOCAL_TMP/bucket" | awk '{print $1}') ($(find "$LOCAL_TMP/bucket" -type f | wc -l) files)"

echo "[6/7] Restoring locally..."
# Terminate any other backend connections to projekt_manager before the
# restore — a running `npm run dev` holds a connection pool that would
# otherwise race `pg_dump --clean`'s DROP TABLE statements. The exclusion
# of pg_backend_pid() spares our own admin connection.
#
# The dev app survives this kill because the pool in
# src/server/db/connection.ts installs the canonical 'error' listener
# (attachPoolErrorHandler) — without it the idle-client error from
# pg_terminate_backend would crash the tsx watch process and force a
# manual `npm run dev` restart on every sync. Same contract the prod
# side relies on in scripts/ops/sync-restore-vps.sh.
docker exec "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d postgres -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='projekt_manager' AND pid <> pg_backend_pid();" \
  >/dev/null

docker exec -i "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 --quiet \
  < "$LOCAL_TMP/db.sql" >/dev/null

# Mirror the VPS bucket dump into local MinIO. Credentials pulled from
# the running local storage container's env, same as forward path.
# `--md5` is required: dev MinIO mirrors the prod B2 bucket shape (ADR-0022
# / docker/init-storage.sh), which means default Compliance retention is
# active here too — bare PUTs are rejected with the same Object Lock
# integrity error B2 raises. Adding the flag to the local restore so the
# dev mirror behaves identically to the prod target.
LOCAL_MINIO_USER=$(docker exec "${COMPOSE_PROJECT}-storage-1" printenv MINIO_ROOT_USER)
LOCAL_MINIO_PASS=$(docker exec "${COMPOSE_PROJECT}-storage-1" printenv MINIO_ROOT_PASSWORD)
docker run --rm \
  --network "${COMPOSE_PROJECT}_default" \
  -v "$LOCAL_TMP/bucket:/data:ro" \
  -e MC_HOST_dst="http://${LOCAL_MINIO_USER}:${LOCAL_MINIO_PASS}@storage:9000" \
  "$MC_IMAGE" \
  mirror --overwrite --remove --md5 /data "dst/$LOCAL_BUCKET" >/dev/null

echo "[7/7] Done — local synced from VPS at $(date -u -Iseconds)"
